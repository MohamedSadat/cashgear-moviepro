import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FLICKS_PER_SECOND,
  covers,
  createAiClient,
  readMatteIndex,
  type EngineClient,
  defaultSceneSettings,
  defaultSilenceSettings,
  isCancelled,
  type AiClient,
  type CacheStore,
  type Clip,
  type Command,
  type MediaSourceRef,
  type SceneAnalysis,
  type SilenceSettings,
  type SoundAnalysis,
} from '@cgv/engine-client';
import type { ProjectState } from '../project/useProject';
import { sourceAt } from '../speed/timing';
import { readScenes, readSound, writeScenes, writeSound } from './cache';
import { soundClipOf, timelineAt, timelineRanges } from './timing';

/** A running AI job, as the inspector lists it. */
export interface AiJob {
  id: number;
  label: string;
  /** 0 to 1, or null before the first report. */
  progress: number | null;
  cancel(): void;
}

export interface AiToolsState {
  jobs: AiJob[];
  silenceSettings: SilenceSettings;
  setSilenceSettings(settings: SilenceSettings): void;
  /** Cuts the silences out of clip `id`'s sound, and its picture with it, as one undo step. */
  removeSilences(id: number): Promise<void>;
  /** Marks the beats of clip `id`'s sound, for cuts to snap to. */
  detectBeats(id: number): Promise<void>;
  clearBeats(id: number): Promise<void>;
  /** Splits clip `id` (and its partners) where its picture cuts to a new scene, as one undo step. */
  splitScenes(id: number): Promise<void>;
  /**
   * Turns background removal on or off for clip `id`; on, the mattes of the
   * media it shows are worked out first where they are missing, as a job.
   */
  setRemoveBackground(id: number, on: boolean): Promise<void>;
  /** Clips whose background goes but whose mattes are not all made: exports wait for them. */
  unfinishedCutouts(): Promise<Clip[]>;
  /** Works out the mattes clip `id` still needs, as a job. */
  makeMattes(id: number): Promise<void>;
  /** The AI worker, started on first use. */
  client(): AiClient;
  /** Runs `work` as a job the user sees and can cancel; null when cancelled. */
  run<T>(
    label: string,
    work: (signal: AbortSignal, progress: (fraction: number) => void) => Promise<T>,
  ): Promise<T | null>;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** What one kind of analysis needs: its cache, its job and what it reads. */
interface Kind<T> {
  read(cache: CacheStore, media: string): Promise<T | null>;
  write(cache: CacheStore, media: string, analysis: T): Promise<void>;
  run(
    ai: AiClient,
    source: MediaSourceRef,
    progress: (fraction: number) => void,
    signal: AbortSignal,
  ): Promise<T | null>;
  /** The job's name in the inspector. */
  label(name: string): string;
  /** Which stream it decodes. */
  stream: 'audio' | 'video';
}

const sound: Kind<SoundAnalysis> = {
  read: readSound,
  write: writeSound,
  run: (ai, source, progress, signal) => ai.analyzeSound(source, progress, signal),
  label: (name) => `Listening to ${name}`,
  stream: 'audio',
};

const scenes: Kind<SceneAnalysis> = {
  read: readScenes,
  write: writeScenes,
  run: (ai, source, progress, signal) => ai.analyzeScenes(source, progress, signal),
  label: (name) => `Looking for scenes in ${name}`,
  stream: 'video',
};

/**
 * The AI tools: jobs in the AI worker, each one cancellable, whose results are
 * cached per media file and turned into ordinary undoable commands.
 */
export function useAiTools(
  project: ProjectState,
  cache: CacheStore,
  options: { modelBase?: string | null; engine?: EngineClient | null } = {},
): AiToolsState {
  const client = useRef<AiClient | null>(null);
  const [jobs, setJobs] = useState<AiJob[]>([]);
  const [silenceSettings, setSilenceSettings] = useState(defaultSilenceSettings);
  // Analyses asked for in this session, by kind and media.
  const known = useRef(new Map<string, Promise<unknown>>());
  const nextJob = useRef(1);
  const state = useRef({ project, silenceSettings });
  state.current = { project, silenceSettings };

  useEffect(
    () => () => {
      client.current?.dispose();
      client.current = null;
    },
    [],
  );
  const modelBase = options.modelBase ?? null;
  const ai = useCallback(() => {
    if (!client.current) {
      client.current = createAiClient();
      // Tests point model downloads at local copies.
      if (modelBase) void client.current.setModelBase(modelBase);
    }
    return client.current;
  }, [modelBase]);

  /** Runs `work` as a job the user sees and can cancel; null when cancelled. */
  const job = useCallback(
    async <T>(
      label: string,
      work: (signal: AbortSignal, progress: (fraction: number) => void) => Promise<T>,
    ): Promise<T | null> => {
      const id = nextJob.current++;
      const controller = new AbortController();
      const cancel = () => controller.abort();
      setJobs((list) => [...list, { id, label, progress: null, cancel }]);
      const progress = (fraction: number) =>
        setJobs((list) => list.map((j) => (j.id === id ? { ...j, progress: fraction } : j)));
      try {
        return await work(controller.signal, progress);
      } catch (error) {
        if (isCancelled(error)) return null;
        throw error;
      } finally {
        setJobs((list) => list.filter((j) => j.id !== id));
      }
    },
    [],
  );

  /** A medium's analysis of `kind`: from this session, the cache, or a new job. */
  const analysisOf = useCallback(
    <T>(kind: Kind<T>, media: string, name: string): Promise<T | null> => {
      const id = `${kind.stream}:${media}`;
      const remembered = known.current.get(id) as Promise<T | null> | undefined;
      if (remembered) return remembered;
      const library = state.current.project.library;
      const item = library.items.find((entry) => entry.id === media);
      const decodable = kind.stream === 'audio' ? item?.audio?.decodable : item?.video?.decodable;
      const source = decodable ? library.source(media) : library.proxy(media);
      const found = (async () => {
        const cached = await kind.read(cache, media);
        if (cached) return cached;
        if (!source) throw new Error(`${name} can't be decoded here.`);
        const analysis = await job(kind.label(name), (signal, progress) =>
          kind.run(ai(), source, progress, signal),
        );
        if (analysis) await kind.write(cache, media, analysis);
        return analysis;
      })();
      known.current.set(id, found);
      // A cancelled or failed analysis can be asked for again.
      void found.then(
        (analysis) => analysis || known.current.delete(id),
        () => known.current.delete(id),
      );
      return found;
    },
    [cache, job],
  );

  /**
   * Clip `id` as the tool works on it (its sound clip for sound tools) and its
   * media's analysis; null after telling the user why not.
   */
  const prepare = useCallback(
    async <T>(id: number, kind: Kind<T>) => {
      const { project } = state.current;
      const current = project.latest()?.project;
      if (!current) return null;
      const clip =
        kind.stream === 'audio'
          ? soundClipOf(current, id)
          : current.tracks.flatMap((t) => t.clips).find((c) => c.id === id && c.video);
      if (!clip || clip.kind === 'adjustment' || clip.kind === 'title') {
        project.notice(
          `This clip has no ${kind.stream === 'audio' ? 'sound' : 'picture'} to analyse.`,
        );
        return null;
      }
      const name = current.media.find((media) => media.id === clip.media)?.name ?? 'the clip';
      try {
        const analysis = await analysisOf(kind, clip.media, name);
        return analysis ? { clip: clip.id, name, analysis } : null;
      } catch (error) {
        project.notice(message(error));
        return null;
      }
    },
    [analysisOf],
  );

  /** Clip `id` as it is now: the project may have changed while a job ran. */
  const latest = (id: number): Clip | null =>
    state.current.project
      .latest()
      ?.project.tracks.flatMap((t) => t.clips)
      .find((c) => c.id === id) ?? null;

  const removeSilences = useCallback(
    async (id: number) => {
      const ready = await prepare(id, sound);
      if (!ready) return;
      const { project, silenceSettings } = state.current;
      const ranges = await ai().silences(ready.analysis, silenceSettings);
      const clip = latest(ready.clip);
      if (!clip) return;
      const cuts = timelineRanges(clip, ranges);
      if (!cuts.length)
        return project.notice(`No silences long enough to cut were found in ${ready.name}.`);
      const command: Command = { type: 'removeRanges', clip: clip.id, ranges: cuts };
      await project.executeGroup('Remove silences', [command]);
    },
    [prepare],
  );

  const detectBeats = useCallback(
    async (id: number) => {
      const ready = await prepare(id, sound);
      if (!ready) return;
      const { project } = state.current;
      const { tempo, beats } = await ai().beats(ready.analysis);
      if (tempo === null || !beats.length)
        return project.notice(`No steady beat was found in ${ready.name}.`);
      const times = beats.map((time) => Math.max(0, Math.round(time * FLICKS_PER_SECOND)));
      await project.executeGroup('Detect beats', [
        { type: 'setBeats', clip: ready.clip, beats: times },
      ]);
    },
    [prepare],
  );

  const clearBeats = useCallback(async (id: number) => {
    const { project } = state.current;
    const current = project.latest()?.project;
    const clip = current ? soundClipOf(current, id) : null;
    if (clip?.beats?.length)
      await project.executeGroup('Clear beats', [{ type: 'setBeats', clip: clip.id, beats: [] }]);
  }, []);

  const splitScenes = useCallback(
    async (id: number) => {
      const ready = await prepare(id, scenes);
      if (!ready) return;
      const { project } = state.current;
      const cuts = await ai().sceneCuts(ready.analysis, defaultSceneSettings);
      const clip = latest(ready.clip);
      const settings = project.latest()?.project.settings;
      if (!clip || !settings) return;
      const frame = (FLICKS_PER_SECOND * settings.frameRate.den) / settings.frameRate.num;
      const end = clip.start + clip.duration;
      const times = cuts
        .map((time) => timelineAt(clip, Math.round(time * FLICKS_PER_SECOND)))
        // On whole frames, as the model splits, and at least a frame inside the clip.
        .map((time) => (time === null ? null : Math.round(time / frame) * frame))
        .filter((time): time is number => time !== null && time > clip.start && time < end)
        // Latest first: the clip keeps its id as the part before each split.
        .sort((a, b) => b - a);
      if (!times.length)
        return project.notice(`No scene changes were found in this part of ${ready.name}.`);
      await project.executeGroup(
        'Split at scene changes',
        times.map((at): Command => ({ type: 'split', at, clips: [clip.id] })),
      );
    },
    [prepare],
  );

  const engine = options.engine ?? null;

  /** The source seconds a clip shows. */
  const shownRange = (clip: Clip): [number, number] => {
    const ends = [sourceAt(clip, 0), sourceAt(clip, clip.duration)];
    return [Math.min(...ends) / FLICKS_PER_SECOND, Math.max(...ends) / FLICKS_PER_SECOND];
  };

  /** Works out the mattes clip `clip` needs, unless they are made already. */
  const cutOut = useCallback(
    async (clip: Clip) => {
      const { project } = state.current;
      const [start, end] = shownRange(clip);
      if (covers(await readMatteIndex(clip.media, 'selfie'), start, end)) return;
      const library = project.library;
      const item = library.items.find((entry) => entry.id === clip.media);
      const source = item?.video?.decodable
        ? library.source(clip.media)
        : library.proxy(clip.media);
      const name = project.latest()?.project.media.find((m) => m.id === clip.media)?.name;
      if (!source) return project.notice(`${name ?? 'This clip'} can't be decoded here.`);
      try {
        await job(`Removing the background of ${name ?? 'the clip'}`, (signal, progress) =>
          ai().cutout(source, { media: clip.media, start, end }, progress, signal),
        );
      } catch (error) {
        project.notice(message(error));
      } finally {
        engine?.api.mattesChanged(clip.media);
      }
    },
    [ai, engine, job],
  );

  const setRemoveBackground = useCallback(
    async (id: number, on: boolean) => {
      const { project } = state.current;
      const done = await project.execute({
        type: 'setClipProperties',
        clip: id,
        properties: { removeBackground: on },
      });
      const clip = project
        .latest()
        ?.project.tracks.flatMap((t) => t.clips)
        .find((c) => c.id === id);
      if (done && on && clip) await cutOut(clip);
    },
    [cutOut],
  );

  const unfinishedCutouts = useCallback(async () => {
    const current = state.current.project.latest()?.project;
    const clips = current?.tracks.flatMap((t) => (t.hidden ? [] : t.clips)) ?? [];
    const waiting: Clip[] = [];
    for (const clip of clips.filter((c) => c.removeBackground)) {
      const [start, end] = shownRange(clip);
      if (!covers(await readMatteIndex(clip.media, 'selfie'), start, end)) waiting.push(clip);
    }
    return waiting;
  }, []);

  return {
    jobs,
    silenceSettings,
    setSilenceSettings,
    removeSilences,
    detectBeats,
    clearBeats,
    splitScenes,
    setRemoveBackground,
    unfinishedCutouts,
    makeMattes: async (id: number) => {
      const clip = state.current.project
        .latest()
        ?.project.tracks.flatMap((t) => t.clips)
        .find((c) => c.id === id);
      if (clip?.removeBackground) await cutOut(clip);
    },
    client: ai,
    run: job,
  };
}
