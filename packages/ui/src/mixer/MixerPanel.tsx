import { useCallback } from 'react';
import {
  defaultDucking,
  type Command,
  type MeterReading,
  type Track,
  type TrackRole,
  type TrackSound,
} from '@cgv/engine-client';
import type { EditorState } from '../editing/useEditor';
import { ScrubField } from '../inspector/fields';
import { trackLabel } from '../timeline/Timeline';
import { LevelMeter, LoudnessReadout } from './LevelMeter';
import type { MeterStore } from './useMeters';

const roles: { value: TrackRole; label: string }[] = [
  { value: 'none', label: 'No role' },
  { value: 'dialogue', label: 'Dialogue' },
  { value: 'music', label: 'Music' },
  { value: 'effects', label: 'Effects' },
];

const sound = (track: Track, change: TrackSound): Command => ({
  type: 'setTrackSound',
  track: track.id,
  sound: change,
});

/** Pan as the strip shows it: L50, C, R25. */
export function panLabel(pan: number) {
  const percent = Math.round(Math.abs(pan) * 100);
  return percent === 0 ? 'C' : `${pan < 0 ? 'L' : 'R'}${percent}`;
}

function TrackStrip({
  editor,
  meters,
  track,
  index,
  soloing,
}: {
  editor: EditorState;
  meters: MeterStore;
  track: Track;
  index: number;
  soloing: boolean;
}) {
  const label = trackLabel(track, index);
  const run = (command: Command) => void editor.project.execute(command);
  const pick = useCallback(
    (reading: MeterReading) => reading.tracks.find((t) => t.id === track.id)?.level ?? null,
    [track.id],
  );
  const role = track.role ?? 'none';
  const ducking = track.ducking ?? defaultDucking;
  const silenced = track.muted || (soloing && !track.solo);
  return (
    <div
      className="cgv-mixer-strip"
      data-testid="mixer-strip"
      data-track-id={track.id}
      data-silenced={silenced}
    >
      <div className="cgv-mixer-strip-head">
        <span className="cgv-mixer-name" title={label}>
          {label}
        </span>
        <button
          type="button"
          className="cgv-mixer-toggle"
          aria-pressed={track.muted}
          aria-label={`${track.muted ? 'Unmute' : 'Mute'} ${label}`}
          title={track.muted ? 'Unmute' : 'Mute'}
          data-testid="mixer-mute"
          onClick={() => run({ type: 'setTrackMuted', track: track.id, muted: !track.muted })}
        >
          M
        </button>
        <button
          type="button"
          className="cgv-mixer-toggle cgv-mixer-solo"
          aria-pressed={!!track.solo}
          aria-label={`${track.solo ? 'Unsolo' : 'Solo'} ${label}`}
          title={track.solo ? 'Unsolo' : 'Solo: hear only soloed tracks'}
          data-testid="mixer-solo"
          onClick={() => run(sound(track, { solo: !track.solo }))}
        >
          S
        </button>
      </div>
      <label className="cgv-mixer-role">
        <span className="cgv-muted">Role</span>
        <select
          aria-label={`Role of ${label}`}
          data-testid="mixer-role"
          value={role}
          onChange={(event) => run(sound(track, { role: event.currentTarget.value as TrackRole }))}
        >
          {roles.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <LevelMeter
        meters={meters}
        pick={pick}
        label={`${label} level`}
        testId={`meter-track-${track.id}`}
      />
      <div className="cgv-mixer-fields">
        <ScrubField
          label="Volume"
          value={track.volumeDb ?? 0}
          min={-60}
          max={12}
          step={0.1}
          precision={1}
          unit="dB"
          testId="mixer-volume"
          editor={editor}
          command={(volumeDb) => sound(track, { volumeDb })}
        />
        <ScrubField
          label={`Pan ${panLabel(track.pan ?? 0)}`}
          value={(track.pan ?? 0) * 100}
          min={-100}
          max={100}
          step={1}
          precision={0}
          unit=""
          testId="mixer-pan"
          editor={editor}
          command={(pan) => sound(track, { pan: pan / 100 })}
        />
      </div>
      {role === 'music' && (
        <div className="cgv-mixer-ducking" data-testid="mixer-ducking">
          <label className="cgv-check">
            <input
              type="checkbox"
              data-testid="mixer-duck"
              checked={ducking.enabled}
              onChange={(event) =>
                run(sound(track, { ducking: { ...ducking, enabled: event.currentTarget.checked } }))
              }
            />
            Lower under dialogue
          </label>
          {ducking.enabled && (
            <>
              <ScrubField
                label="By"
                value={ducking.amountDb}
                min={0}
                max={40}
                step={0.5}
                precision={1}
                unit="dB"
                testId="mixer-duck-amount"
                editor={editor}
                command={(amountDb) => sound(track, { ducking: { ...ducking, amountDb } })}
              />
              <ScrubField
                label="Fade"
                value={ducking.release}
                min={0.05}
                max={5}
                step={0.01}
                precision={2}
                unit="s"
                testId="mixer-duck-release"
                editor={editor}
                command={(release) => sound(track, { ducking: { ...ducking, release } })}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The mixer: the master's meters and loudness, and a strip per track with its
 * role, mute, solo, volume, pan and ducking. Meters move while sound plays.
 */
export function MixerPanel({ editor, meters }: { editor: EditorState; meters: MeterStore }) {
  const project = editor.project.snapshot?.project;
  const pickMaster = useCallback((reading: MeterReading) => reading.master, []);
  if (!project)
    return (
      <aside className="cgv-mixer" aria-label="Mixer" data-testid="mixer">
        <p className="cgv-muted">Open a project to mix its tracks.</p>
      </aside>
    );
  const soloing = project.tracks.some((track) => track.solo);
  const tracks = project.tracks.map((track, index) => ({ track, index })).reverse();
  const hasDialogue = project.tracks.some((track) => track.role === 'dialogue');
  const hasMusic = project.tracks.some((track) => track.role === 'music');
  return (
    <aside className="cgv-mixer" aria-label="Mixer" data-testid="mixer">
      <div className="cgv-mixer-master" data-testid="mixer-master">
        <h3>Master</h3>
        <LevelMeter meters={meters} pick={pickMaster} label="Master level" testId="meter-master" />
        <LoudnessReadout meters={meters} />
      </div>
      {hasMusic && !hasDialogue && (
        <p className="cgv-muted">Mark a track as Dialogue for music to dip under it.</p>
      )}
      {tracks.map(({ track, index }) => (
        <TrackStrip
          key={track.id}
          editor={editor}
          meters={meters}
          track={track}
          index={index}
          soloing={soloing}
        />
      ))}
    </aside>
  );
}
