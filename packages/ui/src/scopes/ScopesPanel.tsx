import { useEffect, useRef, useState } from 'react';
import type { EngineClient, ScopeData } from '@cgv/engine-client';
import { skinToneDegrees, traceLevel, vectorTargets } from './graticule';

type Mode = 'waveform' | 'parade' | 'vectorscope' | 'histogram';

const modes: { value: Mode; label: string }[] = [
  { value: 'waveform', label: 'Waveform' },
  { value: 'parade', label: 'RGB parade' },
  { value: 'vectorscope', label: 'Vectorscope' },
  { value: 'histogram', label: 'Histogram' },
];

/** Waveform columns: about one for every five pixels of a 1080p frame. */
const columns = 384;
/** How often the scopes follow the monitor. */
const refreshMs = 125;
const levels = 256;

/** The busiest cell, ignoring the very busiest few so one flat area does not dim the rest. */
function peakOf(counts: Uint32Array): number {
  let peak = 0;
  for (const count of counts) if (count > peak) peak = count;
  return Math.max(1, peak * 0.25);
}

/** A waveform of `counts` (`levels` rows of `width`) into `image` at `left`, in `colour`. */
function drawWave(
  image: ImageData,
  counts: Uint32Array,
  width: number,
  left: number,
  colour: [number, number, number],
) {
  const peak = peakOf(counts);
  for (let level = 0; level < levels; level++)
    for (let x = 0; x < width; x++) {
      const value = traceLevel(counts[level * width + x], peak);
      if (!value) continue;
      const at = ((levels - 1 - level) * image.width + left + x) * 4;
      for (let c = 0; c < 3; c++)
        image.data[at + c] = Math.min(255, image.data[at + c] + colour[c] * value);
    }
}

function draw(canvas: HTMLCanvasElement, mode: Mode, scopes: ScopeData) {
  const context = canvas.getContext('2d')!;
  const width =
    mode === 'parade' ? scopes.columns * 3 : mode === 'waveform' ? scopes.columns : levels;
  canvas.width = width;
  canvas.height = levels;
  const image = context.createImageData(width, levels);
  for (let i = 3; i < image.data.length; i += 4) image.data[i] = 255;
  if (mode === 'waveform') drawWave(image, scopes.luma, scopes.columns, 0, [120, 255, 140]);
  if (mode === 'parade')
    [scopes.red, scopes.green, scopes.blue].forEach((counts, channel) =>
      drawWave(image, counts, scopes.columns, channel * scopes.columns, [
        channel === 0 ? 255 : 60,
        channel === 1 ? 255 : 60,
        channel === 2 ? 255 : 60,
      ]),
    );
  if (mode === 'vectorscope') {
    const peak = peakOf(scopes.vector);
    for (let row = 0; row < levels; row++)
      for (let col = 0; col < levels; col++) {
        const value = traceLevel(scopes.vector[row * levels + col], peak);
        if (!value) continue;
        const at = ((levels - 1 - row) * width + col) * 4;
        image.data[at] = 120 * value;
        image.data[at + 1] = 255 * value;
        image.data[at + 2] = 140 * value;
      }
  }
  if (mode === 'histogram') {
    const channels = [0, 1, 2].map((c) => scopes.histogram.subarray(c * levels, (c + 1) * levels));
    let peak = 1;
    for (const counts of channels) for (const count of counts) peak = Math.max(peak, count);
    channels.forEach((counts, c) => {
      for (let x = 0; x < levels; x++) {
        const height = Math.round(Math.sqrt(counts[x] / peak) * (levels - 1));
        for (let y = 0; y < height; y++) {
          const at = ((levels - 1 - y) * width + x) * 4;
          image.data[at + c] = Math.min(255, image.data[at + c] + 200);
        }
      }
    });
  }
  context.putImageData(image, 0, 0);
  // The graticule.
  context.strokeStyle = 'rgba(255, 255, 255, 0.25)';
  context.fillStyle = 'rgba(255, 255, 255, 0.55)';
  context.font = '9px sans-serif';
  context.lineWidth = 1;
  if (mode === 'waveform' || mode === 'parade') {
    for (const percent of [0, 25, 50, 75, 100]) {
      const y = Math.round((levels - 1) * (1 - percent / 100)) + 0.5;
      context.beginPath();
      context.moveTo(0, y);
      context.lineTo(width, y);
      context.stroke();
      context.fillText(String(percent), 2, Math.max(9, y - 2));
    }
  }
  if (mode === 'vectorscope') {
    const centre = levels / 2;
    context.beginPath();
    context.arc(centre, centre, centre - 1, 0, 2 * Math.PI);
    context.moveTo(0, centre);
    context.lineTo(levels, centre);
    context.moveTo(centre, 0);
    context.lineTo(centre, levels);
    context.stroke();
    const angle = (skinToneDegrees * Math.PI) / 180;
    context.strokeStyle = 'rgba(255, 200, 150, 0.6)';
    context.beginPath();
    context.moveTo(centre, centre);
    context.lineTo(centre + Math.cos(angle) * centre, centre - Math.sin(angle) * centre);
    context.stroke();
    context.strokeStyle = 'rgba(255, 255, 255, 0.6)';
    for (const target of vectorTargets) {
      const x = (target.cb + 0.5) * levels;
      const y = (0.5 - target.cr) * levels;
      context.strokeRect(x - 5, y - 5, 10, 10);
      context.fillText(target.name, x + 7, y + 3);
    }
  }
}

/**
 * Scopes of the monitor's picture: the waveform, the RGB parade, the
 * vectorscope with the 75% bars' targets and the skin-tone line, and the
 * histogram. The engine counts them from the composed frame a few times a
 * second, so they follow playback and every edit.
 */
export function ScopesPanel({ client }: { client: EngineClient | null }) {
  const [mode, setMode] = useState<Mode>('waveform');
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!client) return;
    let stopped = false;
    let timer = 0;
    const tick = async () => {
      if (stopped) return;
      if (document.visibilityState === 'visible') {
        const scopes = await client.api.readScopes(columns).catch(() => null);
        if (stopped) return;
        if (scopes && canvas.current) draw(canvas.current, mode, scopes);
      }
      timer = window.setTimeout(() => void tick(), refreshMs);
    };
    void tick();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [client, mode]);

  return (
    <div className="cgv-scopes" data-testid="scopes-panel">
      <div className="cgv-scopes-bar">
        <select
          aria-label="Scope"
          data-testid="scopes-mode"
          value={mode}
          onChange={(event) => setMode(event.target.value as Mode)}
        >
          {modes.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <canvas
        ref={canvas}
        className="cgv-scopes-canvas"
        data-testid="scopes-canvas"
        data-mode={mode}
        width={columns}
        height={levels}
      />
    </div>
  );
}
