import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FLICKS_PER_SECOND,
  type CacheStore,
  type CaptionModel,
  type Clip,
  type Command,
  type ModelState,
  type Project,
  type Track,
  type Transcript,
} from '@cgv/engine-client';
import type { AiToolsState } from '../ai/useAiTools';
import { soundClipOf, timelineAt } from '../ai/timing';
import type { EditorState } from '../editing/useEditor';
import type { MediaPlatform } from '../platform';
import { sourceAt } from '../speed/timing';
import {
  captionSpec,
  captionText,
  captionTitle,
  makeCues,
  styleOf,
  toSrt,
  toVtt,
  wordKeys,
  type CaptionStyle,
} from './captions';

/** The languages offered first; Whisper knows many more. Null detects it. */
export const captionLanguages: { code: string | null; label: string }[] = [
  { code: null, label: 'Detect' },
  { code: 'en', label: 'English' },
  { code: 'ar', label: 'Arabic' },
  { code: 'fr', label: 'French' },
  { code: 'es', label: 'Spanish' },
  { code: 'de', label: 'German' },
  { code: 'tr', label: 'Turkish' },
  { code: 'ur', label: 'Urdu' },
  { code: 'hi', label: 'Hindi' },
];

/** Where new captions go: a track of this name, made on top when there is none. */
export const captionTrackName = 'Captions';

