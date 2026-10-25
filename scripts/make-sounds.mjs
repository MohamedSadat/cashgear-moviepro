// Writes the built-in sound library (assets/sounds/*.webm and sounds.json): sound
// effects and music beds synthesised here, sample by sample, and encoded as Opus
// by the pinned LGPL FFmpeg. Nothing is recorded or sampled, so no licences are
// involved. Every sound is seeded, so a run gives the same files. Run it after
// changing a sound; the outputs are committed.
import { spawnSync } from 'node:child_process';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ffmpegTool, root } from './lib.mjs';

const RATE = 48_000;
const out = join(root, 'assets/sounds');
const work = join(root, '.tools/sound-build');

// ---- Building blocks ----

/** Repeatable noise and choices. */
function random(seed) {
  let state = (seed * 2654435761) >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4294967296;
  };
}

const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);
const db = (value) => 10 ** (value / 20);
const TAU = Math.PI * 2;

/** A stereo buffer that sounds are added into. */
class Track {
  constructor(seconds) {
    this.length = Math.round(seconds * RATE);
    this.left = new Float32Array(this.length);
    this.right = new Float32Array(this.length);
  }

  /** Adds mono `samples` at `seconds`, with a gain and a pan from -1 to 1. */
  add(seconds, samples, gain = 1, pan = 0) {
    const at = Math.round(seconds * RATE);
    const angle = ((pan + 1) * Math.PI) / 4;
    const [l, r] = [Math.cos(angle) * Math.SQRT2 * gain, Math.sin(angle) * Math.SQRT2 * gain];
    for (let i = 0; i < samples.length && at + i < this.length; i++) {
      if (at + i < 0) continue;
      this.left[at + i] += samples[i] * Math.min(1, l);
      this.right[at + i] += samples[i] * Math.min(1, r);
    }
  }

  /** Adds another track, scaled. */
  mix(other, gain = 1) {
    for (let i = 0; i < Math.min(this.length, other.length); i++) {
      this.left[i] += other.left[i] * gain;
      this.right[i] += other.right[i] * gain;
    }
  }
}

/** Samples of `seconds`, each from `fn(t, i)`. */
function render(seconds, fn) {
  const samples = new Float32Array(Math.max(1, Math.round(seconds * RATE)));
  for (let i = 0; i < samples.length; i++) samples[i] = fn(i / RATE, i);
  return samples;
}

/** Attack, decay to sustain, release: a gain from 0 to 1 at time `t` of a note `length` long. */
function adsr(t, length, a, d, s, r) {
  if (t < a) return t / a;
  if (t < a + d) return 1 - ((1 - s) * (t - a)) / d;
  if (t < length) return s;
  return Math.max(0, s * (1 - (t - length) / r));
}

/** A band-limited sawtooth by its first harmonics. */
function saw(phase, frequency) {
  const harmonics = Math.max(1, Math.min(30, Math.floor(RATE / 2 / frequency)));
  let value = 0;
  for (let h = 1; h <= harmonics; h++) value += Math.sin(phase * h) / h;
  return value * 0.6;
}

function square(phase, frequency) {
  const harmonics = Math.max(1, Math.min(30, Math.floor(RATE / 2 / frequency)));
  let value = 0;
  for (let h = 1; h <= harmonics; h += 2) value += Math.sin(phase * h) / h;
  return value * 0.8;
}

/** An RBJ biquad over `samples`, in place. */
function biquad(samples, kind, frequency, q = 0.707) {
  const w = (TAU * Math.min(frequency, RATE * 0.45)) / RATE;
  const alpha = Math.sin(w) / (2 * q);
  const cos = Math.cos(w);
  const coefficients = {
    low: [(1 - cos) / 2, 1 - cos, (1 - cos) / 2],
    high: [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2],
    band: [alpha, 0, -alpha],
  }[kind];
  const [b0, b1, b2] = coefficients;
  const [a0, a1, a2] = [1 + alpha, -2 * cos, 1 - alpha];
  let [x1, x2, y1, y2] = [0, 0, 0, 0];
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i];
    const y = (b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    [x2, x1, y2, y1] = [x1, x, y1, y];
    samples[i] = y;
  }
  return samples;
}

function noise(seconds, seed) {
  const next = random(seed);
  return render(seconds, () => next() * 2 - 1);
}

/** A glide: phase of a frequency that moves from `from` to `to` over `seconds`. */
function glide(seconds, from, to, shape = (p) => p, wave = Math.sin) {
  let phase = 0;
  return render(seconds, (t) => {
    const f = from + (to - from) * shape(Math.min(1, t / seconds));
    phase += (TAU * f) / RATE;
    return wave(phase, f);
  });
}

// ---- Instruments ----

