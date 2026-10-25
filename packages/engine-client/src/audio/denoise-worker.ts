/// <reference lib="webworker" />
// Noise reduction off the engine's thread: RNNoise takes a good part of a
// second per block, which would cost the monitor frames. Requests are cleaned
// one at a time, in the order they come.
import init, { denoise } from '../pkg/denoise/cgv_denoise';

interface Request {
  id: number;
  rate: number;
  channels: number;
  data: Float32Array;
}

const ready = init();

self.onmessage = async (event: MessageEvent<Request>) => {
  const { id, rate, channels, data } = event.data;
  try {
    await ready;
    const clean = denoise(rate, channels, data);
    self.postMessage({ id, data: clean }, [clean.buffer]);
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
