import { describe, expect, it } from 'vitest';
import { FLICKS_PER_SECOND, type TranscriptSegment } from '@cgv/engine-client';
import { captionSpec, captionTitle, makeCues, styleOf, toSrt, toVtt, wordKeys } from './captions';

const S = FLICKS_PER_SECOND;
const FRAME = S / 30;

/** Words as Whisper writes them: a leading space, except punctuation that joins on. */
const segment = (words: [string, number, number][]): TranscriptSegment => ({
  start: words[0][1],
  end: words[words.length - 1][2],
  text: words.map(([w]) => w).join(' '),
  words: words.map(([text, start, end]) => ({
    text: /^[.,%]/.test(text) ? text : ' ' + text,
    start,
    end,
    probability: 0.9,
  })),
});

describe('captions', () => {
  it('groups words into readable lines', () => {
    const cues = makeCues([
      segment([
        ['Unfortunately,', 1.8, 2.8],
        ['studying', 3.1, 3.4],
        ['traffic', 3.4, 3.9],
        ['flow', 3.9, 4.2],
        ['is', 4.2, 4.5],
        ['difficult.', 4.5, 4.9],
        ['Drivers', 5.0, 5.4],
        ['vary', 5.4, 5.7],
        ['.', 5.7, 5.8],
      ]),
      segment([
        ['After', 7.0, 7.2],
        ['a', 7.2, 7.3],
        ['pause,', 7.3, 7.6],
      ]),
    ]);
    expect(cues.map((cue) => cue.text)).toEqual([
      'Unfortunately, studying traffic flow is',
      'difficult.',
      'Drivers vary.',
      'After a pause,',
    ]);
    expect(cues[0].words).toEqual([1.8, 3.1, 3.4, 3.9, 4.2]);
    // A short line stays up a second, unless the next one starts sooner.
    expect(cues[1]).toMatchObject({ start: 4.5, end: 5.0 });
    expect(cues[3]).toMatchObject({ start: 7.0, end: 8.0 });
  });

  it('makes caption clips in each look, in the script’s font', () => {
    const canvas = { width: 1920, height: 1080 };
    const boxed = captionTitle('Hello there', 'en', 'boxed', canvas).elements[0];
    expect(boxed).toMatchObject({ type: 'text', size: 54, wrap: 1632, x: 0 });
    expect(boxed.type === 'text' && boxed.background?.perLine).toBe(true);
    const arabic = captionTitle('مرحبا بكم', 'ar', 'clean', canvas).elements[0];
    expect(arabic.type === 'text' && arabic.font.family).toBe('Noto Sans Arabic');
    const settings = {
      width: 1080,
      height: 1920,
      frameRate: { num: 30, den: 1 },
      sampleRate: 48000,
      channels: 2,
    };
    const spec = captionSpec(
      {
        text: 'one two three',
        start: 10 * S,
        duration: 2 * S + 5,
        words: [10 * S, 10.5 * S, 11 * S],
      },
      'en',
      'words',
      settings,
    );
    expect(spec.duration).toBe(2 * S);
    expect(spec.caption).toEqual({ language: 'en', words: [0, S / 2, S] });
    expect(styleOf(spec.title)).toBe('words');
    expect(Object.keys(spec.keyframes ?? {})).toEqual(['title.1.reveal']);
    for (const style of ['boxed', 'clean', 'bold'] as const)
      expect(styleOf(captionTitle('x', 'en', style, canvas))).toBe(style);
  });

  it('reveals each word as it is said', () => {
    const keys = wordKeys([0, 15 * FRAME, 16 * FRAME], FRAME)['title.1.reveal'];
    expect(
      keys.map((k) => [k.time / FRAME, Number(k.value).toFixed(3), k.interpolation.kind]),
    ).toEqual([
      [0, '0.000', 'linear'],
      [3, '0.333', 'hold'],
      // The next word follows a frame later: this one shows at once.
      [15, '0.667', 'linear'],
      [16, '0.667', 'linear'],
      [19, '1.000', 'hold'],
    ]);
  });

  it('writes SubRip and WebVTT', () => {
    const cues = [
      { start: 1.5, end: 3.25, text: 'Hello there.' },
      { start: 3661.001, end: 3662, text: 'مرحبا' },
    ];
    expect(toSrt(cues)).toBe(
      '1\n00:00:01,500 --> 00:00:03,250\nHello there.\n\n2\n01:01:01,001 --> 01:01:02,000\nمرحبا\n',
    );
    expect(toVtt(cues)).toBe(
      'WEBVTT\n\n00:00:01.500 --> 00:00:03.250\nHello there.\n\n01:01:01.001 --> 01:01:02.000\nمرحبا\n',
    );
  });
});