export interface CaptionsState {
  /** The speech model captions use, once its state is known. */
  model: ModelState | null;
  /** Downloads the speech model, as a job. */
  install(): Promise<void>;
  /** Writes captions for clip `id`'s speech onto the captions track, as one undo step. */
  generate(id: number, language: string | null, style: CaptionStyle): Promise<void>;
  /** The tracks holding caption clips, top first. */
  tracks: Track[];
  /** Gives every caption on `track` a look, as one undo step. */
  restyle(track: number, style: CaptionStyle): Promise<void>;
  /** Changes a caption's text; its word times spread evenly when the words change. */
  setText(clip: number, text: string): Promise<void>;
  /** Saves `track`'s captions as a subtitle file. */
  exportSubtitles(track: number, format: 'srt' | 'vtt'): Promise<void>;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const transcriptKey = (
  media: string,
  model: string,
  language: string | null,
  from: number,
  to: number,
) =>
  `media/${media}/ai/transcript-${model}-${language ?? 'auto'}-${Math.round(from * 1000)}-${Math.round(to * 1000)}.json`;

/** Tracks with caption clips, top first. */
function captionTracks(project: Project | undefined): Track[] {
  return [...(project?.tracks ?? [])]
    .reverse()
    .filter((track) => track.clips.some((clip) => clip.caption));
}

/**
 * Captions: speech to text in the AI worker (cached per clip's range of media),
 * lines placed as caption title clips, looks applied to a whole track, and
 * subtitle files. Every change is one undo step.
 */
export function useCaptions(
  editor: EditorState,
  ai: AiToolsState,
  platform: MediaPlatform,
  options: { model?: CaptionModel } = {},
): CaptionsState {
  const project = editor.project;
  const modelId: CaptionModel = options.model ?? 'whisper-large-v3-turbo';
  const [model, setModel] = useState<ModelState | null>(null);
  const cache: CacheStore = platform.cache;
  const state = useRef({ project, ai, editor });
  state.current = { project, ai, editor };

  const refresh = useCallback(async () => {
    try {
      setModel(await state.current.ai.client().modelState(modelId));
    } catch (error) {
      console.warn('The caption model state is unknown:', error);
    }
  }, [modelId]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const install = useCallback(async () => {
    const { ai, project } = state.current;
    try {
      await ai.run(`Downloading ${model?.name ?? 'the caption model'}`, (signal, progress) =>
        ai.client().installModel(modelId, progress, signal),
      );
    } catch (error) {
      project.notice(message(error));
    }
    await refresh();
  }, [model?.name, modelId, refresh]);

  const generate = useCallback(
    async (id: number, language: string | null, style: CaptionStyle) => {
      const { project, ai } = state.current;
      const current = project.latest()?.project;
      if (!current) return;
      const clip = soundClipOf(current, id);
      if (!clip) return project.notice('Select a clip with speech to caption.');
      const media = current.media.find((m) => m.id === clip.media);
      const name = media?.name ?? 'the clip';
      const ends = [sourceAt(clip, 0), sourceAt(clip, clip.duration)];
      const from = Math.min(...ends) / FLICKS_PER_SECOND;
      const to = Math.max(...ends) / FLICKS_PER_SECOND;
      const key = transcriptKey(clip.media, modelId, language, from, to);
      let transcript: Transcript | null;
      try {
        const cached = await cache.read(key);
        if (cached) transcript = JSON.parse(new TextDecoder().decode(cached)) as Transcript;
        else {
          const library = project.library;
          const item = library.items.find((entry) => entry.id === clip.media);
          const source = item?.audio?.decodable
            ? library.source(clip.media)
            : library.proxy(clip.media);
          if (!source) return project.notice(`The sound of ${name} can't be decoded here.`);
          transcript = await ai.run(`Captioning ${name}`, (signal, progress) =>
            ai
              .client()
              .transcribe(
                source,
                { model: modelId, language, start: from, end: to },
                progress,
                signal,
              ),
          );
          if (!transcript) return;
          const { language: spoken, segments } = transcript;
          await cache.write(
            key,
            new TextEncoder().encode(JSON.stringify({ language: spoken, segments })),
          );
        }
      } catch (error) {
        return project.notice(message(error));
      }
      const cues = makeCues(transcript.segments);
      // The clip as it is now: the project may have changed while the job ran.
      const latest = project.latest()?.project;
      const now = latest?.tracks.flatMap((t) => t.clips).find((c) => c.id === clip.id);
      if (!latest || !now) return;
      const placed = cues
        .map((cue) => {
          const at = (seconds: number) => timelineAt(now, Math.round(seconds * FLICKS_PER_SECOND));
          const [start, end] = [at(cue.start), at(cue.end)];
          if (start === null || end === null || end <= start) return null;
          const words = cue.words.map(at).filter((time): time is number => time !== null);
          return { text: cue.text, start, duration: end - start, words };
        })
        .filter((cue) => cue !== null);
      if (!placed.length) return project.notice(`No speech was heard in ${name}.`);
      const spoken = transcript.language;
      await project.transaction('Add captions', async (step) => {
        let track = latest.tracks.find((t) => t.name === captionTrackName && !t.locked)?.id;
        track ??= (
          await step({ type: 'addTrack', index: latest.tracks.length, name: captionTrackName })
        )[0];
        for (const cue of placed)
          await step({
            type: 'overwrite',
            track,
            at: Math.round(cue.start),
            clip: captionSpec(cue, spoken, style, latest.settings),
          });
        return [];
      });
    },
    [cache, modelId],
  );

  const restyle = useCallback(async (trackId: number, style: CaptionStyle) => {
    const { project } = state.current;
    const current = project.latest()?.project;
    const track = current?.tracks.find((t) => t.id === trackId);
    if (!current || !track) return;
    const frame =
      (FLICKS_PER_SECOND * current.settings.frameRate.den) / current.settings.frameRate.num;
    const commands: Command[] = [];
    for (const clip of track.clips) {
      const element = clip.title?.elements[0];
      if (!clip.caption || !element) continue;
      const title = captionTitle(
        captionText(clip.title),
        clip.caption.language,
        style,
        current.settings,
      );
      title.elements[0] = { ...title.elements[0], id: element.id };
      const keys =
        style === 'words' ? Object.values(wordKeys(clip.caption.words ?? [], frame))[0] : [];
      commands.push({
        type: 'batch',
        commands: [
          { type: 'setTitle', clip: clip.id, title },
          {
            type: 'setKeyframes',
            clip: clip.id,
            property: `title.${element.id}.reveal`,
            keys: keys ?? [],
          },
        ],
      });
    }
    if (commands.length) await project.executeGroup('Change caption look', commands);
  }, []);

  const setText = useCallback(async (id: number, text: string) => {
    const { project } = state.current;
    const current = project.latest()?.project;
    const clip: Clip | undefined = current?.tracks.flatMap((t) => t.clips).find((c) => c.id === id);
    const element = clip?.title?.elements[0];
    if (!current || !clip?.caption || !element || element.type !== 'text') return;
    const trimmed = text.trim();
    if (!trimmed || trimmed === element.text) return;
    const frame =
      (FLICKS_PER_SECOND * current.settings.frameRate.den) / current.settings.frameRate.num;
    const count = trimmed.split(/\s+/).length;
    let words = clip.caption.words ?? [];
    // Other words than before: spread them over the line.
    if (words.length !== count)
      words = Array.from({ length: count }, (_, i) => Math.round((clip.duration * i) / count));
    const style = styleOf(clip.title);
    const commands: Command[] = [
      { type: 'setTitle', clip: id, title: { elements: [{ ...element, text: trimmed }] } },
      { type: 'setCaption', clip: id, caption: { ...clip.caption, words } },
    ];
    if (style === 'words')
      commands.push({
        type: 'setKeyframes',
        clip: id,
        property: `title.${element.id}.reveal`,
        keys: Object.values(wordKeys(words, frame))[0] ?? [],
      });
    await project.executeGroup('Edit caption', [{ type: 'batch', commands }]);
  }, []);

  const exportSubtitles = useCallback(
    async (trackId: number, format: 'srt' | 'vtt') => {
      const { project } = state.current;
      const current = project.latest()?.project;
      const track = current?.tracks.find((t) => t.id === trackId);
      if (!current || !track) return;
      const cues = track.clips
        .filter((clip) => clip.caption)
        .map((clip) => ({
          start: clip.start / FLICKS_PER_SECOND,
          end: (clip.start + clip.duration) / FLICKS_PER_SECOND,
          text: captionText(clip.title),
        }));
      if (!cues.length) return project.notice('This track has no captions to save.');
      const text = format === 'srt' ? toSrt(cues) : toVtt(cues);
      const label = format === 'srt' ? 'SubRip subtitles' : 'WebVTT subtitles';
      try {
        await platform.saveTextFile(current.name, format, label, text);
      } catch (error) {
        project.notice(message(error));
      }
    },
    [platform],
  );

  return {
    model,
    install,
    generate,
    tracks: captionTracks(project.snapshot?.project),
    restyle,
    setText,
    exportSubtitles,
  };
}
