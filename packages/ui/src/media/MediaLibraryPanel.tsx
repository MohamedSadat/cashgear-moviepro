import { useEffect, useRef, useState, type DragEvent } from 'react';
import type { MediaItem, MediaRef } from '@cgv/engine-client';
import { mediaAccept } from '../platform';
import type { ProjectState } from '../project/useProject';
import { mediaDragType } from '../timeline/controller';
import { draggedMedia } from './dragging';
import type { MediaVisuals } from './useMediaLibrary';

const accept = Object.values(mediaAccept).flat().join(',');

function formatSize(bytes: number) {
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(1) + ' GB';
  if (bytes >= 1024 ** 2) return (bytes / 1024 ** 2).toFixed(1) + ' MB';
  return Math.max(1, Math.round(bytes / 1024)) + ' KB';
}

/** One line of facts: duration · resolution · frame rate · codecs. */
export function describe(item: MediaItem): string[] {
  const parts: string[] = [];
  if (item.durationLabel) parts.push(item.durationLabel);
  if (item.video) {
    parts.push(
      `${item.video.width}×${item.video.height}`,
      `${item.video.frameRateLabel} fps`,
      item.video.codecLabel,
    );
    if (item.video.rotation) parts.push(`rotated ${item.video.rotation}°`);
  }
  if (item.image)
    parts.push(
      `${item.image.width}×${item.image.height}`,
      item.image.animated ? `animated ${item.image.codecLabel}` : item.image.codecLabel,
    );
  if (item.audio)
    parts.push(
      `${item.audio.codecLabel} ${item.audio.sampleRate / 1000} kHz ${item.audio.channelLabel}`,
    );
  return parts;
}

function Waveform({ peaks }: { peaks: Int8Array }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext('2d');
    if (!element || !context) return;
    const { width, height } = element;
    context.clearRect(0, 0, width, height);
    context.fillStyle = '#3d8bfd';
    const buckets = peaks.length / 2;
    for (let x = 0; x < width; x++) {
      const start = Math.floor((x / width) * buckets);
      const end = Math.max(start + 1, Math.floor(((x + 1) / width) * buckets));
      let min = 0;
      let max = 0;
      for (let b = start; b < end && b < buckets; b++) {
        min = Math.min(min, peaks[b * 2]);
        max = Math.max(max, peaks[b * 2 + 1]);
      }
      const top = height / 2 - (max / 127) * (height / 2);
      const bottom = height / 2 - (min / 127) * (height / 2);
      context.fillRect(x, top, 1, Math.max(1, bottom - top));
    }
  }, [peaks]);
  return (
    <canvas
      ref={canvas}
      className="cgv-media-waveform"
      width={160}
      height={90}
      data-testid="media-waveform"
    />
  );
}

function Poster({ item, visuals }: { item: MediaItem; visuals: MediaVisuals | undefined }) {
  const [frame, setFrame] = useState(0);
  const thumbnails = visuals?.thumbnails ?? [];
  if (thumbnails.length)
    return (
      <img
        className="cgv-media-poster"
        src={thumbnails[Math.min(frame, thumbnails.length - 1)]}
        alt=""
        data-testid="media-thumbnail"
        data-count={thumbnails.length}
        onMouseMove={(event) => {
          // Scrub the filmstrip by hovering across the poster.
          const rect = event.currentTarget.getBoundingClientRect();
          setFrame(Math.floor(((event.clientX - rect.left) / rect.width) * thumbnails.length));
        }}
        onMouseLeave={() => setFrame(0)}
      />
    );
  if (visuals?.waveform) return <Waveform peaks={visuals.waveform.peaks} />;
  return <div className="cgv-media-poster cgv-media-poster-empty">{item.kind}</div>;
}

function Status({ item }: { item: MediaItem }) {
  const status = item.status;
  switch (status.state) {
    case 'ready':
      return null;
    case 'proxyNeeded':
      return (
        <p className="cgv-media-status" data-testid="media-status">
          Proxy queued
        </p>
      );
    case 'proxyRunning':
      return (
        <div
          className="cgv-media-status"
          data-testid="media-status"
          data-progress={status.progress}
        >
          Making proxy {Math.round(status.progress * 100)}%
          <progress max={1} value={status.progress} />
        </div>
      );
    case 'proxyReady':
      return (
        <p className="cgv-media-status cgv-media-status-ok" data-testid="media-status">
          Edited through a 720p proxy
        </p>
      );
    case 'proxyFailed':
      return (
        <p
          className="cgv-media-status cgv-media-status-error"
          data-testid="media-status"
          role="alert"
        >
          Proxy failed: {status.message}
        </p>
      );
    case 'unsupported':
      return (
        <p
          className="cgv-media-status cgv-media-status-error"
          data-testid="media-status"
          role="alert"
        >
          {status.message}
        </p>
      );
  }
}