const instruments = {
  kick(gain = 1) {
    let phase = 0;
    return render(0.45, (t) => {
      const f = 45 + 110 * Math.exp(-t * 28);
      phase += (TAU * f) / RATE;
      return gain * Math.sin(phase) * Math.exp(-t * 7) * (t < 0.002 ? t / 0.002 : 1);
    });
  },
  snare(seed, gain = 1) {
    const hiss = biquad(noise(0.25, seed), 'high', 1800);
    let phase = 0;
    return render(0.25, (t, i) => {
      phase += (TAU * 185) / RATE;
      return (
        gain * (0.55 * hiss[i] * Math.exp(-t * 18) + 0.5 * Math.sin(phase) * Math.exp(-t * 30))
      );
    });
  },
  hat(seed, open = false, gain = 1) {
    const hiss = biquad(noise(open ? 0.35 : 0.08, seed), 'high', 7000);
    const decay = open ? 9 : 60;
    return render(open ? 0.35 : 0.08, (t, i) => gain * 0.35 * hiss[i] * Math.exp(-t * decay));
  },
  clap(seed, gain = 1) {
    const hiss = biquad(noise(0.3, seed), 'band', 1500, 0.8);
    return render(0.3, (t, i) => {
      const bursts = [0, 0.011, 0.022].some((at) => t >= at && t < at + 0.008) ? 1 : 0;
      return gain * hiss[i] * (bursts + Math.exp(-(t - 0.022) * 14) * (t > 0.022 ? 1 : 0)) * 0.8;
    });
  },
  /** A plucked string (Karplus-Strong). */
  pluck(midi, seconds, seed, bright = 0.5) {
    const period = Math.round(RATE / hz(midi));
    const next = random(seed);
    const line = Float32Array.from({ length: period }, () => next() * 2 - 1);
    let index = 0;
    let last = 0;
    return render(seconds, (t) => {
      const current = line[index];
      const following = line[(index + 1) % period];
      const value = (current + following) * 0.5 * (0.994 + bright * 0.005);
      line[index] = value * 0.5 + last * 0.5 * (1 - bright) + value * 0.5 * bright;
      last = value;
      index = (index + 1) % period;
      return current * Math.min(1, (seconds - t) * 20);
    });
  },
  /** An electric piano: two-operator FM with a fading index. */
  epiano(midi, seconds) {
    const f = hz(midi);
    let [carrier, modulator] = [0, 0];
    return render(seconds + 0.6, (t) => {
      modulator += (TAU * f) / RATE;
      const index = 1.6 * Math.exp(-t * 3);
      carrier += (TAU * f) / RATE;
      return (
        Math.sin(carrier + index * Math.sin(modulator)) *
        adsr(t, seconds, 0.004, 1.2, 0.35, 0.5) *
        0.5
      );
    });
  },
  bell(midi, seconds, ratio = 3.5) {
    const f = hz(midi);
    let [carrier, modulator] = [0, 0];
    return render(seconds, (t) => {
      modulator += (TAU * f * ratio) / RATE;
      carrier += (TAU * f) / RATE;
      return (
        Math.sin(carrier + 2.4 * Math.exp(-t * 4) * Math.sin(modulator)) * Math.exp(-t * 2.6) * 0.5
      );
    });
  },
  /** A piano-like tone: decaying harmonics, the higher ones faster. */
  keys(midi, seconds) {
    const f = hz(midi);
    return render(seconds + 1, (t) => {
      let value = 0;
      for (let h = 1; h <= 6; h++)
        value +=
          (Math.sin(TAU * f * h * t * (1 + 0.0004 * h * h)) / h ** 1.4) *
          Math.exp(-t * (1.2 + h * 0.9));
      return (
        value *
        0.45 *
        Math.min(1, t / 0.003) *
        (t > seconds ? Math.max(0, 1 - (t - seconds) * 4) : 1)
      );
    });
  },
  /** A pad: detuned sawtooths through a soft low-pass, slow in and out. */
  pad(midis, seconds, cutoff = 1800, attack = 0.8) {
    const voices = midis.flatMap((m) => [hz(m) * 0.997, hz(m) * 1.003]);
    const phases = voices.map(() => 0);
    const samples = render(seconds + 1.2, (t) => {
      let value = 0;
      voices.forEach((f, v) => {
        phases[v] += (TAU * f) / RATE;
        value += saw(phases[v], f);
      });
      return (value / voices.length) * adsr(t, seconds, attack, 0.5, 0.85, 1.2);
    });
    return biquad(biquad(samples, 'low', cutoff), 'low', cutoff * 1.4);
  },
  bass(midi, seconds, wave = 'saw') {
    const f = hz(midi);
    let phase = 0;
    const samples = render(seconds + 0.08, (t) => {
      phase += (TAU * f) / RATE;
      const tone =
        wave === 'sine' ? Math.sin(phase) : wave === 'square' ? square(phase, f) : saw(phase, f);
      return tone * adsr(t, seconds, 0.005, 0.15, 0.7, 0.08) * 0.6;
    });
    return biquad(samples, 'low', wave === 'sine' ? 400 : 700);
  },
  lead(midi, seconds, wave = 'square') {
    const f = hz(midi);
    let phase = 0;
    const samples = render(seconds + 0.15, (t) => {
      const vibrato = 1 + 0.004 * Math.sin(TAU * 5.5 * t) * Math.min(1, t * 3);
      phase += (TAU * f * vibrato) / RATE;
      const tone =
        wave === 'sine' ? Math.sin(phase) : wave === 'saw' ? saw(phase, f) : square(phase, f);
      return tone * adsr(t, seconds, 0.01, 0.1, 0.75, 0.15) * 0.35;
    });
    return biquad(samples, 'low', 3500);
  },
  timpani(midi, seconds = 2) {
    let phase = 0;
    const hiss = biquad(noise(0.2, midi), 'low', 600);
    return render(seconds, (t, i) => {
      phase += (TAU * hz(midi) * (1 + 0.15 * Math.exp(-t * 20))) / RATE;
      return (
        (Math.sin(phase) * Math.exp(-t * 2.2) +
          (i < hiss.length ? hiss[i] * Math.exp(-t * 25) : 0)) *
        0.7
      );
    });
  },
};

