import { describe, expect, it } from 'vitest';
import { evaluateCapabilities, probeCapabilities, type CapabilityProbe } from './capabilities';

const full: CapabilityProbe = {
  crossOriginIsolated: true,
  sharedArrayBuffer: true,
  offscreenCanvas: true,
  audioWorklet: true,
  webgpu: true,
  gpuAdapter: { vendor: 'nvidia', architecture: 'turing', description: '' },
  webcodecs: { VideoDecoder: true, VideoEncoder: true, AudioDecoder: true, AudioEncoder: true },
};
const ids = (report: ReturnType<typeof evaluateCapabilities>) => report.issues.map((i) => i.id);

describe('evaluateCapabilities', () => {
  it('is ok on WebGPU with everything present', () => {
    expect(evaluateCapabilities(full, true, { state: 'ready', backend: 'WebGPU' })).toEqual({
      status: 'ok',
      issues: [],
    });
  });

  it('is degraded, not blocked, on the WebGL2 fallback', () => {
    const report = evaluateCapabilities(full, true, { state: 'ready', backend: 'WebGL2' });
    expect(report.status).toBe('degraded');
    expect(ids(report)).toEqual(['webgl2-fallback']);
    expect(report.issues[0].message).toContain('WebGPU could not start');
    const noApi = evaluateCapabilities({ ...full, webgpu: false }, true, {
      state: 'ready',
      backend: 'WebGL2',
    });
    expect(noApi.issues[0].message).toContain('no WebGPU');
    const forced = evaluateCapabilities(full, true, {
      state: 'ready',
      backend: 'WebGL2',
      forced: true,
    });
    expect(forced.status).toBe('degraded');
    expect(forced.issues[0].message).toContain('was requested (?gpu=webgl2)');
  });

  it('blocks without cross-origin isolation', () => {
    const report = evaluateCapabilities({ ...full, crossOriginIsolated: false }, false, {
      state: 'ready',
      backend: 'WebGPU',
    });
    expect(report.status).toBe('blocked');
    expect(ids(report)).toEqual(['cross-origin-isolation']);
    expect(report.issues[0].message).toContain('Cross-Origin-Embedder-Policy: require-corp');
  });

  it('blocks when the shared-memory round trip fails', () => {
    const report = evaluateCapabilities(full, false, { state: 'ready', backend: 'WebGPU' });
    expect(ids(report)).toEqual(['shared-memory']);
  });

  it('names each missing WebCodecs interface', () => {
    const report = evaluateCapabilities(
      { ...full, webcodecs: { ...full.webcodecs, VideoEncoder: false, AudioEncoder: false } },
      true,
      { state: 'ready', backend: 'WebGPU' },
    );
    expect(report.status).toBe('blocked');
    expect(report.issues[0].message).toContain('(VideoEncoder, AudioEncoder)');
  });

  it('blocks when no GPU backend starts', () => {
    const report = evaluateCapabilities(full, true, { state: 'failed' });
    expect(ids(report)).toEqual(['gpu']);
  });

  it('keeps checking until the engine and shared memory have answered', () => {
    expect(evaluateCapabilities(undefined, undefined, { state: 'pending' }).status).toBe(
      'checking',
    );
    expect(
      evaluateCapabilities(full, undefined, { state: 'ready', backend: 'WebGPU' }).status,
    ).toBe('checking');
    expect(evaluateCapabilities(full, true, { state: 'pending' }).status).toBe('checking');
    expect(
      evaluateCapabilities({ ...full, audioWorklet: false }, undefined, { state: 'pending' })
        .status,
    ).toBe('blocked');
  });
});

describe('probeCapabilities', () => {
  it('reads the scope it is given', async () => {
    const fn = () => {};
    class Canvas {
      transferControlToOffscreen() {}
    }
    const scope = {
      crossOriginIsolated: true,
      SharedArrayBuffer: fn,
      OffscreenCanvas: fn,
      HTMLCanvasElement: Canvas,
      AudioWorkletNode: fn,
      VideoDecoder: fn,
      VideoEncoder: fn,
      AudioDecoder: fn,
      navigator: {
        gpu: {
          requestAdapter: async () => ({
            info: { vendor: 'google', architecture: 'swiftshader', description: '' },
          }),
        },
      },
    } as unknown as typeof globalThis;
    expect(await probeCapabilities(scope)).toEqual({
      crossOriginIsolated: true,
      sharedArrayBuffer: true,
      offscreenCanvas: true,
      audioWorklet: true,
      webgpu: true,
      gpuAdapter: { vendor: 'google', architecture: 'swiftshader', description: '' },
      webcodecs: {
        VideoDecoder: true,
        VideoEncoder: true,
        AudioDecoder: true,
        AudioEncoder: false,
      },
    });
  });

  it('survives a WebGPU API that throws', async () => {
    const scope = {
      navigator: { gpu: { requestAdapter: () => Promise.reject(new Error('blocked')) } },
    } as unknown as typeof globalThis;
    const probe = await probeCapabilities(scope);
    expect(probe.webgpu).toBe(true);
    expect(probe.gpuAdapter).toBeNull();
    expect(probe.crossOriginIsolated).toBe(false);
  });
});
