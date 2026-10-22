import type { FrameStats, PhysicalSize } from './types';

export interface FrameTarget {
  resize(size: PhysicalSize): void;
  /** Renders the frame for host time `now` (ms) and returns its stats. */
  frame(now: number): FrameStats;
}
export interface FrameScheduler {
  request(callback: (now: number) => void): number;
  cancel(handle: number): void;
}

/**
 * Drives the engine from the worker. Resizes that arrive between frames collapse
 * to the latest one, a zero-sized monitor pauses the loop until it has an area
 * again, and the first error stops it for good.
 */
export class FrameLoop {
  private handle: number | undefined;
  private size: PhysicalSize = { width: 0, height: 0 };
  private pendingSize: PhysicalSize | undefined;
  private stopped = false;
  private lastReport = -Infinity;
  private frames = 0;

  constructor(
    private target: FrameTarget,
    private scheduler: FrameScheduler,
    private onStats: (stats: FrameStats) => void,
    private onError: (message: string) => void,
    private reportInterval = 100,
  ) {}

  start(size: PhysicalSize) {
    this.resize(size);
  }

  resize(size: PhysicalSize) {
    if (this.stopped) return;
    this.size = size;
    this.pendingSize = size;
    this.schedule();
  }

  stop() {
    this.stopped = true;
    if (this.handle !== undefined) this.scheduler.cancel(this.handle);
    this.handle = undefined;
  }

  private get hasArea() {
    return this.size.width > 0 && this.size.height > 0;
  }

  private schedule() {
    if (this.stopped || this.handle !== undefined) return;
    this.handle = this.scheduler.request((now) => this.tick(now));
  }

  private tick(now: number) {
    this.handle = undefined;
    if (this.stopped) return;
    try {
      if (this.pendingSize) {
        this.target.resize(this.pendingSize);
        this.pendingSize = undefined;
      }
      if (!this.hasArea) {
        // Paused until resize() gives the monitor an area again.
        this.onStats({ frames: this.frames, presented: false, width: 0, height: 0 });
        return;
      }
      const stats = this.target.frame(now);
      this.frames = stats.frames;
      if (now - this.lastReport >= this.reportInterval) {
        this.lastReport = now;
        this.onStats(stats);
      }
      this.schedule();
    } catch (error) {
      this.stop();
      this.onError(error instanceof Error ? error.message : String(error));
    }
  }
}

/** `requestAnimationFrame` where the worker has it, else a 60 Hz timer. */
export function workerScheduler(scope: typeof globalThis = globalThis): FrameScheduler {
  const raf = Reflect.get(scope, 'requestAnimationFrame') as
    ((callback: (now: number) => void) => number) | undefined;
  const caf = Reflect.get(scope, 'cancelAnimationFrame') as ((handle: number) => void) | undefined;
  if (raf && caf)
    return { request: (callback) => raf.call(scope, callback), cancel: (h) => caf.call(scope, h) };
  return {
    request: (callback) => setTimeout(() => callback(performance.now()), 16) as unknown as number,
    cancel: (handle) => clearTimeout(handle),
  };
}
