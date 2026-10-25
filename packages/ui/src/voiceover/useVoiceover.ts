import { useCallback, useEffect, useRef, useState } from 'react';
import {
  encodeWav,
  FLICKS_PER_SECOND,
  recordingOffset,
  type EngineClient,
  type Microphone,
  type MicrophoneOptions,
  type Recording,
} from '@cgv/engine-client';
import type { PlaybackControls } from '../monitor/usePlayback';
import type { MediaPlatform } from '../platform';
import type { ProjectState } from '../project/useProject';
import { frameDuration } from '../timeline/geometry';

/** Seconds counted down before recording starts. */
export const countdownSeconds = 3;

export type VoiceoverPhase = 'closed' | 'opening' | 'ready' | 'countdown' | 'recording' | 'saving';

export interface VoiceoverState {
  phase: VoiceoverPhase;
  /** Seconds left in the countdown. */
  count: number;
  /** The input's peak level lately (linear). */
  level: number;
  devices: MediaDeviceInfo[];
  deviceId: string;
  monitoring: boolean;
  /** Seconds recorded so far. */
  elapsed: number;
  error: string | null;
  open(options?: MicrophoneOptions): Promise<void>;
  close(): void;
  chooseDevice(deviceId: string): Promise<void>;
  setMonitoring(on: boolean): void;
  /** Counts down, then records while the timeline plays from the playhead. */
  record(): void;
  /** Stops and puts the recording on a new Dialogue track at the playhead. */
  stop(): Promise<void>;
  /** Drops what is being recorded. */
  cancel(): void;
}

/** The name of the next recording: Voiceover 1.wav, Voiceover 2.wav… */
export function nextVoiceoverName(names: string[]): string {
  let highest = 0;
  for (const name of names) {
    const found = /^Voiceover (\d+)(?: \(\d+\))?\.wav$/.exec(name);
    if (found) highest = Math.max(highest, Number(found[1]));
  }
  return `Voiceover ${highest + 1}.wav`;
}

/**
 * Where a recording goes: from the playhead it started at, the recording's
 * sample that lines up with it, and how long the clip is in whole frames.
 */
export function voiceoverClip(recording: Recording, at: number, frame: number) {
  const rate = recording.rate;
  const frames = recording.planes[0]?.length ?? 0;
  const atSample = Math.round((at * rate) / FLICKS_PER_SECOND);
  const offset = Math.min(frames, Math.max(0, recordingOffset(recording, atSample)));
  const perSample = FLICKS_PER_SECOND / rate;
  const duration = Math.floor(((frames - offset) * perSample) / frame) * frame;
  return { sourceIn: Math.round(offset * perSample), duration };
}

/**
 * Voiceovers: the microphone, a countdown, recording while the timeline plays
 * and placing the take where it was heard. The microphone stays open while
 * the panel is, so its meter shows before recording starts.
 */
