import { C, createRing, H, processorName, publish, ringViews } from './ring';
import workletUrl from './worklet.ts?worker&url';

/** Seconds of sound the ring holds. */
const ringSeconds = 2;
/** How often the page reports the device's output timestamp. */
const reportMs = 100;

/**
 * The page side of sound. Workers cannot create an AudioContext, so the engine
 * client runs one here with the ring-player worklet, and reports when the device
 * outputs which context time, so the engine worker knows which sample is heard.
 * UI components never use it directly.
 */
export class AudioOutput {
  private timer: ReturnType<typeof setInterval>;

  private constructor(
    private readonly context: AudioContext,
    private readonly node: AudioWorkletNode,
    readonly buffer: SharedArrayBuffer,
    readonly channels: number,
  ) {
    this.timer = setInterval(() => this.report(), reportMs);
    this.report();
  }

  /** An output at `sampleRate`, which the browser resamples to the device if needed. */
  static async create(sampleRate: number, channels: number): Promise<AudioOutput> {
    const context = new AudioContext({ sampleRate, latencyHint: 'interactive' });
    try {
      await context.audioWorklet.addModule(workletUrl);
      const buffer = createRing(Math.round(sampleRate * ringSeconds), channels, sampleRate);
      const node = new AudioWorkletNode(context, processorName, {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [channels],
        processorOptions: { buffer },
      });
      node.connect(context.destination);
      return new AudioOutput(context, node, buffer, channels);
    } catch (error) {
      void context.close();
      throw error;
    }
  }

  get sampleRate() {
    return this.context.sampleRate;
  }

  /** The playback context, for the microphone, so recordings share its clock. */
  get audioContext() {
    return this.context;
  }

  /** Starts the device. Call it from a user gesture, as autoplay rules require. */
  resume() {
    if (this.context.state === 'suspended') void this.context.resume().then(() => this.report());
  }

  private report() {
    const ring = ringViews(this.buffer);
    const stamp = this.context.getOutputTimestamp();
    publish(ring.header, H.outputSeq, () => {
      ring.clock[C.outputContextTime] = stamp.contextTime ?? 0;
      ring.clock[C.outputPerfTime] = stamp.performanceTime
        ? performance.timeOrigin + stamp.performanceTime
        : 0;
    });
    ring.clock[C.running] = this.context.state === 'running' ? 1 : 0;
    ring.clock[C.outputLatency] = this.context.outputLatency ?? this.context.baseLatency ?? 0;
  }

  /** Plays through output device `deviceId` ('' is the system's default). */
  async setDevice(deviceId: string) {
    const context = this.context as AudioContext & { setSinkId?(id: string): Promise<void> };
    if (!context.setSinkId) throw new Error('This browser cannot choose the sound output.');
    await context.setSinkId(deviceId);
    this.report();
  }

  close() {
    clearInterval(this.timer);
    this.node.disconnect();
    void this.context.close();
  }
}
