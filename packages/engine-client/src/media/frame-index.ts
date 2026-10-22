/**
 * Presentation timestamps (integer microseconds) of every frame of a video
 * track, in display order. Frame N is the Nth shown frame, whatever the
 * decode order (B-frames) or frame timing (variable frame rate).
 */
export class FrameIndex {
  private constructor(private readonly timestamps: number[]) {}

  /** Builds the index from packet timestamps in any order. */
  static fromTimestamps(timestamps: Iterable<number>): FrameIndex {
    const sorted = [...new Set(timestamps)].sort((a, b) => a - b);
    return new FrameIndex(sorted);
  }

  /** Reads packet metadata only (no sample data), which is cheap for MP4 and MOV. */
  static async fromPackets(packets: AsyncIterable<{ microsecondTimestamp: number }>) {
    const timestamps: number[] = [];
    for await (const packet of packets) timestamps.push(packet.microsecondTimestamp);
    return FrameIndex.fromTimestamps(timestamps);
  }

  get frameCount() {
    return this.timestamps.length;
  }

  timestampOf(frame: number): number {
    if (!Number.isInteger(frame) || frame < 0 || frame >= this.timestamps.length)
      throw new RangeError(`Frame ${frame} is outside 0..${this.timestamps.length - 1}`);
    return this.timestamps[frame];
  }

  /** The frame showing at `timestampUs`: the last one starting at or before it (0 before the first). */
  frameAt(timestampUs: number): number {
    let low = 0;
    let high = this.timestamps.length - 1;
    if (high < 0) return -1;
    if (timestampUs < this.timestamps[0]) return 0;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (this.timestamps[mid] <= timestampUs) low = mid;
      else high = mid - 1;
    }
    return low;
  }

  /** Mean frames per second over the whole track. */
  meanFrameRate(): number {
    const count = this.timestamps.length;
    if (count < 2) return 0;
    return ((count - 1) * 1e6) / (this.timestamps[count - 1] - this.timestamps[0]);
  }
}
