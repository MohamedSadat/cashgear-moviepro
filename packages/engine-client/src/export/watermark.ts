import type { ProjectSession } from '../pkg/cgv_wasm';

// The free edition's watermark: "CashGear Video" in the bottom-right corner of every
// exported frame. The export worker adds it to its own copy of the project, as a
// title clip on a track above the others, so the engine draws it like any title,
// sharp at the export's size. The preview and the user's project never have it.

export const watermarkText = 'CashGear Video';

/** Its size and margin as fractions of the frame's shorter side. */
const textSize = 0.03;
const margin = 0.035;

interface Snapshot {
  project: { tracks: unknown[]; settings: { width: number; height: number } };
}

export function addWatermark(session: ProjectSession, duration: number) {
  const { project } = JSON.parse(session.snapshot()) as Snapshot;
  const { width, height } = project.settings;
  const short = Math.min(width, height);
  const size = Math.round(short * textSize);
  const inset = short * margin;
  // A wrap width far wider than the text, aligned right: the text ends at the
  // block's right edge whatever its width.
  const block = size * 12;
  const add = (command: object) =>
    JSON.parse(session.execute(JSON.stringify(command))) as { created: number[] };
  const [track] = add({
    type: 'addTrack',
    index: project.tracks.length,
    name: 'Watermark',
  }).created;
  add({
    type: 'overwrite',
    track,
    at: 0,
    clip: {
      kind: 'title',
      duration,
      title: {
        elements: [
          {
            id: 1,
            x: width / 2 - inset - block / 2,
            y: height / 2 - inset - size * 0.6,
            opacity: 0.8,
            fill: { r: 1, g: 1, b: 1, a: 1 },
            shadow: { color: { r: 0, g: 0, b: 0, a: 0.6 }, x: 0, y: size * 0.06, blur: size * 0.2 },
            type: 'text',
            text: watermarkText,
            font: { family: 'Inter', weight: 600 },
            size,
            align: 'right',
            wrap: block,
          },
        ],
      },
    },
  });
}
