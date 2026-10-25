import captureUrl from './capture-worklet.ts?worker&url';

/**
 * A recording from the microphone, with what it takes to put it on the
 * timeline where it was heard.
 */
export interface Recording {
  rate: number;
  /** Planar samples, one or two channels. */
  planes: Float32Array[];
  /** The context frame of the first sample. */
  firstFrame: number;
  /**
   * The timeline sample the ring player rendered at context frame `frame`,
   * read while the timeline played (or, if it never did, where recording
   * started). Null when nothing gives it.
   */
  anchor: { frame: number; sample: number } | null;
  /**
   * Seconds from the ring player rendering a sample to the microphone's sound
   * reaching the capture worklet: the output latency plus the input latency.
   */
  latency: number;
}

/**
 * The sample of `recording` that lines up with timeline sample `at`. A sample
 * captured at context frame f was sung against what the speakers played then,
 * which the ring player rendered at f minus the latency.
 */
export function recordingOffset(recording: Recording, at: number): number {
  const { anchor, firstFrame, latency, rate } = recording;
  if (!anchor) return 0;
  return Math.round(at - anchor.sample + anchor.frame + latency * rate - firstFrame);
}

/** A 16-bit PCM WAV file of planar samples. */
export function encodeWav(planes: Float32Array[], rate: number): Uint8Array<ArrayBuffer> {
  const channels = planes.length;
  const frames = planes[0]?.length ?? 0;
  const bytes = new Uint8Array(44 + frames * channels * 2);
  const view = new DataView(bytes.buffer);
  const text = (at: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + frames * channels * 2, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, frames * channels * 2, true);
  let at = 44;
  for (let i = 0; i < frames; i++)
    for (let c = 0; c < channels; c++) {
      const value = Math.max(-1, Math.min(1, planes[c][i]));
      view.setInt16(at, Math.round(value * 32767), true);
      at += 2;
    }
  return bytes;
}

export interface MicrophoneOptions {
  deviceId?: string;
  /** Tests: record this stream (a loopback, say) instead of a microphone. */
  stream?: MediaStream;
}

/**
 * The microphone, in the playback context: an input level for the meter,
 * hearing yourself if wanted, and recordings stamped on the playback clock.
 * Lives on the page (only the page can open a microphone); UI components use
 * it through the engine client.
 */
export class Microphone {
  private batches: { frame: number; planes: Float32Array[] }[] = [];
  private recording = false;
  private levelListener: ((peak: number) => void) | null = null;
  private anchor: Recording['anchor'] = null;
  private latencies: number[] = [];

  private constructor(
    private readonly context: AudioContext,
    private readonly stream: MediaStream,
    private readonly owned: boolean,
    private readonly source: MediaStreamAudioSourceNode,
    private readonly node: AudioWorkletNode,
    private readonly monitor: GainNode,
  ) {
    node.port.onmessage = (
      event: MessageEvent<{ frame: number; planes: Float32Array[]; peak: number }>,
    ) => {
      const { frame, planes, peak } = event.data;
      this.levelListener?.(peak);
      if (!this.recording) return;
      this.batches.push({ frame, planes: planes.slice(0, 2) });
      this.latencies.push(this.outputLatency());
    };
  }

  static async open(context: AudioContext, options: MicrophoneOptions = {}): Promise<Microphone> {
    const stream =
      options.stream ??
      (await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: options.deviceId ? { exact: options.deviceId } : undefined,
          // A voice as recorded, without the browser's call processing.
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      }));
    try {
      await context.audioWorklet.addModule(captureUrl);
      const source = context.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(context, 'cgv-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      const monitor = context.createGain();
      monitor.gain.value = 0;
      source.connect(node);
      source.connect(monitor);
      monitor.connect(context.destination);
      // The worklet writes silence; being connected keeps it running.
      node.connect(context.destination);
      return new Microphone(context, stream, !options.stream, source, node, monitor);
    } catch (error) {
      if (!options.stream) for (const track of stream.getTracks()) track.stop();
      throw error;
    }
  }

  /** The device's name, once the user has allowed the microphone. */
  get label() {
    return this.stream.getAudioTracks()[0]?.label ?? '';
  }

  get deviceId() {
    return this.stream.getAudioTracks()[0]?.getSettings().deviceId ?? '';
  }

  /** Hears the input's peak level (linear) about 12 times a second. */
  onLevel(listener: ((peak: number) => void) | null) {
    this.levelListener = listener;
  }

  /** Plays the microphone through the speakers (use headphones). */
  setMonitoring(on: boolean) {
    this.monitor.gain.setTargetAtTime(on ? 1 : 0, this.context.currentTime, 0.01);
  }

  /** Seconds the speakers trail the ring player: from the output timestamp. */
  private outputLatency(): number {
    const stamp = this.context.getOutputTimestamp();
    if (!stamp.performanceTime || stamp.contextTime === undefined) {
      return (this.context.baseLatency ?? 0) + (this.context.outputLatency ?? 0);
    }
    const heard = stamp.contextTime + (performance.now() - stamp.performanceTime) / 1000;
    return Math.max(0, this.context.currentTime - heard);
  }

  /** Keeps what the microphone hears from now on. */
  start() {
    this.batches = [];
    this.latencies = [];
    this.anchor = null;
    this.recording = true;
  }

  /** The context frame being rendered now. */
  contextFrame() {
    return Math.round(this.context.currentTime * this.context.sampleRate);
  }

  /** Records which timeline sample the ring player rendered at context frame `frame`. */
  setAnchor(frame: number, sample: number) {
    this.anchor = { frame, sample };
  }

  get anchored() {
    return this.anchor !== null;
  }

  /** Stops keeping sound and returns what was kept. */
  stop(): Recording {
    this.recording = false;
    const batches = this.batches;
    this.batches = [];
    const channels = Math.max(1, ...batches.map((batch) => batch.planes.length));
    const first = batches[0]?.frame ?? this.contextFrame();
    const last = batches.length ? batches[batches.length - 1] : null;
    const frames = last ? last.frame + last.planes[0].length - first : 0;
    const planes = Array.from({ length: channels }, () => new Float32Array(Math.max(0, frames)));
    for (const batch of batches)
      planes.forEach((plane, channel) => {
        const source = batch.planes[Math.min(channel, batch.planes.length - 1)];
        plane.set(source, batch.frame - first);
      });
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const output = sorted.length ? sorted[sorted.length >> 1] : this.outputLatency();
    // Chrome reports the input latency; TypeScript's settings type lacks it.
    const settings = this.stream.getAudioTracks()[0]?.getSettings() as
      (MediaTrackSettings & { latency?: number }) | undefined;
    const input = settings?.latency ?? 0;
    return {
      rate: this.context.sampleRate,
      planes,
      firstFrame: first,
      anchor: this.anchor,
      latency: output + (typeof input === 'number' ? input : 0),
    };
  }

  close() {
    this.recording = false;
    this.levelListener = null;
    this.node.port.onmessage = null;
    this.source.disconnect();
    this.node.disconnect();
    this.monitor.disconnect();
    if (this.owned) for (const track of this.stream.getTracks()) track.stop();
  }
}
