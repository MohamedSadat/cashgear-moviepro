import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FLICKS_PER_SECOND,
  createAiClient,
  defaultSilenceSettings,
  isCancelled,
  soundAnalysisVersion,
  type AiClient,
  type CacheStore,
  type Command,
  type SilenceSettings,
  type SoundAnalysis,
} from '@cgv/engine-client';
import type { ProjectState } from '../project/useProject';
import { soundClipOf, timelineRanges } from './timing';

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
}

const key = (media: string, file: string) => `media/${media}/ai/${file}`;
const floats = (bytes: Uint8Array) =>
  new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
const bytesOf = (values: Float32Array) =>
  new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Reads a medium's sound analysis from the cache, or null when it has none. */
async function readAnalysis(cache: CacheStore, media: string): Promise<SoundAnalysis | null> {
  const meta = await cache.read(key(media, 'sound.json'));
  if (!meta) return null;
  const { start, version } = JSON.parse(new TextDecoder().decode(meta)) as {
    start: number;
    version?: number;
  };
  if (version !== soundAnalysisVersion) return null;
  const [levels, onsets] = await Promise.all([
    cache.read(key(media, 'levels.f32')),
    cache.read(key(media, 'onsets.f32')),
  ]);
  return levels && onsets ? { start, levels: floats(levels), onsets: floats(onsets) } : null;
}

async function writeAnalysis(cache: CacheStore, media: string, analysis: SoundAnalysis) {
  await cache.write(key(media, 'levels.f32'), bytesOf(analysis.levels));
  await cache.write(key(media, 'onsets.f32'), bytesOf(analysis.onsets));
  // Written last: its presence means the envelopes are complete.
  const meta = JSON.stringify({
    version: soundAnalysisVersion,
    start: analysis.start,
    readings: analysis.levels.length,
  });
  await cache.write(key(media, 'sound.json'), new TextEncoder().encode(meta));
}

/**
 * The AI tools: jobs in the AI worker, each one cancellable, whose results are
 * cached per media file and turned into ordinary undoable commands.
 */
export function useAiTools(project: ProjectState, cache: CacheStore): AiToolsState {
  const client = useRef<AiClient | null>(null);
  const [jobs, setJobs] = useState<AiJob[]>([]);
  const [silenceSettings, setSilenceSettings] = useState(defaultSilenceSettings);
  const sounds = useRef(new Map<string, Promise<SoundAnalysis | null>>());
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
  const ai = () => (client.current ??= createAiClient());

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

  /** A medium's sound analysis: from memory, the cache, or a new job. */
  const soundOf = useCallback(
    (media: string, name: string): Promise<SoundAnalysis | null> => {
      const known = sounds.current.get(media);
      if (known) return known;
      const library = state.current.project.library;
      const item = library.items.find((entry) => entry.id === media);
      const source = item?.audio?.decodable ? library.source(media) : library.proxy(media);
      const found = (async () => {
        const cached = await readAnalysis(cache, media);
        if (cached) return cached;
        if (!source) throw new Error(`The sound of ${name} can't be decoded here.`);
        const analysis = await job(`Listening to ${name}`, (signal, progress) =>
          ai().analyzeSound(source, progress, signal),
        );
        if (analysis) await writeAnalysis(cache, media, analysis);
        return analysis;
      })();
      sounds.current.set(media, found);
      // A cancelled or failed analysis can be asked for again.
      void found.then(
        (analysis) => analysis || sounds.current.delete(media),
        () => sounds.current.delete(media),
      );
      return found;
    },
    [cache, job],
  );

  /** The sound clip for `id` and its analysis, or null after telling the user why not. */
  const prepare = useCallback(
    async (id: number) => {
      const { project } = state.current;
      const current = project.latest()?.project;
      if (!current) return null;
      const sound = soundClipOf(current, id);
      if (!sound) {
        project.notice('This clip has no sound to analyse.');
        return null;
      }
      const name = current.media.find((media) => media.id === sound.media)?.name ?? 'the clip';
      try {
        const analysis = await soundOf(sound.media, name);
        return analysis ? { sound: sound.id, name, analysis } : null;
      } catch (error) {
        project.notice(message(error));
        return null;
      }
    },
    [soundOf],
  );

  const removeSilences = useCallback(
    async (id: number) => {
      const ready = await prepare(id);
      if (!ready) return;
      const { project, silenceSettings } = state.current;
      const ranges = await ai().silences(ready.analysis, silenceSettings);
      // The clip as it is now: the project may have changed while the job ran.
      const current = project.latest()?.project;
      const clip = current?.tracks.flatMap((t) => t.clips).find((c) => c.id === ready.sound);
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
      const ready = await prepare(id);
      if (!ready) return;
      const { project } = state.current;
      const { tempo, beats } = await ai().beats(ready.analysis);
      if (tempo === null || !beats.length)
        return project.notice(`No steady beat was found in ${ready.name}.`);
      const times = beats.map((time) => Math.max(0, Math.round(time * FLICKS_PER_SECOND)));
      await project.executeGroup('Detect beats', [
        { type: 'setBeats', clip: ready.sound, beats: times },
      ]);
    },
    [prepare],
  );

  const clearBeats = useCallback(async (id: number) => {
    const { project } = state.current;
    const current = project.latest()?.project;
    const sound = current ? soundClipOf(current, id) : null;
    if (sound?.beats?.length)
      await project.executeGroup('Clear beats', [{ type: 'setBeats', clip: sound.id, beats: [] }]);
  }, []);

  return {
    jobs,
    silenceSettings,
    setSilenceSettings,
    removeSilences,
    detectBeats,
    clearBeats,
  };
}
