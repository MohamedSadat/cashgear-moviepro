import { describe, expect, it } from 'vitest';
import { validateCacheKey } from './cache-store';

describe('validateCacheKey', () => {
  it('accepts path-like keys and refuses escapes', () => {
    expect(validateCacheKey('media/abc-1/thumb-0.jpg')).toEqual(['media', 'abc-1', 'thumb-0.jpg']);
    for (const bad of ['../x', 'media/../x', '/abs', 'a//b', 'a\b', 'a/./b', '', 'c:x'])
      expect(() => validateCacheKey(bad)).toThrow('Invalid cache key');
  });
});