/** A stereo reverb (four combs and two all-passes a side), mixed into `track`. */
function reverb(track, amount = 0.25, size = 0.8) {
  const combs = [1557, 1617, 1491, 1422];
  const allpasses = [225, 556];
  const run = (input, spread) => {
    const output = new Float32Array(input.length);
    for (const length of combs) {
      const buffer = new Float32Array(length + spread);
      let [index, store] = [0, 0];
      for (let i = 0; i < input.length; i++) {
        const delayed = buffer[index];
        store = delayed * 0.7 + store * 0.3;
        buffer[index] = input[i] * 0.03 + store * (0.7 + 0.28 * size);
        index = (index + 1) % buffer.length;
        output[i] += delayed;
      }
    }
    for (const length of allpasses) {
      const buffer = new Float32Array(length + spread);
      let index = 0;
      for (let i = 0; i < output.length; i++) {
        const delayed = buffer[index];
        buffer[index] = output[i] + delayed * 0.5;
        output[i] = delayed - output[i];
        index = (index + 1) % buffer.length;
      }
    }
    return output;
  };
  const left = run(track.left, 0);
  const right = run(track.right, 23);
  for (let i = 0; i < track.length; i++) {
    track.left[i] += left[i] * amount;
    track.right[i] += right[i] * amount;
  }
  return track;
}

/** Scales a track so its loudest moment is near `peakDb`, and fades its last `fade` seconds. */
function finish(track, peakDb = -1.5, fade = 0.02) {
  let peak = 0;
  for (let i = 0; i < track.length; i++)
    peak = Math.max(peak, Math.abs(track.left[i]), Math.abs(track.right[i]));
  const gain = peak > 0 ? db(peakDb) / peak : 1;
  const fadeFrames = Math.round(fade * RATE);
  for (let i = 0; i < track.length; i++) {
    const tail = Math.min(1, (track.length - i) / fadeFrames, (i + 1) / 64);
    track.left[i] = Math.tanh(track.left[i] * gain * 1.05) * tail;
    track.right[i] = Math.tanh(track.right[i] * gain * 1.05) * tail;
  }
  return track;
}

/** One sound as a stereo track. */
function mono(samples, gain = 1) {
  const track = new Track(samples.length / RATE);
  track.add(0, samples, gain);
  return track;
}

// ---- Sound effects ----