/** A project's bin entry: the reference it keeps and, once opened, the engine's item. */
interface BinEntry {
  media: MediaRef;
  item: MediaItem | null;
  missing: boolean;
}

function playable(item: MediaItem) {
  return item.status.state === 'ready' || item.status.state === 'proxyReady';
}

export function MediaLibraryPanel({ project }: { project: ProjectState }) {
  const library = project.library;
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const missing = new Set(project.missing.map((media) => media.id));
  const entries: BinEntry[] = (project.snapshot?.project.media ?? []).map((media) => ({
    media,
    item: library.items.find((item) => item.id === media.id) ?? null,
    missing: missing.has(media.id),
  }));
  const fromLibrary = (event: DragEvent) => event.dataTransfer.types.includes(mediaDragType);
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    if (!fromLibrary(event)) void project.importDrop(event.dataTransfer);
  };
  return (
    <aside
      className={'cgv-library' + (dragging ? ' cgv-library-drop' : '')}
      data-testid="media-library"
      aria-label="Media library"
      onDragOver={(event) => {
        event.preventDefault();
        if (!fromLibrary(event)) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <header className="cgv-library-header">
        <h2>Media</h2>
        <button
          type="button"
          onClick={() => void project.pick()}
          disabled={library.busy || !project.snapshot}
        >
          {library.busy ? 'Importing…' : 'Import'}
        </button>
        {/* Fallback picker for browsers without File System Access; tests also use it. */}
        <input
          ref={input}
          type="file"
          multiple
          accept={accept}
          hidden
          data-testid="media-file-input"
          onChange={(event) => {
            if (event.target.files?.length) void project.importFiles([...event.target.files]);
            event.target.value = '';
          }}
        />
      </header>
      {library.waiting > 0 && (
        <div className="cgv-library-notice" role="status">
          {library.waiting} file{library.waiting === 1 ? '' : 's'} in this project need access
          again.
          <button type="button" onClick={() => void project.grantAccess()}>
            Allow access
          </button>
        </div>
      )}
      {project.missing.length > 0 && !project.relinking && (
        <div className="cgv-library-notice" role="status">
          {project.missing.length} file{project.missing.length === 1 ? ' is' : 's are'} missing.
          <button type="button" onClick={() => project.showRelink(true)}>
            Relink…
          </button>
        </div>
      )}
      {library.notices.map((text, index) => (
        <div
          key={index}
          className="cgv-library-notice cgv-library-notice-error"
          role="alert"
          data-testid="media-notice"
        >
          {text}
          <button type="button" aria-label="Dismiss" onClick={() => library.dismissNotice(index)}>
            ×
          </button>
        </div>
      ))}
      {entries.length === 0 ? (
        <p className="cgv-library-empty">
          Drop video, audio or image files here, or choose Import.
        </p>
      ) : (
        <ul className="cgv-library-items">
          {entries.map(({ media, item, missing: lost }) => (
            <li
              key={media.id}
              className={'cgv-media-item' + (lost ? ' cgv-media-item-missing' : '')}
              draggable={!!item && playable(item)}
              title={item && playable(item) ? 'Drag onto the timeline' : undefined}
              onDragStart={(event) => {
                draggedMedia.id = media.id;
                event.dataTransfer.setData(mediaDragType, media.id);
                event.dataTransfer.effectAllowed = 'copy';
              }}
              onDragEnd={() => (draggedMedia.id = null)}
              data-testid="media-item"
              data-media-id={media.id}
              data-name={item?.name ?? media.name}
              data-kind={media.kind}
              data-status={lost ? 'missing' : (item?.status.state ?? 'opening')}
            >
              {item ? (
                <Poster item={item} visuals={library.visuals[media.id]} />
              ) : (
                <div className="cgv-media-poster cgv-media-poster-empty">{media.kind}</div>
              )}
              <div className="cgv-media-text">
                <p className="cgv-media-name" title={item?.name ?? media.name}>
                  {item?.name ?? media.name}
                </p>
                {item && (
                  <p className="cgv-media-meta" data-testid="media-meta">
                    {describe(item).join(' · ')}
                  </p>
                )}
                <p className="cgv-media-size">{formatSize(item?.size ?? media.size)}</p>
                {item && <Status item={item} />}
                {lost && (
                  <p className="cgv-media-status cgv-media-status-error" data-testid="media-status">
                    Missing{' '}
                    <button type="button" onClick={() => void project.locate(media)}>
                      Locate…
                    </button>
                  </p>
                )}
                {item && playable(item) && (
                  <button
                    type="button"
                    className="cgv-media-add"
                    onClick={() => void project.addToTimeline(media.id)}
                    aria-label={`Add ${media.name} to the timeline`}
                  >
                    Add to timeline
                  </button>
                )}
              </div>
              <button
                type="button"
                className="cgv-media-remove"
                aria-label={`Remove ${media.name}`}
                onClick={() => void project.removeMedia(media.id)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
