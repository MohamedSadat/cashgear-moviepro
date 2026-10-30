// Browser storage: how full this site's share is, keeping it from being cleared
// under pressure, and telling a full store from other failures.

export interface StorageUse {
  /** Bytes this site stores. */
  usage: number;
  /** Bytes the browser lets it store. */
  quota: number;
  /** The browser keeps this site's data under storage pressure. */
  persisted: boolean;
}

/** Where the browser says; null where it does not. */
export async function storageUse(): Promise<StorageUse | null> {
  if (!navigator.storage?.estimate) return null;
  const [{ usage = 0, quota = 0 }, persisted] = await Promise.all([
    navigator.storage.estimate(),
    navigator.storage.persisted?.() ?? Promise.resolve(false),
  ]);
  return quota > 0 ? { usage, quota, persisted } : null;
}

/** Asks the browser to keep this site's data (projects, media copies) under pressure. */
export async function keepStorage(): Promise<boolean> {
  try {
    return (
      (await navigator.storage?.persisted?.()) || (await navigator.storage?.persist?.()) || false
    );
  } catch {
    return false;
  }
}

/** Less room than this left, or this share used, and the app warns. */
const lowBytes = 1e9;
const lowShare = 0.9;

/** A warning when storage is nearly full, or null. */
export function storageWarning(use: StorageUse | null): string | null {
  if (!use) return null;
  const left = use.quota - use.usage;
  if (left >= lowBytes && use.usage / use.quota < lowShare) return null;
  const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;
  return (
    `Browser storage for CashGear Video is nearly full: ${gb(use.usage)} of ${gb(use.quota)}. ` +
    'Remove media or projects you no longer need, or free space on the disk.'
  );
}

/** Whether `error` is the browser refusing to store more. */
export function isQuotaError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === 'QuotaExceededError' || error.code === DOMException.QUOTA_EXCEEDED_ERR)
  );
}

export const quotaMessage =
  "The browser's storage for CashGear Video is full. Remove media or projects you no longer need, or free space on the disk.";
