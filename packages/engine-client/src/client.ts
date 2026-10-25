import { releaseProxy, transfer, wrap } from 'comlink';
import type { MeterReading } from './audio/meters';
import { AudioOutput } from './audio/output';
import { Microphone, type MicrophoneOptions } from './audio/recorder';
import { fontCatalog } from './fonts/loader';
import type { PlaybackState } from './playback/types';
import type { EngineApi, EngineEvent, FrameStats, InitOptions } from './types';

export interface EngineClient {
  api: ReturnType<typeof wrap<EngineApi>>;
  init(canvas: OffscreenCanvas, options: InitOptions): ReturnType<EngineApi['init']>;
  /** Receives frame stats from the worker's render loop (about ten times a second). */
  onStats(listener: ((stats: FrameStats) => void) | null): void;
  /** Receives the playhead and transport whenever they change (at most ~30 times a second). */
  onPlayback(listener: ((state: PlaybackState) => void) | null): void;
  /** Receives the meters while playing (about 30 times a second), then null. */
  onMeters(listener: ((reading: MeterReading | null) => void) | null): void;
  /** Receives non-fatal engine messages, such as a frame that could not be drawn. */
  onNotice(listener: ((message: string) => void) | null): void;
  /** Proves this page and the worker share memory (needs cross-origin isolation). */
  checkSharedMemory(): Promise<boolean>;
  /**
   * Sets up sound at the project's rate and channel count, and gives the worker
   * its ring buffer. Without it, playback follows the wall clock in silence.
   */
  configureAudio(sampleRate: number, channels: number): Promise<void>;
  /** Plays; starts the sound device first, so call it from a user gesture. */
  play(rate?: number): Promise<void>;
  /** Plays or pauses; like `play`, call it from a user gesture. */
  togglePlay(): Promise<void>;
  /** J, K or L; starts the sound device first. */
  shuttle(key: 'j' | 'k' | 'l'): Promise<void>;
  /**
   * Opens the microphone in the playback context (asking the user first), for
   * voiceovers. Call it from a user gesture. Fails without sound set up.
   */
  openMicrophone(options?: MicrophoneOptions): Promise<Microphone>;
  /** Plays sound through output device `deviceId` ('' for the system's default). */
  setOutputDevice(deviceId: string): Promise<void>;
  /**
   * Plays a sound file (a library preview) once; another call, or null, stops
   * it. `onEnded` runs when it finishes by itself. Call it from a user gesture.
   */
  previewSound(url: string | null, onEnded?: () => void): Promise<void>;
  dispose(): void;
}

/** Starts an engine worker. `onError` reports fatal errors (worker crash, GPU loss, Rust panic). */
export function createEngineClient(onError: (message: string) => void): EngineClient {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), {
    type: 'module',
    name: 'cgv-engine',
  });
  const api = wrap<EngineApi>(worker);
  let disposed = false;
  let statsListener: ((stats: FrameStats) => void) | null = null;
  let playbackListener: ((state: PlaybackState) => void) | null = null;
  let noticeListener: ((message: string) => void) | null = null;
  let metersListener: ((reading: MeterReading | null) => void) | null = null;
  let output: AudioOutput | null = null;
  let preview: AudioBufferSourceNode | null = null;
  let audioSetup: Promise<void> = Promise.resolve();
  // The worker's fonts follow this page's catalogue (imported and installed families).
  const fonts = fontCatalog();
  const sendFonts = () => {
    if (!disposed) void api.addFonts(fonts.extras()).catch(() => {});
  };
  if (fonts.extras().length) sendFonts();
  const stopFonts = fonts.subscribe(sendFonts);
  worker.addEventListener('message', (event: MessageEvent<EngineEvent | undefined>) => {
    if (disposed || !event.data || typeof event.data !== 'object') return;
    const data = event.data;
    if (data.type === 'engine-fatal') onError(data.message);
    else if (data.type === 'engine-notice') noticeListener?.(data.message);
    else if (data.type === 'engine-stats') {
      const { frames, presented, width, height } = data;
      statsListener?.({ frames, presented, width, height });
    } else if (data.type === 'engine-meters') {
      metersListener?.(data.reading);
    } else if (data.type === 'engine-playback') {
      const state: PlaybackState & { type?: string } = { ...data };
      delete state.type;
      playbackListener?.(state);
    }
  });
  worker.addEventListener('error', (event) => {
    event.preventDefault();
    if (!disposed) onError(event.message || 'The engine worker stopped unexpectedly.');
  });
  worker.addEventListener('messageerror', () => {
    if (!disposed) onError('Could not read an engine response.');
  });
  return {
    api,
    init(canvas, options) {
      return api.init(transfer(canvas, [canvas]), options);
    },
    onStats(listener) {
      statsListener = listener;
    },
    onPlayback(listener) {
      playbackListener = listener;
    },
    onNotice(listener) {
      noticeListener = listener;
    },
    onMeters(listener) {
      metersListener = listener;
    },
    async checkSharedMemory() {
      if (typeof SharedArrayBuffer !== 'function' || !crossOriginIsolated) return false;
      const buffer = new SharedArrayBuffer(4);
      const value = 0x0c95;
      await api.touchSharedMemory(buffer, value);
      return Atomics.load(new Int32Array(buffer), 0) === value;
    },
    configureAudio(sampleRate, channels) {
      audioSetup = audioSetup.then(async () => {
        if (disposed || (output?.sampleRate === sampleRate && output.channels === channels)) return;
        output?.close();
        output = null;
        if (typeof AudioContext !== 'function') return;
        const next = await AudioOutput.create(sampleRate, channels);
        if (disposed) return next.close();
        output = next;
        await api.attachAudio(next.buffer, sampleRate, channels);
      });
      return audioSetup;
    },
    play(rate = 1) {
      output?.resume();
      return api.play(rate);
    },
    togglePlay() {
      output?.resume();
      return api.togglePlay();
    },
    shuttle(key) {
      output?.resume();
      return api.shuttle(key);
    },
    async openMicrophone(options) {
      await audioSetup;
      if (!output) throw new Error('Sound is not set up, so nothing can be recorded.');
      output.resume();
      return Microphone.open(output.audioContext, options);
    },
    async setOutputDevice(deviceId) {
      await audioSetup;
      if (!output) throw new Error('Sound is not set up.');
      await output.setDevice(deviceId);
    },
    async previewSound(url, onEnded) {
      const playing = preview;
      preview = null;
      playing?.stop();
      if (!url) return;
      await audioSetup;
      if (!output) throw new Error('Sound is not set up.');
      output.resume();
      const context = output.audioContext;
      const buffer = await context.decodeAudioData(await (await fetch(url)).arrayBuffer());
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      source.onended = () => {
        if (preview !== source) return;
        preview = null;
        onEnded?.();
      };
      // Another preview may have started while this one decoded.
      (preview as AudioBufferSourceNode | null)?.stop();
      preview = source;
      source.start();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stopFonts();
      statsListener = null;
      playbackListener = null;
      noticeListener = null;
      metersListener = null;
      output?.close();
      output = null;
      // A crashed WASM instance may never answer RPC. Always terminate its worker.
      const timer = setTimeout(() => worker.terminate(), 200);
      void api
        .dispose()
        .catch(() => {})
        .finally(() => {
          clearTimeout(timer);
          api[releaseProxy]();
          worker.terminate();
        });
    },
  };
}
