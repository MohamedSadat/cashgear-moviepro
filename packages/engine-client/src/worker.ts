import { expose } from 'comlink';
import { builtinLooks, loadPackImages, lookText } from './effects/assets';
import type { CatalogEntry } from './effects/types';
import { FontLoader, fontCatalog } from './fonts/loader';
import { FrameLoop, workerScheduler } from './frame-loop';
import { AudioBlocks } from './media/audio-blocks';
import { MediaService, type DecodePreference } from './media/service';
import { AudioPlayer } from './playback/audio-player';
import { PlaybackController } from './playback/controller';
import { ProjectService } from './project/service';
import type { Pixels } from './playback/types';
import type { EngineApi, EngineEvent, EngineInfo, GpuFault, InitOptions } from './types';
import initWasm, { Engine, MediaLibrary, effects_catalog } from './pkg/cgv_wasm';

let engine: Engine | undefined;
let loop: FrameLoop | undefined;
let media: MediaService | undefined;
let playback: PlaybackController | undefined;
let audio: AudioPlayer | null = null;
let decode: DecodePreference = 'auto';
const project = new ProjectService();
const blocks = new AudioBlocks((id) => media?.audioTrack(id) ?? null);
project.onChange = (replaced) => {
  if (replaced) {
    blocks.clear();
    playback?.reset();
  } else playback?.invalidate();
};
let initializing = false;
let disposed = false;
let diagnostic = false;
let wasm: Promise<unknown> | undefined;

function ensureWasm() {
  wasm ??= initWasm({ module_or_path: new URL('./pkg/cgv_wasm_bg.wasm', import.meta.url) });
  return wasm;
}
function post(event: EngineEvent) {
  self.postMessage(event);
}
function fatal(message: string) {
  loop?.stop();
  post({ type: 'engine-fatal', message });
}
function requireMedia() {
  if (!media) throw new Error('The media library is not configured');
  return media;
}
function requirePlayback() {
  if (!playback) throw new Error('The engine is not running');
  return playback;
}
function requireDiagnostics() {
  if (!diagnostic) throw new Error('Diagnostics are disabled');
  return requirePlayback();
}

// Worker-local fault injection lets browser tests exercise the real Rust
// fallback path without changing browser flags or the renderer policy.
function simulateGpuFailure(fault: GpuFault) {
  const gpu = Reflect.get(navigator, 'gpu') as
    { requestAdapter: (...args: unknown[]) => Promise<object | null> } | undefined;
  if (!gpu) throw new Error('GPU failure diagnostics require the WebGPU API');
  const requestAdapter = gpu.requestAdapter.bind(gpu);
  Object.defineProperty(gpu, 'requestAdapter', {
    value: async (...args: unknown[]) => {
      if (fault === 'adapter') return null;
      const adapter = await requestAdapter(...args);
      if (adapter)
        Object.defineProperty(adapter, 'requestDevice', {
          value: () => Promise.reject(new Error('Diagnostic device request failure')),
        });
      return adapter;
    },
  });
}

