import { describe, expect, it } from 'vitest';
import { isQuotaError, storageWarning } from './quota';

describe('storage quota', () => {
  it('warns when little room is left or most of the share is used', () => {
    expect(storageWarning(null)).toBeNull();
    expect(storageWarning({ usage: 5e9, quota: 60e9, persisted: false })).toBeNull();
    expect(storageWarning({ usage: 59.5e9, quota: 60e9, persisted: true })).toContain(
      '59.5 GB of 60.0 GB',
    );
    expect(storageWarning({ usage: 0.95e9, quota: 1e9, persisted: false })).toContain(
      'nearly full',
    );
  });

  it('tells a full store from other failures', () => {
    expect(isQuotaError(new DOMException('full', 'QuotaExceededError'))).toBe(true);
    expect(isQuotaError(new DOMException('gone', 'NotFoundError'))).toBe(false);
    expect(isQuotaError(new Error('QuotaExceededError'))).toBe(false);
  });
});
