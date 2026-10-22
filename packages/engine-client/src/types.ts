export type BackendPreference = 'auto' | 'webgl2';
export type Backend = 'WebGPU' | 'WebGL2';
export type GpuFault = 'adapter' | 'device';
export type DiagnosticFault = 'device-loss' | 'panic';

export interface PhysicalSize {
  width: number;
  height: number;
}
export interface InitOptions extends PhysicalSize {
  backend: BackendPreference;
  diagnostic: boolean;
  /** Diagnostics only: make the worker's WebGPU adapter or device request fail. */
  simulateGpuFailure?: GpuFault;
}
export interface EngineInfo {
  backend: Backend;
  adapter: string;
}
export interface FrameStats extends PhysicalSize {
  frames: number;
  presented: boolean;
}
export interface EngineApi {
  init(canvas: OffscreenCanvas, options: InitOptions): Promise<EngineInfo>;
  resize(size: PhysicalSize): void;
  /** Writes into shared memory from the worker; the caller reads it back. */
  touchSharedMemory(buffer: SharedArrayBuffer, value: number): void;
  dispose(): void;
  diagnosticFault(kind: DiagnosticFault): void;
}

/** Messages the worker posts outside the RPC channel. */
export type EngineEvent =
  { type: 'engine-fatal'; message: string } | ({ type: 'engine-stats' } & FrameStats);
