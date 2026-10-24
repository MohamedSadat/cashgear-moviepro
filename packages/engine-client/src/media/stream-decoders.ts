/** What a decoder's outputs and errors go to while a stream holds it. */
export interface DecoderOwner {
  output(frame: VideoFrame): void;
  error(error: Error): void;
}

/** Idle decoders kept per medium. */
const keepIdle = 8;

/** A configured decoder that playback streams borrow and hand back. */
export class PooledDecoder {
  readonly decoder: VideoDecoder;
  owner: DecoderOwner | null = null;

  constructor(
    readonly key: string,
    readonly config: VideoDecoderConfig,
  ) {
    this.decoder = new VideoDecoder({
      output: (frame) => {
        if (this.owner) this.owner.output(frame);
        else frame.close();
      },
      error: (error) =>
        this.owner?.error(error instanceof Error ? error : new Error(String(error))),
    });
    this.decoder.configure(config);
  }

  get usable() {
    return this.decoder.state === 'configured';
  }

  close() {
    this.owner = null;
    if (this.decoder.state !== 'closed') this.decoder.close();
  }
}

/**
 * Playback decoders, kept configured between clips. Starting or closing a
 * hardware decoder briefly stalls the browser's GPU process, which costs frames
 * when it happens mid-playback; so playback warms decoders up before its clock
 * starts, and a clip that ends hands its decoder to the next. A returned decoder
 * is flushed first, so no frame of its last clip reaches the next one.
 */
export class StreamDecoders {
  private idle = new Map<string, PooledDecoder[]>();
  private draining = 0;

  get idleCount() {
    let count = 0;
    for (const list of this.idle.values()) count += list.length;
    return count;
  }

  /** Decoders being flushed on their way back; warm-up waits for them. */
  get pending() {
    return this.draining;
  }

  /** A decoder for `key` (one medium), configured with `config`. */
  acquire(key: string, config: VideoDecoderConfig, owner: DecoderOwner): PooledDecoder {
    const list = this.idle.get(key);
    let pooled = list?.pop();
    while (pooled && !pooled.usable) {
      pooled.close();
      pooled = list?.pop();
    }
    pooled ??= new PooledDecoder(key, config);
    pooled.owner = owner;
    return pooled;
  }

  /**
   * Takes a decoder back. One with work queued (`drained` false) is flushed
   * first, so none of its frames reach the next clip; flushing costs a moment
   * of the GPU process, so callers say when there is nothing to drain.
   */
  release(pooled: PooledDecoder, drained = false) {
    pooled.owner = null;
    if (!pooled.usable) return pooled.close();
    if (drained) return this.keep(pooled);
    this.draining++;
    pooled.decoder
      .flush()
      .then(() => this.keep(pooled))
      .catch(() => pooled.close())
      .finally(() => this.draining--);
  }

  /** Makes sure `count` idle decoders exist for `key`. */
  warm(key: string, config: VideoDecoderConfig, count: number) {
    const list = this.idle.get(key) ?? [];
    this.idle.set(key, list);
    while (list.length < Math.min(count, keepIdle)) list.push(new PooledDecoder(key, config));
  }

  /** Closes the idle decoders of `key`, or of every medium. */
  clear(key?: string) {
    for (const [id, list] of this.idle) {
      if (key !== undefined && id !== key) continue;
      for (const pooled of list) pooled.close();
      this.idle.delete(id);
    }
  }

  private keep(pooled: PooledDecoder) {
    if (pooled.owner || !pooled.usable) return;
    const list = this.idle.get(pooled.key) ?? [];
    this.idle.set(pooled.key, list);
    if (list.length < keepIdle) list.push(pooled);
    else pooled.close();
  }
}