const effects = [
  [
    'whoosh',
    'Whoosh',
    'Transitions',
    () => {
      const swept = noise(1.2, 1);
      const out = new Float32Array(swept.length);
      for (let i = 0; i < swept.length; i++) {
        const p = i / swept.length;
        out[i] = swept[i] * Math.sin(Math.PI * p) ** 2;
      }
      // A band that rises then falls.
      const low = biquad(Float32Array.from(out), 'band', 600, 0.7);
      const high = biquad(Float32Array.from(out), 'band', 2400, 0.7);
      const track = new Track(1.2);
      track.add(
        0,
        render(1.2, (t, i) => low[i] * (1 - t / 1.2) + high[i] * (t / 1.2)),
        1,
        -0.4,
      );
      track.add(
        0.02,
        render(1.2, (t, i) => low[i] * (t / 1.2) + high[i] * (1 - t / 1.2)),
        1,
        0.4,
      );
      return finish(track, -3);
    },
  ],
  [
    'swoosh',
    'Swoosh',
    'Transitions',
    () => {
      const hiss = biquad(noise(0.45, 2), 'band', 3000, 0.9);
      return finish(
        mono(render(0.45, (t, i) => hiss[i] * Math.sin((Math.PI * t) / 0.45) ** 3)),
        -3,
      );
    },
  ],
  [
    'riser',
    'Riser',
    'Transitions',
    () => {
      const track = new Track(3.2);
      const hiss = biquad(noise(3.2, 3), 'high', 1200);
      track.add(
        0,
        render(3.2, (t, i) => hiss[i] * (t / 3.2) ** 2 * 0.6),
      );
      track.add(
        0,
        glide(3.2, 200, 1600, (p) => p * p, saw).map(
          (v, i) => v * (i / (3.2 * RATE)) ** 1.5 * 0.35,
        ),
      );
      return finish(reverb(track, 0.25), -2);
    },
  ],
  [
    'downlifter',
    'Downlifter',
    'Transitions',
    () => {
      const track = new Track(2.5);
      track.add(
        0,
        glide(2.5, 1200, 80, (p) => Math.sqrt(p), saw).map(
          (v, i) => v * (1 - i / (2.5 * RATE)) * 0.4,
        ),
      );
      return finish(reverb(track, 0.3), -2);
    },
  ],
  [
    'reverse-cymbal',
    'Reverse cymbal',
    'Transitions',
    () => {
      const hiss = biquad(noise(2, 4), 'high', 5000);
      return finish(mono(render(2, (t, i) => hiss[i] * (t / 2) ** 3)), -3);
    },
  ],
  [
    'impact',
    'Impact',
    'Impacts',
    () => {
      const track = new Track(2.5);
      track.add(
        0,
        glide(2.5, 90, 35, (p) => Math.sqrt(p)).map((v, i) => v * Math.exp((-i / RATE) * 2.5)),
      );
      track.add(
        0,
        biquad(noise(0.4, 5), 'low', 900).map((v, i) => v * Math.exp((-i / RATE) * 12) * 0.8),
      );
      return finish(reverb(track, 0.3), -1);
    },
  ],
  ['hit', 'Hit', 'Impacts', () => finish(mono(instruments.kick(1)), -1)],
  [
    'boom',
    'Deep boom',
    'Impacts',
    () => {
      const track = new Track(3);
      track.add(
        0,
        glide(3, 60, 28).map((v, i) => v * Math.exp((-i / RATE) * 1.5)),
      );
      return finish(reverb(track, 0.4), -1);
    },
  ],
  [
    'glitch',
    'Glitch',
    'Impacts',
    () => {
      const next = random(6);
      const track = new Track(0.6);
      for (let at = 0; at < 0.55; at += 0.03 + next() * 0.04) {
        const f = 200 + next() * 2000;
        track.add(
          at,
          render(0.025, (t) => (Math.sin(TAU * f * t) > 0 ? 0.4 : -0.4)),
          1,
          next() * 2 - 1,
        );
      }
      return finish(track, -3);
    },
  ],
  [
    'tape-stop',
    'Tape stop',
    'Impacts',
    () => {
      const track = new Track(1);
      for (const m of [57, 60, 64])
        track.add(
          0,
          glide(1, hz(m), hz(m) * 0.1, (p) => p * p, saw).map((v, i) => v * (1 - i / RATE) * 0.3),
        );
      return finish(track, -2);
    },
  ],
  [
    'click',
    'Click',
    'Interface',
    () => finish(mono(render(0.03, (t) => Math.sin(TAU * 2400 * t) * Math.exp(-t * 300))), -3),
  ],
  [
    'pop',
    'Pop',
    'Interface',
    () =>
      finish(
        mono(
          glide(0.12, 900, 300, (p) => Math.sqrt(p)).map((v, i) => v * Math.exp((-i / RATE) * 30)),
        ),
        -2,
      ),
  ],
  ['ding', 'Ding', 'Interface', () => finish(mono(instruments.bell(84, 1.8)), -2)],
  [
    'chime',
    'Chime',
    'Interface',
    () => {
      const track = new Track(2);
      [76, 79, 84].forEach((m, k) =>
        track.add(k * 0.12, instruments.bell(m, 1.6, 2), 0.8, (k - 1) * 0.4),
      );
      return finish(reverb(track, 0.2), -2);
    },
  ],
  [
    'notification',
    'Notification',
    'Interface',
    () => {
      const track = new Track(0.8);
      track.add(0, instruments.bell(81, 0.6, 1));
      track.add(0.15, instruments.bell(88, 0.6, 1));
      return finish(track, -2);
    },
  ],
  [
    'success',
    'Success',
    'Interface',
    () => {
      const track = new Track(1.5);
      [72, 76, 79, 84].forEach((m, k) => track.add(k * 0.08, instruments.keys(m, 0.6), 0.7));
      return finish(reverb(track, 0.2), -2);
    },
  ],
  [
    'error',
    'Error',
    'Interface',
    () => {
      const track = new Track(0.6);
      for (const at of [0, 0.22])
        track.add(
          at,
          biquad(
            render(0.16, (t) => square(TAU * 140 * t, 140) * 0.5),
            'low',
            1500,
          ),
        );
      return finish(track, -3);
    },
  ],
  [
    'coin',
    'Coin',
    'Interface',
    () => {
      const track = new Track(0.5);
      track.add(
        0,
        render(0.07, (t) => square(TAU * hz(83) * t, hz(83)) * 0.4),
      );
      track.add(
        0.07,
        render(0.35, (t) => square(TAU * hz(88) * t, hz(88)) * 0.4 * Math.exp(-t * 6)),
      );
      return finish(track, -3);
    },
  ],
  [
    'typing',
    'Typing',
    'Interface',
    () => {
      const next = random(7);
      const track = new Track(2);
      for (let at = 0.05; at < 1.9; at += 0.08 + next() * 0.12) {
        const key = biquad(noise(0.03, Math.floor(at * 1000)), 'band', 2500 + next() * 1500, 1.5);
        track.add(
          at,
          key.map((v, i) => v * Math.exp((-i / RATE) * 120) * 2),
          1,
          next() - 0.5,
        );
      }
      return finish(track, -4);
    },
  ],
  [
    'shutter',
    'Camera shutter',
    'Interface',
    () => {
      const track = new Track(0.35);
      for (const at of [0, 0.12])
        track.add(
          at,
          biquad(noise(0.06, at * 100 + 9), 'band', 3000, 0.8).map(
            (v, i) => v * Math.exp((-i / RATE) * 60),
          ),
        );
      return finish(track, -3);
    },
  ],
  [
    'swipe',
    'Swipe',
    'Interface',
    () => {
      const hiss = biquad(noise(0.25, 10), 'high', 3000);
      return finish(mono(render(0.25, (t, i) => hiss[i] * Math.sin((Math.PI * t) / 0.25))), -4);
    },
  ],
  [
    'boing',
    'Boing',
    'Comedy',
    () =>
      finish(
        mono(
          glide(0.9, 120, 480, (p) => Math.sqrt(p)).map((v, i) => {
            const t = i / RATE;
            return v * Math.exp(-t * 3) * (1 + 0.3 * Math.sin(TAU * 14 * t));
          }),
        ),
        -2,
      ),
  ],
  [
    'slide-whistle',
    'Slide whistle',
    'Comedy',
    () =>
      finish(
        mono(
          glide(1.2, 500, 1600, (p) => 0.5 - 0.5 * Math.cos(Math.PI * p)).map(
            (v, i) => v * adsr(i / RATE, 1.1, 0.05, 0.1, 0.9, 0.1) * 0.5,
          ),
        ),
        -3,
      ),
  ],
  [
    'drum-roll',
    'Drum roll',
    'Comedy',
    () => {
      const track = new Track(2.6);
      for (let at = 0; at < 2; at += 0.045)
        track.add(at, instruments.snare(Math.floor(at * 1000), 0.25 + 0.35 * (at / 2)));
      track.add(2.05, instruments.snare(99, 0.9));
      track.add(2.05, instruments.hat(98, true, 1.2));
      return finish(track, -2);
    },
  ],
  [
    'ta-da',
    'Ta-da',
    'Comedy',
    () => {
      const track = new Track(2);
      track.add(0, instruments.pad([67, 71, 74], 0.12, 4000, 0.01), 0.8);
      track.add(0.18, instruments.pad([72, 76, 79, 84], 1.2, 4000, 0.01), 1);
      return finish(reverb(track, 0.25), -2);
    },
  ],
  [
    'laser',
    'Laser',
    'Comedy',
    () =>
      finish(
        mono(
          glide(0.4, 2200, 300, (p) => Math.sqrt(p), square).map(
            (v, i) => v * Math.exp((-i / RATE) * 6) * 0.5,
          ),
        ),
        -3,
      ),
  ],
  [
    'rain',
    'Rain',
    'Nature',
    () => {
      const track = new Track(8);
      const next = random(11);
      const bed = biquad(noise(8, 12), 'low', 5000);
      track.add(
        0,
        bed.map((v) => v * 0.15),
        1,
        -0.3,
      );
      track.add(
        0,
        biquad(noise(8, 13), 'low', 5000).map((v) => v * 0.15),
        1,
        0.3,
      );
      for (let k = 0; k < 400; k++) {
        const drop = biquad(noise(0.02, 1000 + k), 'band', 2000 + next() * 4000, 2);
        track.add(
          next() * 7.9,
          drop.map((v, i) => v * Math.exp((-i / RATE) * 200)),
          0.6,
          next() * 2 - 1,
        );
      }
      return finish(track, -6, 0.5);
    },
  ],
  [
    'wind',
    'Wind',
    'Nature',
    () => {
      const track = new Track(8);
      for (const [pan, seed] of [
        [-0.5, 14],
        [0.5, 15],
      ]) {
        const bed = biquad(noise(8, seed), 'band', 500, 0.6);
        track.add(
          0,
          bed.map((v, i) => v * (0.6 + 0.4 * Math.sin((TAU * i) / RATE / (2.7 + seed / 10)))),
          1,
          pan,
        );
      }
      return finish(track, -6, 0.5);
    },
  ],
  [
    'heartbeat',
    'Heartbeat',
    'Nature',
    () => {
      const track = new Track(3);
      for (let at = 0; at < 2.8; at += 0.9) {
        track.add(at, instruments.kick(0.9));
        track.add(at + 0.25, instruments.kick(0.6));
      }
      return finish(biquadTrack(track, 'low', 300), -2);
    },
  ],
  [
    'clock',
    'Clock ticking',
    'Nature',
    () => {
      const track = new Track(4);
      for (let k = 0; k < 8; k++) {
        const f = k % 2 ? 2200 : 1800;
        track.add(
          k * 0.5,
          render(0.04, (t) => Math.sin(TAU * f * t) * Math.exp(-t * 150)),
          1,
          k % 2 ? 0.3 : -0.3,
        );
      }
      return finish(track, -4);
    },
  ],
];

