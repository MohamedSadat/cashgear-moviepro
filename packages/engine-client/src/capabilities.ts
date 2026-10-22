import type { Backend } from './types';

export interface GpuAdapterInfo {
  vendor: string;
  architecture: string;
  description: string;
}

/** Raw facts about the page, gathered once at startup on the main thread. */
export interface CapabilityProbe {
  crossOriginIsolated: boolean;
  sharedArrayBuffer: boolean;
  offscreenCanvas: boolean;
  audioWorklet: boolean;
  webgpu: boolean;
  /** The main thread's view of the WebGPU adapter, when one is available. */
  gpuAdapter: GpuAdapterInfo | null;
  webcodecs: {
    VideoDecoder: boolean;
    VideoEncoder: boolean;
    AudioDecoder: boolean;
    AudioEncoder: boolean;
  };
}

/** What the engine worker reported once it started (or failed to). */
export type EngineGpu =
  | { state: 'pending' }
  /** `forced` when WebGL2 was requested (`?gpu=webgl2`) rather than fallen back to. */
  | { state: 'ready'; backend: Backend; forced?: boolean }
  | { state: 'failed' };

export interface CapabilityIssue {
  id:
    | 'cross-origin-isolation'
    | 'shared-memory'
    | 'webcodecs'
    | 'offscreen-canvas'
    | 'audio-worklet'
    | 'gpu'
    | 'webgl2-fallback';
  severity: 'blocker' | 'warning';
  message: string;
}

export interface CapabilityReport {
  status: 'checking' | 'ok' | 'degraded' | 'blocked';
  issues: CapabilityIssue[];
}

export async function probeCapabilities(
  scope: typeof globalThis = globalThis,
): Promise<CapabilityProbe> {
  const has = (name: string) => typeof Reflect.get(scope, name) === 'function';
  const gpu = Reflect.get(scope.navigator ?? {}, 'gpu') as
    { requestAdapter(): Promise<{ info?: Partial<GpuAdapterInfo> } | null> } | undefined;
  let gpuAdapter: GpuAdapterInfo | null = null;
  if (gpu) {
    try {
      const adapter = await gpu.requestAdapter();
      if (adapter)
        gpuAdapter = {
          vendor: adapter.info?.vendor ?? '',
          architecture: adapter.info?.architecture ?? '',
          description: adapter.info?.description ?? '',
        };
    } catch {
      gpuAdapter = null;
    }
  }
  const canvas = Reflect.get(scope, 'HTMLCanvasElement') as { prototype: object } | undefined;
  return {
    crossOriginIsolated: Reflect.get(scope, 'crossOriginIsolated') === true,
    sharedArrayBuffer: has('SharedArrayBuffer'),
    offscreenCanvas:
      has('OffscreenCanvas') && !!canvas && 'transferControlToOffscreen' in canvas.prototype,
    audioWorklet: has('AudioWorkletNode'),
    webgpu: !!gpu,
    gpuAdapter,
    webcodecs: {
      VideoDecoder: has('VideoDecoder'),
      VideoEncoder: has('VideoEncoder'),
      AudioDecoder: has('AudioDecoder'),
      AudioEncoder: has('AudioEncoder'),
    },
  };
}

const browserAdvice = 'Use a current version of Chrome or Edge.';

/**
 * Turns the probe, the shared-memory round trip and the engine's GPU result into
 * one verdict. Anything playback or export cannot work without is a blocker;
 * running on the WebGL2 fallback is a warning.
 */
export function evaluateCapabilities(
  probe: CapabilityProbe | undefined,
  sharedMemory: boolean | undefined,
  gpu: EngineGpu,
): CapabilityReport {
  if (!probe) return { status: 'checking', issues: [] };
  const issues: CapabilityIssue[] = [];
  if (!probe.crossOriginIsolated)
    issues.push({
      id: 'cross-origin-isolation',
      severity: 'blocker',
      message:
        'The page is not cross-origin isolated, so shared memory for playback and audio is off. ' +
        'It must be served with Cross-Origin-Opener-Policy: same-origin and ' +
        'Cross-Origin-Embedder-Policy: require-corp.',
    });
  else if (!probe.sharedArrayBuffer || sharedMemory === false)
    issues.push({
      id: 'shared-memory',
      severity: 'blocker',
      message:
        'Shared memory between the page and the engine worker does not work. ' + browserAdvice,
    });
  const missingCodecs = Object.entries(probe.webcodecs)
    .filter(([, present]) => !present)
    .map(([name]) => name);
  if (missingCodecs.length)
    issues.push({
      id: 'webcodecs',
      severity: 'blocker',
      message:
        'WebCodecs is missing (' +
        missingCodecs.join(', ') +
        '), so video and audio cannot be decoded or exported. ' +
        browserAdvice,
    });
  if (!probe.offscreenCanvas)
    issues.push({
      id: 'offscreen-canvas',
      severity: 'blocker',
      message:
        'OffscreenCanvas is missing, so the engine cannot draw the monitor. ' + browserAdvice,
    });
  if (!probe.audioWorklet)
    issues.push({
      id: 'audio-worklet',
      severity: 'blocker',
      message: 'AudioWorklet is missing, so audio cannot play. ' + browserAdvice,
    });
  if (gpu.state === 'failed')
    issues.push({
      id: 'gpu',
      severity: 'blocker',
      message: 'Neither WebGPU nor WebGL2 is usable, so nothing can be rendered. ' + browserAdvice,
    });
  else if (gpu.state === 'ready' && gpu.backend === 'WebGL2')
    issues.push({
      id: 'webgl2-fallback',
      severity: 'warning',
      message:
        (gpu.forced
          ? 'The WebGL2 renderer was requested (?gpu=webgl2), so the engine is using WebGL2.'
          : probe.webgpu
            ? 'WebGPU could not start, so the engine is using WebGL2.'
            : 'This browser has no WebGPU, so the engine is using WebGL2.') +
        ' Playback and effects will be slower.',
    });
  if (issues.some((issue) => issue.severity === 'blocker')) return { status: 'blocked', issues };
  if (gpu.state === 'pending' || sharedMemory === undefined) return { status: 'checking', issues };
  return { status: issues.length ? 'degraded' : 'ok', issues };
}
