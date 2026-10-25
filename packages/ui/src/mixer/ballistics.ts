import { levelDb, type MeterLevel } from '@cgv/engine-client';

/** The meters' scale, in dBFS. */
export const meterFloor = -60;
export const meterTop = 3;
/** Peaks hold this long, then fall at this rate (an IEC peak meter's 20 dB in 1.7 s). */
export const holdMs = 1500;
export const fallDbPerSecond = 20 / 1.7;

/** Where `db` sits on a meter, 0 at the floor and 1 at the top. */
export function meterPosition(db: number) {
  return Math.min(1, Math.max(0, (db - meterFloor) / (meterTop - meterFloor)));
}

/** What one channel of a meter shows, in dBFS. */
export interface ChannelDisplay {
  /** The bar: the peak level, falling slowly. */
  peak: number;
  /** The RMS level (300 ms), shown inside the bar. */
  rms: number;
  /** The highest peak lately: held, then falling. */
  hold: number;
  /** A peak reached 0 dBFS or more since the meter was reset. */
  clipped: boolean;
}

/**
 * Display ballistics for a pair of channels: bars rise at once and fall at a
 * fixed rate, and the peak marker holds before it falls. The engine sends
 * levels; how they move on screen is the display's business.
 */
export class MeterBallistics {
  private channels: ChannelDisplay[] = [0, 1].map(() => ({
    peak: meterFloor,
    rms: meterFloor,
    hold: meterFloor,
    clipped: false,
  }));
  private heldAt = [0, 0];
  private last = 0;

  /** Moves on to `now` (ms), with a new reading or none (falling). */
  update(level: MeterLevel | null, now: number): ChannelDisplay[] {
    const fall = this.last ? ((now - this.last) / 1000) * fallDbPerSecond : 0;
    this.last = now;
    this.channels.forEach((channel, index) => {
      const peak = level ? levelDb(level.peak[index], meterFloor) : meterFloor;
      const rms = level ? levelDb(level.rms[index], meterFloor) : meterFloor;
      channel.peak = Math.max(peak, channel.peak - fall);
      channel.rms = level ? rms : Math.max(meterFloor, channel.rms - fall);
      if (peak >= channel.hold) {
        channel.hold = peak;
        this.heldAt[index] = now;
      } else if (now - this.heldAt[index] > holdMs) {
        channel.hold = Math.max(peak, meterFloor, channel.hold - fall);
      }
      if (peak >= 0) channel.clipped = true;
    });
    return this.channels;
  }

  /** Every channel has fallen to the floor. */
  get resting() {
    return this.channels.every((c) => c.peak <= meterFloor && c.hold <= meterFloor);
  }

  resetClip() {
    for (const channel of this.channels) channel.clipped = false;
  }
}
