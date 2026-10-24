/**
 * The rate of a long job over its last few seconds, and the time it still needs
 * at that rate. Exports speed up and slow down with what each part of the
 * timeline holds, so the recent rate guesses better than the overall one.
 */
export class ProgressClock {
  private samples: { at: number; done: number }[] = [];

  constructor(private readonly windowMs = 5000) {}

  /** Records that `done` units were finished at time `at` (milliseconds). */
  record(done: number, at: number) {
    this.samples.push({ at, done });
    while (this.samples.length > 2 && at - this.samples[1].at >= this.windowMs)
      this.samples.shift();
  }

  /** Units a second lately, or null before half a second has passed. */
  rate(): number | null {
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    if (!first || last.at - first.at < 500 || last.done <= first.done) return null;
    return ((last.done - first.done) * 1000) / (last.at - first.at);
  }

  /** Milliseconds until `total` at the recent rate, or null while it is unknown. */
  remainingMs(total: number): number | null {
    const rate = this.rate();
    const last = this.samples[this.samples.length - 1];
    if (rate === null || !last) return null;
    return (Math.max(0, total - last.done) / rate) * 1000;
  }
}

/** "About 2 minutes left", "12 seconds left": what the progress bar says. */
export function remainingLabel(ms: number | null): string {
  if (ms === null) return 'Estimating time left…';
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${Math.max(1, seconds)} second${seconds === 1 ? '' : 's'} left`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `About ${minutes} minute${minutes === 1 ? '' : 's'} left`;
  const hours = Math.floor(minutes / 60);
  return `About ${hours} h ${minutes % 60} min left`;
}
