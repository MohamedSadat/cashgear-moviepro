import {
  AudioSampleSource,
  EncodedAudioPacketSource,
  EncodedVideoPacketSource,
  MkvOutputFormat,
  MovOutputFormat,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  WavOutputFormat,
  WebMOutputFormat,
  type OutputFormat,
} from 'mediabunny';
import type { AudioBlocks } from '../media/audio-blocks';
import type { MediaService } from '../media/service';
import { Engine, Mixer, type ProjectSession } from '../pkg/cgv_wasm';
import { drawFrame } from '../playback/draw';
import type { FramePlan, LayerPlan } from '../playback/types';
import { FLICKS_PER_SECOND } from '../project/types';
import { ExportAudio } from './audio';
import {
  AudioTrackEncoder,
  chooseVideoConfig,
  exportColorSpace,
  PcmTrack,
  VideoTrackEncoder,
  type AudioTrackSink,
} from './encoders';
import { ExportFrames } from './frames';
import { ProgressClock } from './progress';
import {
  audioCodecString,
  formatInfo,
  fps,
  frameCount,
  frameMicroseconds,
  frameTime,
  videoCodecString,
} from './settings';
import type { OpenTarget } from './targets';
import type { ExportJob, ExportProgress, ExportResult } from './types';

/** Seconds between key frames. */
const keyFrameSeconds = 2;
/** Frames whose readback runs while the next one is drawn. */
const readAhead = 2;
/** Clips starting this soon get their decoders started. */
const upcomingFlicks = 2 * FLICKS_PER_SECOND;
/** Sound may trail the picture by this much before the export waits for it. */
const audioLagSeconds = 2;
/** Progress reports, at most this often. */
const reportMs = 100;

export interface ExportDeps {
  engine: Engine;
  media: MediaService;
  session: ProjectSession;
  blocks: AudioBlocks;
  /** Copy decoder frames to planes (WebGL2, software GPUs). */
  planes: boolean;
  /** Set when the user cancels. */
  signal: AbortSignal;
}

interface Nv12 {
  width: number;
  height: number;
  stride: number;
  data: Uint8Array;
}

export function cancelled(): DOMException {
  return new DOMException('The export was cancelled', 'AbortError');
}

/** Why the export stopped: a cancel, or a GPU failure the engine reported. */
function stopped(signal: AbortSignal): unknown {
  return signal.reason ?? cancelled();
}

// MP4 and MOV keep their index at the front, which YouTube prefers: space for it
// is reserved from the packet counts, known in advance.
function outputFormat(container: string): OutputFormat {
  switch (container) {
    case 'mp4':
      return new Mp4OutputFormat({ fastStart: 'reserve' });
    case 'mov':
      return new MovOutputFormat({ fastStart: 'reserve' });
    case 'webm':
      return new WebMOutputFormat();
    case 'mkv':
      return new MkvOutputFormat();
    case 'wav':
      return new WavOutputFormat({ large: true });
    default:
      throw new Error(`Unknown export container ${container}`);
  }
}

/**
 * Renders, mixes, encodes and muxes one export. Every frame goes through the
 * same `renderFrame(t)` as the preview, at full quality, waiting for each
 * source; the composition is read back as NV12 and encoded. Sound is mixed by
 * the playback mixer, offline, and kept within a couple of seconds of the picture.
 */
