export interface Cacheable {
  readonly bytes: number;
  close(): void;
}

/**
 * Least-recently-used cache with a byte budget. It owns its entries: evicted,
 * replaced, deleted or cleared entries are closed. Callers that keep an entry
 * beyond the next cache call must take their own reference (ManagedFrame.clone).
 */
export class FrameCache<T extends Cacheable> {
  private entries = new Map<string, T>();
  private totalBytes = 0;

  constructor(private budgetBytes: number) {}

  get bytes() {
    return this.totalBytes;
  }
  get size() {
    return this.entries.size;
  }
  get budget() {
    return this.budgetBytes;
  }

  has(key: string) {
    return this.entries.has(key);
  }

  /** Returns the entry and marks it most recently used. */
  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
    return entry;
  }

  put(key: string, entry: T) {
    this.delete(key);
    this.entries.set(key, entry);
    this.totalBytes += entry.bytes;
    this.evict();
  }

  delete(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.entries.delete(key);
    this.totalBytes -= entry.bytes;
    entry.close();
    return true;
  }

  /** Drops every entry whose key starts with `prefix` (one media item, say). */
  deletePrefix(prefix: string) {
    for (const key of [...this.entries.keys()]) if (key.startsWith(prefix)) this.delete(key);
  }

  setBudget(bytes: number) {
    this.budgetBytes = bytes;
    this.evict();
  }

  clear() {
    for (const key of [...this.entries.keys()]) this.delete(key);
  }

  private evict() {
    // Keep the newest entry even if it alone exceeds the budget.
    while (this.totalBytes > this.budgetBytes && this.entries.size > 1) {
      const oldest = this.entries.keys().next().value as string;
      this.delete(oldest);
    }
  }
}