function biquadTrack(track, kind, frequency) {
  biquad(track.left, kind, frequency);
  biquad(track.right, kind, frequency);
  return track;
}

// ---- Music ----

/** Beats of `bpm` as seconds. */
const beats = (bpm) => (count) => (count * 60) / bpm;

/** Drums from patterns of 16 steps a bar ('x' hits). */
function drums(track, bpm, bars, patterns, seed = 1, gains = {}) {
  const step = beats(bpm)(0.25);
  let s = seed;
  for (let bar = 0; bar < bars; bar++)
    for (let i = 0; i < 16; i++) {
      const at = (bar * 16 + i) * step;
      if (patterns.kick?.[i] === 'x') track.add(at, instruments.kick(gains.kick ?? 0.9));
      if (patterns.snare?.[i] === 'x')
        track.add(at, instruments.snare(s++, gains.snare ?? 0.6), 1, 0.05);
      if (patterns.clap?.[i] === 'x')
        track.add(at, instruments.clap(s++, gains.clap ?? 0.5), 1, -0.05);
      if (patterns.hat?.[i] === 'x')
        track.add(at, instruments.hat(s++, false, gains.hat ?? 0.6), 1, 0.3);
      if (patterns.open?.[i] === 'x')
        track.add(at, instruments.hat(s++, true, gains.open ?? 0.5), 1, -0.3);
    }
}

