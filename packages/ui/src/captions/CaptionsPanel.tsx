import { useEffect, useState } from 'react';
import { CgButton } from '@cashgear/ui';
import { FLICKS_PER_SECOND, type Clip } from '@cgv/engine-client';
import { soundClipOf } from '../ai/timing';
import type { AiToolsState } from '../ai/useAiTools';
import type { EditorState } from '../editing/useEditor';
import { AiJobRow } from '../inspector/AiSection';
import { trackLabel } from '../timeline/Timeline';
import { captionStyles, captionText, styleOf, type CaptionStyle } from './captions';
import { captionLanguages, type CaptionsState } from './useCaptions';

const megabytes = (bytes: number) => `${Math.round(bytes / 1e6)} MB`;

/** m:ss.s from flicks, for the caption list. */
function clock(flicks: number) {
  const seconds = flicks / FLICKS_PER_SECOND;
  const m = Math.floor(seconds / 60);
  return `${m}:${(seconds - m * 60).toFixed(1).padStart(4, '0')}`;
}

/** One caption: its times, its text (edited in place) and a delete button. */
function CaptionRow({
  editor,
  captions,
  clip,
  locked,
}: {
  editor: EditorState;
  captions: CaptionsState;
  clip: Clip;
  locked: boolean;
}) {
  const text = captionText(clip.title);
  const [draft, setDraft] = useState(text);
  useEffect(() => setDraft(text), [text]);
  const frame = (time: number) => {
    const rate = editor.project.snapshot?.project.settings.frameRate;
    return rate ? Math.round((time / FLICKS_PER_SECOND) * (rate.num / rate.den)) : 0;
  };
  const commit = () => {
    if (draft.trim() && draft !== text) void captions.setText(clip.id, draft);
    else setDraft(text);
  };
  return (
    <li
      className={
        'cgv-caption-row' + (editor.selected.has(clip.id) ? ' cgv-caption-row-selected' : '')
      }
      data-testid="caption-row"
      data-clip-id={clip.id}
    >
      <button
        type="button"
        className="cgv-caption-time"
        title="Go to this caption"
        onClick={() => {
          editor.select([clip.id]);
          editor.playback.seekFrame(frame(clip.start));
        }}
      >
        {clock(clip.start)}–{clock(clip.start + clip.duration)}
      </button>
      <textarea
        aria-label={`Caption at ${clock(clip.start)}`}
        dir="auto"
        rows={2}
        value={draft}
        disabled={locked}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            event.currentTarget.blur();
          } else if (event.key === 'Escape') {
            setDraft(text);
            event.currentTarget.blur();
          }
          event.stopPropagation();
        }}
      />
      <button
        type="button"
        className="cgv-icon-button"
        aria-label="Delete caption"
        title="Delete caption"
        disabled={locked}
        onClick={() => void editor.project.execute({ type: 'delete', clips: [clip.id] })}
      >
        ×
      </button>
    </li>
  );
}

/**
 * The Captions tab: the speech model (downloaded once, with its size shown
 * first), captions made from the selected clip's speech, the caption list for
 * fixing words and timing, looks, and subtitle files.
 */