export async function runExport(
  deps: ExportDeps,
  job: ExportJob,
  target: OpenTarget,
  report: (progress: ExportProgress) => void,
): Promise<ExportResult> {
  const { engine, session, signal } = deps;
  const settings = job.settings;
  const info = formatInfo(settings.format);
  const container = info.convertedFrom ?? info.id;
  const rate = settings.frameRate;
  const duration = session.duration();
  const video = info.video.length && settings.video ? settings.video : null;
  const audio = info.audio.length && settings.audio ? settings.audio : null;
  if (!video && !audio) throw new Error('This export has neither picture nor sound');
  const frames = video ? frameCount(duration, rate) : 0;
  if (duration <= 0) throw new Error('The timeline is empty: there is nothing to export');
  const sampleRate = session.sample_rate();
  const channels = session.channels();
  const totalSamples = video
    ? Math.round((frames * rate.den * sampleRate) / rate.num)
    : Math.ceil((duration * sampleRate) / FLICKS_PER_SECOND);

  const started = performance.now();
  const clock = new ProgressClock();
  let lastReport = 0;
  const units = video ? frames : Math.ceil(totalSamples / sampleRate);
  const progress = (phase: ExportProgress['phase'], done: number, force = false) => {
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
  progress('preparing', 0, true);

  const output = new Output({
    format: outputFormat(container),
    target: new StreamTarget(target.writable, { chunked: true, chunkSize: 8 * 1024 * 1024 }),
  });
  let videoEncoder: VideoTrackEncoder | null = null;
  let videoCodec: string | null = null;
  let hardware: boolean | null = null;
  if (video) {
    const codec = videoCodecString(
      video.codec,
      settings.width,
      settings.height,
      fps(rate),
      video.bitrate,
    );
    const chosen = await chooseVideoConfig({
      codec,
      width: settings.width,
      height: settings.height,
      bitrate: video.bitrate,
      bitrateMode: 'variable',
      framerate: fps(rate),
      latencyMode: 'quality',
      ...(video.codec === 'avc' ? { avc: { format: 'avc' } } : {}),
      ...(video.codec === 'hevc' ? { hevc: { format: 'hevc' } } : {}),
    } as VideoEncoderConfig);
    if (!chosen)
      throw new Error(
        `This browser cannot encode ${codec} at ${settings.width}×${settings.height}.`,
      );
    const track = new EncodedVideoPacketSource(video.codec);
    output.addVideoTrack(track, { frameRate: fps(rate), maximumPacketCount: frames + 16 });
    videoEncoder = new VideoTrackEncoder(chosen.config, track);
    videoCodec = codec;
    hardware = chosen.hardware;
  }

  let sink: AudioTrackSink | null = null;
  let audioCodec: string | null = null;
  if (audio) {
    // About one packet per 10 ms is the most any codec here makes.
    const maximumPacketCount = Math.ceil((totalSamples / sampleRate) * 100) + 64;
    if (audio.codec === 'pcm-s16') {
      const track = new AudioSampleSource({ codec: 'pcm-s16' });
      output.addAudioTrack(track, { maximumPacketCount });
      sink = new PcmTrack(track, sampleRate, channels);
    } else {
      const config: AudioEncoderConfig = {
        codec: audioCodecString(audio.codec),
        sampleRate,
        numberOfChannels: channels,
        bitrate: audio.bitrate,
      };
      const support = await AudioEncoder.isConfigSupported(config).catch(() => null);
      if (!support?.supported)
        throw new Error(`This browser cannot encode ${audio.codec.toUpperCase()} sound.`);
      const track = new EncodedAudioPacketSource(audio.codec);
      output.addAudioTrack(track, { maximumPacketCount });
      sink = new AudioTrackEncoder(config, track);
    }
    audioCodec = audioCodecString(audio.codec);
  }

  const mixer = sink ? new Mixer(sampleRate, channels) : null;
  const sound =
    sink && mixer ? new ExportAudio(session, mixer, deps.blocks, sink, totalSamples) : null;
  const sources = new ExportFrames(engine, deps.media, deps.planes);
  let finished = false;
  try {
    await output.start();
    if (videoEncoder) {
      const project = JSON.parse(session.plan_frame(0)) as FramePlan;
      const scale = Engine.export_scale(
        settings.width,
        settings.height,
        project.width,
        project.height,
      );
      const keyEvery = Math.max(1, Math.round(keyFrameSeconds * fps(rate)));
      const pending: { index: number; pixels: Promise<Nv12> }[] = [];
      const encodeNext = async () => {
        const { index, pixels } = pending.shift()!;
        const nv12 = await pixels;
        const timestamp = frameMicroseconds(index, rate);
        const frame = new VideoFrame(nv12.data, {
          format: 'NV12',
          codedWidth: nv12.width,
          codedHeight: nv12.height,
          timestamp,
          duration: frameMicroseconds(index + 1, rate) - timestamp,
          layout: [
            { offset: 0, stride: nv12.stride },
            { offset: nv12.stride * nv12.height, stride: nv12.stride },
          ],
          colorSpace: exportColorSpace,
          transfer: [nv12.data.buffer as ArrayBuffer],
        } as VideoFrameBufferInit);
        try {
          await videoEncoder!.encode(frame, index % keyEvery === 0);
        } finally {
          frame.close();
        }
        progress('rendering', index + 1);
      };
      for (let index = 0; index < frames; index++) {
        if (signal.aborted) throw stopped(signal);
        const time = frameTime(index, rate);
        const planJson = session.plan_frame(time);
        const plan = JSON.parse(planJson) as FramePlan;
        const upcoming = JSON.parse(session.upcoming_layers(time, upcomingFlicks)) as LayerPlan[];
        const layers = await sources.gather(plan, upcoming);
        drawFrame(engine, planJson, layers, scale, false);
        pending.push({
          index,
          pixels: engine.read_nv12(settings.width, settings.height) as Promise<Nv12>,
        });
        if (pending.length > readAhead) await encodeNext();
        if (sound) {
          const until = Math.round(((index + 1) * rate.den * sampleRate) / rate.num);
          await sound.advance(until, until - sound.position > audioLagSeconds * sampleRate);
        }
      }
      while (pending.length) await encodeNext();
      sources.release();
    }
    if (sound) {
      // Audio-only exports report progress a second of sound at a time.
      while (sound.position < sound.total) {
        if (signal.aborted) throw stopped(signal);
        await sound.advance(Math.min(sound.total, sound.position + sampleRate), true);
        if (!videoEncoder) progress('rendering', Math.ceil(sound.position / sampleRate));
      }
    }
    progress('finishing', units, true);
    await videoEncoder?.finish();
    await sink?.finish();
    if (signal.aborted) throw stopped(signal);
    target.commit();
    await output.finalize();
    finished = true;
  } finally {
    sources.dispose();
    mixer?.free();
    if (!finished) {
      videoEncoder?.close();
      sink?.close();
      if (output.state === 'started') await output.cancel().catch(() => {});
      await target.discard();
    }
  }
  return {
    bytes: target.bytes(),
    frames,
    durationSeconds: video ? (frames * rate.den) / rate.num : totalSamples / sampleRate,
    elapsedMs: performance.now() - started,
    videoCodec,
    audioCodec,
    hardwareEncoder: hardware,
    backend: engine.backend(),
  };
}
