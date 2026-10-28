import {
  FLICKS_PER_SECOND,
  type ClipSpec,
  type Keyframe,
  type ProjectSettings,
  type Title,
  type TranscriptSegment,
} from '@cgv/engine-client';

// Captions from a transcript: words grouped into short lines (cues), each a
// title clip in one of a few looks, and subtitle files from caption clips.
// Times here are seconds unless named flicks.

/** A caption line: when it shows and what it says. */
export interface Cue {
  start: number;
  end: number;
  text: string;
  /** When each word of the text is said. */
  words: number[];
}

/** How words become lines. */
export interface CueRules {
  /** Letters on a line, as subtitle guides allow (Netflix: 42). */
  maxChars: number;
  /** Seconds a line shows at most... */
  maxSeconds: number;
  /** ...and at least, when the next line leaves room. */
  minSeconds: number;
  /** A pause this long (seconds) starts a new line. */
  pause: number;
}

export const cueRules: CueRules = { maxChars: 42, maxSeconds: 6, minSeconds: 1, pause: 0.6 };

const sentenceEnd = /[.!?؟。…]["'”»)]*$/;

/**
 * Lines from a transcript's words, in order: a line ends at a sentence's end, a
 * pause, or when another word would make it too long to read.
 */
export function makeCues(segments: TranscriptSegment[], rules: CueRules = cueRules): Cue[] {
  const cues: Cue[] = [];
  let current: Cue | null = null;
  for (const segment of segments)
    for (const word of segment.words) {
      const text = word.text.trim();
      if (!text) continue;
      // A word written without a space before it belongs to the last one.
      if (current && !/^\s/.test(word.text)) {
        current.text += text;
        current.end = Math.max(current.end, word.end);
        continue;
      }
      if (current) {
        const longer = current.text.length + 1 + text.length > rules.maxChars;
        const slower = word.end - current.start > rules.maxSeconds;
        const paused = word.start - current.end > rules.pause;
        if (longer || slower || paused || sentenceEnd.test(current.text)) {
          cues.push(current);
          current = null;
        }
      }
      if (current) {
        current.text += ' ' + text;
        current.end = Math.max(current.end, word.end);
        current.words.push(word.start);
      } else current = { start: word.start, end: word.end, text, words: [word.start] };
    }
  if (current) cues.push(current);
  // Short lines stay up long enough to read, without running into the next.
  for (let i = 0; i < cues.length; i++) {
    const next = cues[i + 1]?.start ?? Infinity;
    cues[i].end = Math.min(Math.max(cues[i].end, cues[i].start + rules.minSeconds), next);
  }
  return cues;
}

export type CaptionStyle = 'clean' | 'boxed' | 'bold' | 'words';

/** The looks offered, in menu order. */
export const captionStyles: { id: CaptionStyle; label: string }[] = [
  { id: 'boxed', label: 'Boxed' },
  { id: 'clean', label: 'Clean outline' },
  { id: 'bold', label: 'Bold yellow' },
  { id: 'words', label: 'Word by word' },
];

/** The text element of every caption title. */
const element = 1;

const white = { r: 1, g: 1, b: 1, a: 1 };
const black = (a: number) => ({ r: 0, g: 0, b: 0, a });

/**
 * A caption's title in `style`, for a frame of `canvas`: centred near the
 * bottom, sized to the frame's shorter side, in a bundled font for its script.
 */
export function captionTitle(
  text: string,
  language: string,
  style: CaptionStyle,
  canvas: { width: number; height: number },
): Title {
  const short = Math.min(canvas.width, canvas.height);
  const size = Math.round(short * 0.05);
  const arabic = language === 'ar' || /[؀-ۿ]/.test(text);
  const family = arabic ? 'Noto Sans Arabic' : 'Inter';
  const base = {
    id: element,
    x: 0,
    y: Math.round(canvas.height / 2 - canvas.height * 0.1 - size / 2),
    type: 'text' as const,
    text,
    size,
    align: 'center' as const,
    wrap: Math.round(canvas.width * 0.85),
  };
  const boxed = {
    background: {
      color: black(0.65),
      padding: Math.round(size * 0.22),
      radius: Math.round(size * 0.1),
      perLine: true,
    },
  };
  switch (style) {
    case 'clean':
      return {
        elements: [
          {
            ...base,
            fill: white,
            font: { family, weight: 600 },
            stroke: { color: black(1), width: Math.max(2, Math.round(size * 0.08)) },
            shadow: {
              color: black(0.6),
              x: 0,
              y: Math.round(size * 0.05),
              blur: Math.round(size * 0.1),
            },
          },
        ],
      };
    case 'bold':
      return {
        elements: [
          {
            ...base,
            fill: { r: 1, g: 0.84, b: 0.04, a: 1 },
            font: { family, weight: 800 },
            stroke: { color: black(1), width: Math.max(3, Math.round(size * 0.12)) },
          },
        ],
      };
    case 'words':
      return {
        elements: [
          { ...base, ...boxed, fill: white, font: { family, weight: 600 }, revealBy: 'word' },
        ],
      };
    default:
      return { elements: [{ ...base, ...boxed, fill: white, font: { family, weight: 600 } }] };
  }
}

/**
 * Keyframes that show a word-by-word caption's words as they are said: each
 * fades in over a tenth of a second, or less when the next follows sooner.
 * `words` are flicks from the clip's start; `frame` is the project's frame.
 */
export function wordKeys(words: number[], frame: number): Record<string, Keyframe[]> {
  if (!words.length) return {};
  const keys: Keyframe[] = [];
  const count = words.length;
  const fade = Math.round(FLICKS_PER_SECOND / 10);
  words.forEach((start, i) => {
    const at = Math.round(start / frame) * frame;
    const next = i + 1 < count ? Math.round(words[i + 1] / frame) * frame : Infinity;
    const shown = Math.min(at + Math.max(frame, Math.round(fade / frame) * frame), next - frame);
    const last = keys[keys.length - 1];
    if (last && last.time >= at) last.value = i / count;
    else keys.push({ time: at, value: i / count, interpolation: { kind: 'linear' } });
    if (shown > at)
      keys.push({ time: shown, value: (i + 1) / count, interpolation: { kind: 'hold' } });
    else keys[keys.length - 1].value = (i + 1) / count;
  });
  if (keys[0].time > 0) keys.unshift({ time: 0, value: 0, interpolation: { kind: 'hold' } });
  return { [`title.${element}.reveal`]: keys };
}

/** Rounds flicks to whole frames. */
const onFrame = (time: number, frame: number) => Math.round(time / frame) * frame;

/**
 * The clip for a caption line placed at `start` flicks on the timeline, lasting
 * `duration`, whose words fall at `words` flicks from the timeline's start.
 */
export function captionSpec(
  cue: { text: string; start: number; duration: number; words: number[] },
  language: string,
  style: CaptionStyle,
  settings: ProjectSettings,
): ClipSpec {
  const frame = (FLICKS_PER_SECOND * settings.frameRate.den) / settings.frameRate.num;
  const duration = Math.max(frame, onFrame(cue.duration, frame));
  const words = cue.words.map((time) => Math.max(0, Math.round(time - cue.start)));
  return {
    kind: 'title',
    duration,
    title: captionTitle(cue.text, language, style, settings),
    caption: { language, words },
    keyframes: style === 'words' ? wordKeys(words, frame) : {},
  };
}

/** A clip's caption look, read back from its title. */
export function styleOf(title: Title | undefined): CaptionStyle {
  const text = title?.elements.find((e) => e.type === 'text');
  if (!text || text.type !== 'text') return 'boxed';
  if (text.revealBy === 'word') return 'words';
  if (text.background) return 'boxed';
  return (text.font.weight ?? 400) >= 800 ? 'bold' : 'clean';
}

/** A caption clip's text. */
export function captionText(title: Title | undefined): string {
  const text = title?.elements.find((e) => e.type === 'text');
  return text?.type === 'text' ? text.text : '';
}

/** Subtitle cues in timeline seconds. */
export interface SubtitleCue {
  start: number;
  end: number;
  text: string;
}

function clock(seconds: number, separator: ',' | '.') {
  const total = Math.max(0, Math.round(seconds * 1000));
  const ms = total % 1000;
  const s = Math.floor(total / 1000) % 60;
  const m = Math.floor(total / 60_000) % 60;
  const h = Math.floor(total / 3_600_000);
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}${separator}${pad(ms, 3)}`;
}

/** SubRip: numbered cues with comma milliseconds. */
export function toSrt(cues: SubtitleCue[]): string {
  return cues
    .map(
      (cue, i) =>
        `${i + 1}\n${clock(cue.start, ',')} --> ${clock(cue.end, ',')}\n${cue.text.trim()}\n`,
    )
    .join('\n');
}

/** WebVTT: a header, then cues with dot milliseconds. */
export function toVtt(cues: SubtitleCue[]): string {
  const body = cues
    .map((cue) => `${clock(cue.start, '.')} --> ${clock(cue.end, '.')}\n${cue.text.trim()}\n`)
    .join('\n');
  return `WEBVTT\n\n${body}`;
}