export function CaptionsPanel({
  editor,
  ai,
  captions,
}: {
  editor: EditorState;
  ai: AiToolsState;
  captions: CaptionsState;
}) {
  const [language, setLanguage] = useState<string | null>(null);
  const [style, setStyle] = useState<CaptionStyle>('boxed');
  const [trackId, setTrackId] = useState<number | null>(null);
  const project = editor.project.snapshot?.project;
  const model = captions.model;
  const track = captions.tracks.find((t) => t.id === trackId) ?? captions.tracks[0] ?? null;
  const focused = editor.focused;
  const speech = project && focused ? soundClipOf(project, focused.id) : null;
  const busy = ai.jobs.some((job) => /^(Captioning|Downloading)/.test(job.label));
  const clips = track?.clips.filter((clip) => clip.caption) ?? [];
  return (
    <aside className="cgv-captions" data-testid="captions-panel" aria-label="Captions">
      <h2>Captions</h2>
      <section className="cgv-inspector-section" aria-label="Speech model">
        <h3>Speech model</h3>
        {model ? (
          <>
            <p className="cgv-muted" data-testid="caption-model">
              {model.name} ({model.license}), {megabytes(model.bytes)}.{' '}
              {model.installed
                ? 'Downloaded: captions are made on this computer.'
                : 'It downloads once; your speech stays on this computer.'}
            </p>
            {!model.installed && (
              <CgButton
                size="small"
                data-testid="download-caption-model"
                disabled={busy}
                onClick={() => void captions.install()}
              >
                Download {megabytes(model.bytes)}
              </CgButton>
            )}
          </>
        ) : (
          <p className="cgv-muted">Checking the speech model…</p>
        )}
        {ai.jobs.map((job) => (
          <AiJobRow key={job.id} job={job} />
        ))}
      </section>
      <section className="cgv-inspector-section" aria-label="Make captions">
        <h3>Make captions</h3>
        <label className="cgv-field">
          <span className="cgv-field-label">Language</span>
          <select
            aria-label="Caption language"
            data-testid="caption-language"
            value={language ?? ''}
            onChange={(event) => setLanguage(event.currentTarget.value || null)}
          >
            {captionLanguages.map((entry) => (
              <option key={entry.code ?? 'auto'} value={entry.code ?? ''}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
        <label className="cgv-field">
          <span className="cgv-field-label">Look</span>
          <select
            aria-label="Caption look"
            data-testid="caption-style"
            value={style}
            onChange={(event) => setStyle(event.currentTarget.value as CaptionStyle)}
          >
            {captionStyles.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
        <CgButton
          size="small"
          data-testid="generate-captions"
          disabled={!model?.installed || !speech || busy}
          title={speech ? undefined : 'Select a clip with speech'}
          onClick={() => {
            if (focused) void captions.generate(focused.id, language, style);
          }}
        >
          Caption the selected clip
        </CgButton>
        {!speech && <p className="cgv-muted">Select a clip with speech on the timeline.</p>}
      </section>
      {track && (
        <section className="cgv-inspector-section" aria-label="Caption list">
          <h3>
            {captions.tracks.length > 1 ? (
              <select
                aria-label="Caption track"
                value={track.id}
                onChange={(event) => setTrackId(Number(event.currentTarget.value))}
              >
                {captions.tracks.map((t) => (
                  <option key={t.id} value={t.id}>
                    {trackLabel(t, project?.tracks.indexOf(t) ?? 0)}
                  </option>
                ))}
              </select>
            ) : (
              `${clips.length} captions`
            )}
          </h3>
          <div className="cgv-inspector-row">
            <CgButton
              appearance="ghost"
              size="small"
              data-testid="restyle-captions"
              disabled={track.locked}
              onClick={() => void captions.restyle(track.id, style)}
            >
              Use this look for all
            </CgButton>
            <CgButton
              appearance="ghost"
              size="small"
              data-testid="export-srt"
              onClick={() => void captions.exportSubtitles(track.id, 'srt')}
            >
              Save SRT
            </CgButton>
            <CgButton
              appearance="ghost"
              size="small"
              data-testid="export-vtt"
              onClick={() => void captions.exportSubtitles(track.id, 'vtt')}
            >
              Save VTT
            </CgButton>
          </div>
          <p className="cgv-muted">
            {`Look: ${captionStyles.find((s) => s.id === styleOf(clips[0]?.title))?.label}. `}
            Edit a line and press Enter; drag a caption's edges on the timeline to retime it. Hide
            the track to export without them burned in.
          </p>
          <ol className="cgv-caption-list">
            {clips.map((clip) => (
              <CaptionRow
                key={clip.id}
                editor={editor}
                captions={captions}
                clip={clip}
                locked={track.locked}
              />
            ))}
          </ol>
        </section>
      )}
    </aside>
  );
}