export function useVoiceover(
  client: EngineClient | null,
  project: ProjectState,
  playback: PlaybackControls,
  platform: MediaPlatform,
): VoiceoverState {
  const [phase, setPhase] = useState<VoiceoverPhase>('closed');
  const [count, setCount] = useState(0);
  const [level, setLevel] = useState(0);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState('');
  const [monitoring, setMonitoringState] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const mic = useRef<Microphone | null>(null);
  const take = useRef<{ at: number; timers: number[]; started: number } | null>(null);
  const latest = useRef({ project, playback, platform, client });
  latest.current = { project, playback, platform, client };

  const release = () => {
    mic.current?.close();
    mic.current = null;
  };

  const open = useCallback(async (options: MicrophoneOptions = {}): Promise<void> => {
    const engine = latest.current.client;
    if (!engine) return;
    setError(null);
    setPhase('opening');
    try {
      release();
      const opened = await engine.openMicrophone(options);
      mic.current = opened;
      let last = 0;
      opened.onLevel((peak) => {
        const now = performance.now();
        if (now - last > 50) {
          last = now;
          setLevel(peak);
        }
      });
      setDeviceId(opened.deviceId);
      setMonitoringState(false);
      const all = await navigator.mediaDevices.enumerateDevices().catch(() => []);
      setDevices(all.filter((device) => device.kind === 'audioinput'));
      setPhase('ready');
    } catch (problem) {
      setError(
        problem instanceof Error && problem.name === 'NotAllowedError'
          ? 'The microphone was not allowed. Allow it in the browser to record.'
          : `The microphone could not open: ${problem instanceof Error ? problem.message : String(problem)}`,
      );
      setPhase('closed');
    }
  }, []);

  const clearTimers = () => {
    for (const timer of take.current?.timers ?? []) clearTimeout(timer);
  };

  const cancel = useCallback(() => {
    clearTimers();
    take.current = null;
    mic.current?.stop();
    if (latest.current.playback.state?.playing) latest.current.playback.toggle();
    setPhase(mic.current ? 'ready' : 'closed');
  }, []);

  const close = useCallback(() => {
    cancel();
    release();
    setPhase('closed');
  }, [cancel]);

  useEffect(() => () => release(), []);

  const place = useCallback(async (recording: Recording, at: number) => {
    const { project: state, platform: host } = latest.current;
    const current = state.snapshot?.project;
    if (!current) return;
    const frame = frameDuration(current.settings.frameRate);
    const { sourceIn, duration } = voiceoverClip(recording, at, frame);
    if (duration < frame) {
      state.notice('Nothing was recorded.');
      return;
    }
    const name = nextVoiceoverName(current.media.map((media) => media.name));
    const wav = encodeWav(recording.planes, recording.rate);
    const library = state.library;
    const refs = host.saveRecording
      ? await library.importRequests([
          await host.saveRecording(name, wav, state.entry?.path ?? null),
        ])
      : await library.importFiles([new File([wav], name, { type: 'audio/wav' })]);
    const media = refs[0];
    if (!media) {
      state.notice('The recording could not be imported.');
      return;
    }
    await state.transaction('Record voiceover', async (step) => {
      await step({ type: 'addMedia', media });
      const [track] = await step({
        type: 'addTrack',
        index: current.tracks.length,
        name: 'Voiceover',
      });
      await step({ type: 'setTrackSound', track, sound: { role: 'dialogue' } });
      return step({
        type: 'overwrite',
        track,
        at,
        clip: { media: media.id, sourceIn, duration, video: false, audio: true },
      });
    });
  }, []);

  const stop = useCallback(async () => {
    const running = take.current;
    const opened = mic.current;
    if (!running || !opened) return;
    clearTimers();
    take.current = null;
    if (latest.current.playback.state?.playing) latest.current.playback.toggle();
    const recording = opened.stop();
    setPhase('saving');
    try {
      await place(recording, running.at);
    } catch (problem) {
      latest.current.project.notice(
        `The voiceover could not be saved: ${problem instanceof Error ? problem.message : String(problem)}`,
      );
    }
    setPhase(mic.current ? 'ready' : 'closed');
  }, [place]);

  const record = useCallback(() => {
    const opened = mic.current;
    const { playback: transport, client: engine } = latest.current;
    if (!opened || !engine || take.current) return;
    if (transport.state?.playing) transport.toggle();
    const at = transport.state?.time ?? 0;
    const current = latest.current.project.snapshot?.project;
    const rate = current?.settings.sampleRate ?? 48_000;
    const atSample = Math.round((at * rate) / FLICKS_PER_SECOND);
    // Sound from the countdown on is kept, so a take that starts early still has it.
    opened.start();
    const timers: number[] = [];
    take.current = { at, timers, started: 0 };
    setPhase('countdown');
    setElapsed(0);
    for (let left = countdownSeconds; left > 0; left--)
      timers.push(window.setTimeout(() => setCount(left), (countdownSeconds - left) * 1000));
    setCount(countdownSeconds);
    timers.push(
      window.setTimeout(() => {
        if (!take.current) return;
        // Until the timeline plays, the take lines up with the moment it should have.
        opened.setAnchor(opened.contextFrame(), atSample);
        take.current.started = performance.now();
        setPhase('recording');
        void engine.play();
        // While it plays, the engine says which sample the ring renders when.
        let precise = false;
        const anchor = async () => {
          if (!take.current) return;
          if (!precise) {
            const frame = opened.contextFrame();
            const sample = await engine.api.sampleAtContextFrame(frame);
            if (sample !== null && take.current) {
              opened.setAnchor(frame, sample);
              precise = true;
            }
          }
          setElapsed((performance.now() - (take.current?.started ?? 0)) / 1000);
          take.current?.timers.push(window.setTimeout(() => void anchor(), 250));
        };
        take.current.timers.push(window.setTimeout(() => void anchor(), 250));
      }, countdownSeconds * 1000),
    );
  }, []);

  // Pausing the timeline (Space) ends the take; reaching its end does not, so a
  // voiceover can run on past the picture.
  useEffect(
    () =>
      playback.subscribe(() => {
        const state = playback.state;
        const running = take.current;
        if (
          running &&
          running.started &&
          performance.now() - running.started > 500 &&
          state &&
          !state.playing &&
          !state.starting &&
          state.time < state.lastFrameTime
        )
          void stop();
      }),
    [playback, stop],
  );

  const chooseDevice = useCallback(
    async (next: string) => {
      if (take.current) return;
      await open({ deviceId: next });
    },
    [open],
  );

  const setMonitoring = useCallback((on: boolean) => {
    mic.current?.setMonitoring(on);
    setMonitoringState(on);
  }, []);

  return {
    phase,
    count,
    level,
    devices,
    deviceId,
    monitoring,
    elapsed,
    error,
    open,
    close,
    chooseDevice,
    setMonitoring,
    record,
    stop,
    cancel,
  };
}
