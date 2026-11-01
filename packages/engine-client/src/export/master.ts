import { Engine, Mixer } from '../pkg/cgv_wasm';
import { drawFrame } from '../playback/draw';
import type { FramePlan, LayerPlan } from '../playback/types';
import { FLICKS_PER_SECOND } from '../project/types';
import { ExportAudio, normalizeLoudness } from './audio';
import { ExportFrames } from './frames';
import { stopped, type ExportDeps } from './job';
import { ProgressClock } from './progress';
import { formatInfo, frameCount, frameTime, type LoudnessPlan } from './settings';
import type { OpenTarget } from './targets';
import type { ExportJob, ExportProgress, ExportResult } from './types';

/** Frames whose readback runs while the next one is drawn. */
const readAhead = 2;
/** Clips starting this soon get their decoders started. */
const upcomingFlicks = 2 * FLICKS_PER_SECOND;
/** Progress reports, at most this often. */
const reportMs = 100;

/**
 * A ProRes master (desktop): the same `renderFrame(t)` as every export, read
 * back as planar 10-bit Y'CbCr for FFmpeg, which encodes ProRes from it. The
 * sound is mixed first and goes ahead of the frames, so FFmpeg can read it as
 * its second input while the frames arrive.
 */
export async function runMaster(
  deps: ExportDeps,
  job: ExportJob,
  target: OpenTarget,
  report: (progress: ExportProgress) => void,
): Promise<ExportResult> {
  const { engine, session, signal } = deps;
  const settings = job.settings;
  const master = formatInfo(settings.format).master;
  const sink = target.master;
  if (!master || !sink) throw new Error('Masters are made by the desktop app');
  const rate = settings.frameRate;
  const duration = session.duration();
  if (duration <= 0) throw new Error('The timeline is empty: there is nothing to export');
  const frames = frameCount(duration, rate);
  const sampleRate = session.sample_rate();
  const channels = session.channels();
  const totalSamples = Math.round((frames * rate.den * sampleRate) / rate.num);

  const started = performance.now();
  const clock = new ProgressClock();
  let lastReport = 0;
  const progress = (phase: ExportProgress['phase'], done: number, units: number, force = false) => {
    const now = performance.now();
    clock.record(done, now);
    if (!force && now - lastReport < reportMs) return;
    lastReport = now;
    report({
      phase,
      frame: done,
      frames: units,
      fraction: units ? Math.min(1, done / units) : 1,
      elapsedMs: now - started,
      remainingMs: clock.remainingMs(units),
      speed: clock.rate(),
    });
  };
  progress('preparing', 0, frames, true);

  const mixer = settings.audio ? new Mixer(sampleRate, channels) : null;
  const sources = new ExportFrames(engine, deps.media, deps.planes, deps.originals);
  let loudness: LoudnessPlan | null = null;
  let finished = false;
  try {
    if (mixer) {
      const loudnessTarget = settings.audio?.loudness;
      if (loudnessTarget !== null && loudnessTarget !== undefined) {
        loudness = await normalizeLoudness(
          session,
          mixer,
          deps.blocks,
          totalSamples,
          loudnessTarget,
          (fraction) => progress('measuring', Math.floor(fraction * frames), frames),
          signal,
        );
        clock.reset();
      }
      // The whole mix goes first, a second at a time.
      const sound = new ExportAudio(
        session,
        mixer,
        deps.blocks,
        { encode: (samples) => sink.sound(samples), finish: async () => {}, close: () => {} },
        totalSamples,
      );
      const seconds = Math.ceil(totalSamples / sampleRate);
      while (sound.position < sound.total) {
        if (signal.aborted) throw stopped(signal);
        await sound.advance(Math.min(sound.total, sound.position + sampleRate), true);
        progress('mixing', Math.ceil(sound.position / sampleRate), seconds);
      }
      clock.reset();
    }

    const project = JSON.parse(session.plan_frame(0)) as FramePlan;
    const scale = Engine.export_scale(
      settings.width,
      settings.height,
      project.width,
      project.height,
    );
    const pending: Promise<{ data: Uint8Array }>[] = [];
    let written = 0;
    const writeNext = async () => {
      const { data } = await pending.shift()!;
      await sink.frame(data);
      written++;
      progress('rendering', written, frames);
    };
    for (let index = 0; index < frames; index++) {
      if (signal.aborted) throw stopped(signal);
      const time = frameTime(index, rate);
      const planJson = session.plan_frame(time);
      const plan = JSON.parse(planJson) as FramePlan;
      const upcoming = JSON.parse(session.upcoming_layers(time, upcomingFlicks)) as LayerPlan[];
      const [layers] = await Promise.all([
        sources.gather(plan, upcoming),
        deps.fonts.ensure(planJson, plan),
      ]);
      drawFrame(engine, session, planJson, plan, layers, scale, false);
      pending.push(
        engine.read_yuv10(settings.width, settings.height, master.pixelFormat) as Promise<{
          data: Uint8Array;
        }>,
      );
      if (pending.length > readAhead) await writeNext();
    }
    while (pending.length) await writeNext();
    sources.release();
    if (signal.aborted) throw stopped(signal);
    progress('finishing', frames, frames, true);
    target.commit();
    finished = true;
  } finally {
    sources.dispose();
    mixer?.free();
    if (!finished) await target.discard();
  }
  return {
    bytes: target.bytes(),
    frames,
    durationSeconds: (frames * rate.den) / rate.num,
    elapsedMs: performance.now() - started,
    videoCodec: 'prores',
    audioCodec: mixer ? 'pcm-s24' : null,
    hardwareEncoder: false,
    backend: engine.backend(),
    loudness,
  };
}