/** Chords (MIDI notes) a bar each, played by `voice(notes, at, seconds)`. */
function progression(chords, bars, bpm, voice) {
  const bar = beats(bpm)(4);
  for (let k = 0; k < bars; k++) voice(chords[k % chords.length], k * bar, bar);
}

const C = (root, kind = 'maj') =>
  ({ maj: [0, 4, 7], min: [0, 3, 7], maj7: [0, 4, 7, 11], min7: [0, 3, 7, 10], sus: [0, 5, 7] })[
    kind
  ].map((n) => root + n);

const music = [
  [
    'sunny-steps',
    'Sunny Steps',
    'Upbeat',
    120,
    16,
    (bpm, bars) => {
      const track = new Track(beats(bpm)(bars * 4) + 2);
      drums(track, bpm, bars, {
        kick: 'x...x...x...x...',
        clap: '....x.......x...',
        hat: '..x...x...x...x.',
      });
      const chords = [C(60), C(67), C(57, 'min'), C(65)];
      progression(chords, bars, bpm, (notes, at, bar) => {
        for (const beat of [0, 1.5, 2.5])
          track.add(
            at + beats(bpm)(beat),
            instruments.pad(notes, beats(bpm)(0.6), 3000, 0.01),
            0.35,
            0.2,
          );
        track.add(at, instruments.bass(notes[0] - 24, bar * 0.45), 0.8);
        track.add(at + bar / 2, instruments.bass(notes[0] - 24, bar * 0.45), 0.8);
      });
      const melody = [72, 74, 76, 79, 76, 74, 72, 69];
      for (let k = 0; k < bars * 2; k++)
        if (k % 8 < 6)
          track.add(
            k * beats(bpm)(2),
            instruments.lead(melody[k % 8], beats(bpm)(1.5), 'square'),
            0.25,
            -0.2,
          );
      return finish(reverb(track, 0.15), -1.5, 1.5);
    },
  ],
  [
    'lofi-evening',
    'Lo-fi Evening',
    'Chill',
    80,
    12,
    (bpm, bars) => {
      const track = new Track(beats(bpm)(bars * 4) + 2.5);
      drums(
        track,
        bpm,
        bars,
        { kick: 'x......x..x.....', snare: '....x.......x...', hat: 'x.x.x.x.x.x.x.x.' },
        3,
        { hat: 0.3, snare: 0.45 },
      );
      const chords = [
        C(62, 'min7'),
        C(67, 'maj7').map((n) => n - 12),
        C(60, 'maj7'),
        C(57, 'min7'),
      ];
      progression(chords, bars, bpm, (notes, at, bar) => {
        for (const n of notes)
          track.add(at, instruments.epiano(n, bar * 0.9), 0.3, (n % 3) / 3 - 0.3);
        track.add(at, instruments.bass(notes[0] - 24, bar * 0.8, 'sine'), 0.9);
      });
      const crackle = random(21);
      for (let k = 0; k < bars * 40; k++)
        track.add(
          crackle() * (track.length / RATE - 0.1),
          render(0.003, () => (crackle() - 0.5) * 0.2),
          1,
          crackle() - 0.5,
        );
      return finish(biquadTrack(reverb(track, 0.25), 'low', 7000), -1.5, 2);
    },
  ],
  [
    'corporate-bright',
    'Corporate Bright',
    'Business',
    110,
    16,
    (bpm, bars) => {
      const track = new Track(beats(bpm)(bars * 4) + 2);
      drums(
        track,
        bpm,
        bars,
        { kick: 'x.......x.......', clap: '....x.......x...', hat: 'xxxxxxxxxxxxxxxx' },
        5,
        { hat: 0.2, kick: 0.7, clap: 0.35 },
      );
      const chords = [C(60, 'sus'), C(60), C(65), C(67)];
      progression(chords, bars, bpm, (notes, at, bar) => {
        track.add(
          at,
          instruments.pad(
            notes.map((n) => n - 12),
            bar,
            1400,
            0.4,
          ),
          0.3,
        );
        for (let i = 0; i < 8; i++)
          track.add(
            at + (i * bar) / 8,
            instruments.keys(notes[i % notes.length] + (i >= 4 ? 12 : 0), bar / 8),
            0.4,
            i % 2 ? 0.3 : -0.3,
          );
        track.add(at, instruments.bass(notes[0] - 24, bar * 0.9, 'sine'), 0.7);
      });
      return finish(reverb(track, 0.2), -1.5, 1.5);
    },
  ],
  [
    'ambient-drift',
    'Ambient Drift',
    'Ambient',
    60,
    10,
    (bpm, bars) => {
      const track = new Track(beats(bpm)(bars * 4) + 4);
      const chords = [C(57, 'min7'), C(53, 'maj7'), C(60, 'maj7'), C(55, 'sus')];
      progression(chords, bars, bpm, (notes, at, bar) => {
        track.add(
          at,
          instruments.pad(notes, bar, 900 + 400 * Math.sin(at), 2.5),
          0.5,
          Math.sin(at) * 0.4,
        );
        track.add(at + bar * 0.5, instruments.bell(notes[2] + 24, 3, 2), 0.12, -Math.sin(at) * 0.5);
      });
      return finish(reverb(track, 0.5, 0.95), -2, 3);
    },
  ],
  [
    'cinematic-rise',
    'Cinematic Rise',
    'Cinematic',
    90,
    16,
    (bpm, bars) => {
      const track = new Track(beats(bpm)(bars * 4) + 4);
      const chords = [C(50, 'min'), C(46), C(53), C(48)];
      progression(chords, bars, bpm, (notes, at, bar) => {
        const swell = at / beats(bpm)(bars * 4);
        track.add(
          at,
          instruments.pad([...notes, notes[0] + 12], bar, 1200 + 2500 * swell, 0.9),
          0.35 + 0.4 * swell,
        );
        for (let i = 0; i < 4; i++)
          if (swell > 0.4 || i === 0)
            track.add(
              at + (i * bar) / 4,
              instruments.timpani(notes[0] - 12, 1.5),
              0.4 + 0.5 * swell,
            );
      });
      return finish(reverb(track, 0.4, 0.9), -1.5, 3);
    },
  ],
  [
    'boom-bap',
    'Boom Bap',
    'Hip-hop',
    90,
    16,
    (bpm, bars) => {
      const track = new Track(beats(bpm)(bars * 4) + 2);
      drums(
        track,
        bpm,
        bars,
        { kick: 'x.....x.x.......', snare: '....x.......x...', hat: 'x.x.x.x.x.x.x.x.' },
        7,
        { kick: 1, hat: 0.35 },
      );
      const chords = [C(57, 'min7'), C(57, 'min7'), C(53, 'maj7'), C(55)];
      progression(chords, bars, bpm, (notes, at, bar) => {
        track.add(at, instruments.keys(notes[0], bar * 0.4), 0.35);
        for (const n of notes.slice(1))
          track.add(at + bar * 0.125, instruments.keys(n, bar * 0.3), 0.25);
        track.add(at, instruments.bass(notes[0] - 24, bar * 0.35, 'sine'), 1);
        track.add(at + bar * 0.625, instruments.bass(notes[0] - 24, bar * 0.2, 'sine'), 0.9);
      });
      return finish(reverb(track, 0.12), -1.5, 1.5);
    },
  ],
  [
    'electro-pulse',
    'Electro Pulse',
    'Electronic',
    124,
    16,
    (bpm, bars) => {
      const track = new Track(beats(bpm)(bars * 4) + 2);
      drums(
        track,
        bpm,
        bars,
        { kick: 'x...x...x...x...', clap: '....x.......x...', open: '..x...x...x...x.' },
        9,
        { open: 0.35 },
      );
      const chords = [C(57, 'min'), C(53), C(60), C(55)];
      const sixteenth = beats(bpm)(0.25);
      progression(chords, bars, bpm, (notes, at) => {
        for (let i = 0; i < 16; i++) {
          // The bass ducks after each kick: the pumping of the style.
          const pump = (i % 4) / 4;
          track.add(
            at + i * sixteenth,
            instruments.bass(notes[0] - 24 + (i % 8 === 6 ? 12 : 0), sixteenth * 0.8),
            0.35 + 0.5 * pump,
          );
          if (i % 2 === 0)
            track.add(
              at + i * sixteenth,
              instruments.pluck(notes[(i / 2) % 3] + 12, sixteenth * 2, i, 0.9),
              0.3,
              i % 4 ? 0.4 : -0.4,
            );
        }
      });
      return finish(reverb(track, 0.15), -1.5, 1.5);
    },
  ],
  [
    'acoustic-morning',
    'Acoustic Morning',
    'Acoustic',
    100,
    16,
    (bpm, bars) => {
      const track = new Track(beats(bpm)(bars * 4) + 2.5);
      const chords = [C(55), C(50), C(52, 'min'), C(48)];
      const strum = beats(bpm)(0.5);
      progression(chords, bars, bpm, (notes, at) => {
        const voicing = [notes[0] - 12, notes[0] - 5, notes[0], notes[1], notes[2], notes[0] + 12];
        for (let i = 0; i < 8; i++) {
          if ([3, 7].includes(i)) continue;
          voicing.forEach((n, s) =>
            track.add(
              at + i * strum + (i % 2 ? 5 - s : s) * 0.012,
              instruments.pluck(n, 1.4, i * 7 + s, 0.4),
              0.18,
              (s - 2.5) / 5,
            ),
          );
        }
      });
      const shake = random(31);
      for (let k = 0; k < bars * 8; k++)
        track.add(k * strum, instruments.hat(1000 + k, false, 0.25 + shake() * 0.1), 1, 0.5);
      return finish(reverb(track, 0.25), -1.5, 2);
    },
  ],
  [
    'happy-ukulele',
    'Happy Ukulele',
    'Acoustic',
    128,
    16,
    (bpm, bars) => {
      const track = new Track(beats(bpm)(bars * 4) + 2);
      const chords = [C(60), C(57, 'min'), C(65), C(67)];
      progression(chords, bars, bpm, (notes, at) => {
        for (let i = 0; i < 8; i++)
          notes.forEach((n, s) =>
            track.add(
              at + i * beats(bpm)(0.5) + s * 0.008,
              instruments.pluck(n + 12, 0.5, i * 5 + s, 0.7),
              0.17,
              (s - 1) / 3,
            ),
          );
      });
      drums(track, bpm, bars, { clap: '....x.......x...', kick: 'x.......x.......' }, 13, {
        kick: 0.6,
        clap: 0.4,
      });
      const whistle = [79, 81, 79, 76, 79, 84, 83, 79];
      for (let k = 4; k < bars * 2; k++)
        if (k % 4 !== 3)
          track.add(
            k * beats(bpm)(2),
            instruments.lead(whistle[k % 8], beats(bpm)(1.2), 'sine'),
            0.35,
            0.2,
          );
      return finish(reverb(track, 0.18), -1.5, 1.5);
    },
  ],
  [
    'suspense-pulse',
    'Suspense Pulse',
    'Cinematic',
    100,
    12,
    (bpm, bars) => {
      const track = new Track(beats(bpm)(bars * 4) + 3);
      const length = beats(bpm)(bars * 4);
      track.add(0, instruments.pad([38, 45], length, 500, 3), 0.6);
      for (let k = 0; k < bars * 8; k++)
        track.add(
          k * beats(bpm)(0.5),
          render(0.05, (t) => Math.sin(TAU * 1100 * t) * Math.exp(-t * 80)),
          0.25,
          k % 2 ? 0.4 : -0.4,
        );
      for (let k = 0; k < bars; k += 2)
        track.add(k * beats(bpm)(4), instruments.pad([62, 63], beats(bpm)(6), 2000, 2), 0.18);
      for (let k = 0; k < bars * 2; k++) track.add(k * beats(bpm)(2), instruments.kick(0.6));
      return finish(reverb(track, 0.35, 0.9), -1.5, 2.5);
    },
  ],
];

