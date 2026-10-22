export interface Closable {
  close(): void;
  readonly closed: boolean;
}

/**
 * Keeps at most `capacity` decoders open, one per track. Hardware decoders are
 * a scarce resource, so the least recently used one is closed to make room.
 */
export class DecoderPool<D extends Closable> {
  private decoders = new Map<string, D>();

  constructor(private capacity: number) {}

  get size() {
    return this.decoders.size;
  }

  /** The decoder for `key`, creating it (and evicting the oldest) when needed. */
  acquire(key: string, create: () => D): D {
    const existing = this.decoders.get(key);
    if (existing && !existing.closed) {
      this.decoders.delete(key);
      this.decoders.set(key, existing);
      return existing;
    }
    if (existing) this.decoders.delete(key);
    while (this.decoders.size >= this.capacity) {
      const [oldestKey, oldest] = this.decoders.entries().next().value as [string, D];
      this.decoders.delete(oldestKey);
      oldest.close();
    }
    const decoder = create();
    this.decoders.set(key, decoder);
    return decoder;
  }

  release(key: string) {
    const decoder = this.decoders.get(key);
    if (!decoder) return;
    this.decoders.delete(key);
    decoder.close();
  }

  clear() {
    for (const key of [...this.decoders.keys()]) this.release(key);
  }
}
