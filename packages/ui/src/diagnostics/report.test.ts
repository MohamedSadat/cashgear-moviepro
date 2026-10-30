import { describe, expect, it } from 'vitest';
import { scrub } from './report';

describe('diagnostic reports', () => {
  it('keep the names of the user’s files out', () => {
    expect(scrub('Could not open D:\\Videos\\Holiday\\beach.mp4: denied')).toBe(
      'Could not open <file>: denied',
    );
    expect(scrub('/home/ada/clips/a.mov is missing')).toBe('<file> is missing');
    expect(scrub('beach.MP4 could not be decoded')).toBe('<file> could not be decoded');
    expect(scrub('Frame 1/2 dropped; GPU device lost')).toBe('Frame 1/2 dropped; GPU device lost');
  });
});
