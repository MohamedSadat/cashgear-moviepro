import { invoke } from '@tauri-apps/api/core';

// Frame channels: slots of memory the page shares with the native side through
// WebView2 shared buffers (apps/desktop/src-tauri/src/frames.rs). Tauri's IPC
// carries about 11 MB/s and these about 1.2 GB/s, so raw frames go this way
// and only slot numbers cross the IPC. One side at a time owns a slot: the page
// fills it, then the native command that reads it resolves.

interface SharedBufferEvent extends Event {
  additionalData: { channel: string; slot: number };
  getBuffer(): ArrayBuffer;
}

interface WebView {
  addEventListener(
    type: 'sharedbufferreceived',
    listener: (event: SharedBufferEvent) => void,
  ): void;
  releaseBuffer(buffer: ArrayBuffer): void;
}

const webview = (Reflect.get(window, 'chrome') as { webview?: WebView } | undefined)?.webview;
/** Slots that have arrived, by channel; they may come before `frames_open` resolves. */
const arrived = new Map<string, ArrayBuffer[]>();
const waiting = new Map<string, () => void>();

webview?.addEventListener('sharedbufferreceived', (event) => {
  const { channel, slot } = event.additionalData;
  const slots = arrived.get(channel) ?? [];
  slots[slot] = event.getBuffer();
  arrived.set(channel, slots);
  waiting.get(channel)?.();
});
// Slots a page before a reload had stay mapped until the native side lets them go.
if (webview) void invoke('frames_reset').catch(() => {});

export class FrameChannel {
  private next = 0;

  private constructor(
    readonly id: string,
    private readonly slots: ArrayBuffer[],
  ) {}

  /** A channel of `count` slots of `size` bytes. */
  static async open(size: number, count: number): Promise<FrameChannel> {
    if (!webview) throw new Error('Frame channels need WebView2');
    const id = await invoke<string>('frames_open', { size, slots: count });
    const full = () => (arrived.get(id) ?? []).filter(Boolean).length === count;
    if (!full())
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('The frame slots did not arrive')), 10000);
        waiting.set(id, () => {
          if (!full()) return;
          clearTimeout(timer);
          resolve();
        });
      });
    waiting.delete(id);
    const slots = arrived.get(id)!;
    arrived.delete(id);
    return new FrameChannel(id, slots);
  }

  /** Copies `data` into the next slot and runs `send` with its number and length. */
  async send<T>(
    data: ArrayBufferView,
    send: (slot: number, len: number) => Promise<T>,
  ): Promise<T> {
    const slot = this.next;
    this.next = (this.next + 1) % this.slots.length;
    const memory = this.slots[slot];
    if (data.byteLength > memory.byteLength)
      throw new Error(`${data.byteLength} bytes do not fit in a ${memory.byteLength}-byte slot`);
    new Uint8Array(memory, 0, data.byteLength).set(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    );
    return send(slot, data.byteLength);
  }

  /**
   * Runs `fill` with the next slot's number, then copies out the slot's
   * contents, which the native side wrote.
   */
  async receive(fill: (slot: number) => Promise<unknown>): Promise<Uint8Array> {
    const slot = this.next;
    this.next = (this.next + 1) % this.slots.length;
    await fill(slot);
    return new Uint8Array(this.slots[slot]).slice();
  }

  async close() {
    for (const memory of this.slots) webview?.releaseBuffer(memory);
    await invoke('frames_close', { id: this.id });
  }
}