const api: EngineApi = {
  async init(canvas: OffscreenCanvas, options: InitOptions): Promise<EngineInfo> {
    if (engine || initializing || disposed)
      throw new Error('Engine worker cannot be initialized twice');
    initializing = true;
    diagnostic = options.diagnostic;
    if (diagnostic && options.simulateGpuFailure) simulateGpuFailure(options.simulateGpuFailure);
    await ensureWasm();
    const created = await Engine.create(canvas, options.backend, fatal);
    if (disposed) {
      created.dispose();
      created.free();
      throw new Error('Engine disposed during initialization');
    }
    // Transitions read their gradients from the first frame on.
    await loadPackImages(created);
    if (disposed) {
      created.dispose();
      created.free();
      throw new Error('Engine disposed during initialization');
    }
    engine = created;
    const backend = engine.backend();
    if (backend !== 'WebGPU' && backend !== 'WebGL2')
      throw new Error('Unexpected GPU backend: ' + backend);
    const running = engine;
    const controller = new PlaybackController({
      engine: running,
      fonts: new FontLoader(running, fontCatalog()),
      session: () => project.current,
      media: () => media,
      audio: () => audio,
      onState: (state) => post({ type: 'engine-playback', ...state }),
      onMeters: (reading) => post({ type: 'engine-meters', reading }),
      onError: (message) => post({ type: 'engine-notice', message }),
    });
    controller.pattern = options.pattern === true;
    decode = (diagnostic && options.decode) || 'auto';
    if (media) media.decode = decode;
    playback = controller;
    loop = new FrameLoop(
      {
        resize: (size) => running.resize(size.width, size.height),
        frame: (now) => ({
          presented: controller.tick(now),
          frames: running.frames(),
          width: running.width(),
          height: running.height(),
        }),
      },
      workerScheduler(),
      (stats) => post({ type: 'engine-stats', ...stats }),
      fatal,
    );
    loop.start({ width: options.width, height: options.height });
    return { backend, adapter: engine.adapter_name() };
  },
  resize(size) {
    if (!disposed) loop?.resize(size);
  },
  touchSharedMemory(buffer, value) {
    const view = new Int32Array(buffer);
    Atomics.store(view, 0, value);
    Atomics.notify(view, 0);
  },
  dispose() {
    disposed = true;
    loop?.stop();
    loop = undefined;
    playback?.dispose();
    playback = undefined;
    audio?.dispose();
    audio = null;
    void media?.releaseFrames();
    project.close();
    engine?.dispose();
    engine?.free();
    engine = undefined;
  },
  diagnosticFault(kind) {
    if (!diagnostic || !engine) throw new Error('Diagnostics are disabled');
    if (kind === 'device-loss') engine.diagnostic_device_loss();
    else engine.diagnostic_panic();
  },

  async configureMedia(platform) {
    if (media) throw new Error('The media library is already configured');
    await ensureWasm();
    media = new MediaService(new MediaLibrary(platform));
    media.decode = decode;
    media.onChange = (id) => {
      blocks.forget(id);
      playback?.mediaChanged(id);
    };
  },
  importMedia: (requests) => requireMedia().import(requests),
  mediaSnapshot: () => requireMedia().snapshot(),
  setMediaStatus: (id, status) => requireMedia().setStatus(id, status),
  attachProxy: (id, source) => requireMedia().attachProxy(id, source),
  removeMedia: (id) => requireMedia().remove(id),
  mediaStats: () => requireMedia().stats(),
  frameCount: (id) => requireMedia().frameCount(id),
  readFrame: (id, frame, crop) => requireMedia().readback(id, frame, crop),
  releaseFrames: () => requireMedia().releaseFrames(),
  clearMedia: () => requireMedia().clear(),

  async projectCreate(id, name) {
    await ensureWasm();
    return project.create(id, name);
  },
  async projectOpen(text, options) {
    await ensureWasm();
    return project.open(text, options);
  },
  projectClose: () => project.close(),
  projectSnapshot: () => project.snapshot(),
  projectExecute: (command) => project.execute(command),
  projectExecuteGroup: (label, commands) => project.executeGroup(label, commands),
  projectUndo: () => project.undo(),
  projectRedo: () => project.redo(),
  projectBeginGroup: (label) => project.beginGroup(label),
  projectPreview: (command) => project.preview(command),
  projectEndGroup: () => project.endGroup(),
  projectCancelGroup: () => project.cancelGroup(),
  projectSave: () => project.save(),
  projectMarkSaved: (generation) => project.markSaved(generation),
  projectMarkAutosaved: (generation) => project.markAutosaved(generation),
  projectUpdateMedia: (ref) => project.updateMedia(ref),
  projectClipsAt: (time) => project.clipsAt(time),
  projectSnapPoints: (playhead, exclude) => project.snapPoints(playhead, exclude),
  async projectPresets() {
    await ensureWasm();
    return ProjectService.presets();
  },
  projectImportLut: (name, text) => project.importLut(name, text),
  async projectImportLook(id) {
    const looks = await builtinLooks();
    const look = looks.find((entry) => entry.id === id);
    if (!look) throw new Error(`There is no built-in look ${id}`);
    return project.importLut(look.name, await lookText(id));
  },
  async effectsCatalog() {
    await ensureWasm();
    return JSON.parse(effects_catalog()) as CatalogEntry[];
  },
  builtinLooks: () => builtinLooks(),
  addFonts(entries) {
    fontCatalog().addEntries(entries);
    // A title drawn with a fallback font may now have its own.
    playback?.invalidate();
    return Promise.resolve();
  },

  // Sound may be set up before the renderer starts (the project opens first).
  async attachAudio(buffer, sampleRate, channels) {
    await ensureWasm();
    playback?.pause();
    audio?.dispose();
    blocks.clear();
    audio = new AudioPlayer(buffer, sampleRate, channels, blocks);
  },
  play: (rate) => requirePlayback().play(rate),
  pause: () => requirePlayback().pause(),
  togglePlay: () => requirePlayback().toggle(),
  shuttle: (key) => requirePlayback().shuttle(key),
  seek: (time, options) => requirePlayback().seek(time, options),
  step: (frames) => requirePlayback().step(frames),
  setQuality: (mode) => requirePlayback().setQuality(mode),
  playbackState: () => requirePlayback().state(),
  playbackStats: () => requirePlayback().stats(),
  resetPlaybackStats: () => requirePlayback().resetStats(),
  async seekAndWait(time) {
    const controller = requireDiagnostics();
    const started = performance.now();
    controller.pause();
    controller.seek(time);
    await controller.whenSettled();
    return { ms: performance.now() - started };
  },
  renderPixels: (time) => requireDiagnostics().pixels(time),
  async readComposition() {
    requireDiagnostics();
    return (await engine!.read_pixels()) as Pixels;
  },
};
expose(api);