// ---- Writing ----

function wavBytes(track) {
  const data = Buffer.alloc(track.length * 8);
  for (let i = 0; i < track.length; i++) {
    data.writeFloatLE(track.left[i], i * 8);
    data.writeFloatLE(track.right[i], i * 8 + 4);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(3, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 8, 28);
  header.writeUInt16LE(8, 32);
  header.writeUInt16LE(32, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

async function encode(id, track, kbps) {
  const source = join(work, `${id}.wav`);
  const target = join(out, `${id}.webm`);
  await writeFile(source, wavBytes(track));
  const result = spawnSync(
    ffmpegTool('ffmpeg'),
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      source,
      '-c:a',
      'libopus',
      '-b:a',
      `${kbps}k`,
      '-application',
      'audio',
      target,
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(`FFmpeg failed on ${id}: ${result.stderr}`);
  return (await stat(target)).size;
}

await rm(work, { recursive: true, force: true });
await mkdir(work, { recursive: true });
await mkdir(out, { recursive: true });
const sounds = [];
for (const [id, name, category, make] of effects) {
  const track = make();
  const bytes = await encode(id, track, 96);
  sounds.push({
    id,
    name,
    kind: 'effect',
    category,
    file: `sounds/${id}.webm`,
    bytes,
    seconds: Number((track.length / RATE).toFixed(3)),
  });
  console.log('effect', id, bytes);
}
for (const [id, name, category, bpm, bars, make] of music) {
  const track = make(bpm, bars);
  const bytes = await encode(id, track, 96);
  sounds.push({
    id,
    name,
    kind: 'music',
    category,
    bpm,
    file: `sounds/${id}.webm`,
    bytes,
    seconds: Number((track.length / RATE).toFixed(3)),
  });
  console.log('music', id, bytes);
}
await writeFile(
  join(out, 'sounds.json'),
  JSON.stringify(
    {
      comment:
        'The built-in sound library, written by scripts/make-sounds.mjs: synthesised, so no licences are involved.',
      sounds,
    },
    null,
    2,
  ) + '\n',
);
await rm(work, { recursive: true, force: true });
const total = sounds.reduce((sum, sound) => sum + sound.bytes, 0);
console.log(`${sounds.length} sounds, ${(total / 1e6).toFixed(2)} MB`);
