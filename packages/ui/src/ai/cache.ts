import {
  sceneAnalysisVersion,
  soundAnalysisVersion,
  type CacheStore,
  type SceneAnalysis,
  type SoundAnalysis,
} from '@cgv/engine-client';

// Analyses kept per media file under `media/<id>/ai/`, so every clip of a file
// and every later session reuses them; dropping a changed file's caches drops
// them too. Each has a JSON note with its version, written after its arrays, so
// a note means the arrays are complete.

const key = (media: string, file: string) => `media/${media}/ai/${file}`;
const bytesOf = (values: Float32Array | Float64Array) =>
  new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
const copy = (bytes: Uint8Array) =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

async function readNote(cache: CacheStore, media: string, name: string, version: number) {
  const bytes = await cache.read(key(media, `${name}.json`));
  if (!bytes) return null;
  const note = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, number>;
  return note.version === version ? note : null;
}

async function writeNote(
  cache: CacheStore,
  media: string,
  name: string,
  note: Record<string, number>,
) {
  await cache.write(key(media, `${name}.json`), new TextEncoder().encode(JSON.stringify(note)));
}

export async function readSound(cache: CacheStore, media: string): Promise<SoundAnalysis | null> {
  const note = await readNote(cache, media, 'sound', soundAnalysisVersion);
  if (!note) return null;
  const [levels, onsets] = await Promise.all([
    cache.read(key(media, 'levels.f32')),
    cache.read(key(media, 'onsets.f32')),
  ]);
  if (!levels || !onsets) return null;
  return {
    start: note.start,
    levels: new Float32Array(copy(levels)),
    onsets: new Float32Array(copy(onsets)),
  };
}

export async function writeSound(cache: CacheStore, media: string, analysis: SoundAnalysis) {
  await cache.write(key(media, 'levels.f32'), bytesOf(analysis.levels));
  await cache.write(key(media, 'onsets.f32'), bytesOf(analysis.onsets));
  await writeNote(cache, media, 'sound', {
    version: soundAnalysisVersion,
    start: analysis.start,
    readings: analysis.levels.length,
  });
}

export async function readScenes(cache: CacheStore, media: string): Promise<SceneAnalysis | null> {
  const note = await readNote(cache, media, 'scenes', sceneAnalysisVersion);
  if (!note) return null;
  const [times, scores, skips] = await Promise.all([
    cache.read(key(media, 'frame-times.f64')),
    cache.read(key(media, 'frame-scores.f32')),
    cache.read(key(media, 'frame-skips.f32')),
  ]);
  if (!times || !scores || !skips) return null;
  return {
    times: new Float64Array(copy(times)),
    scores: new Float32Array(copy(scores)),
    skips: new Float32Array(copy(skips)),
  };
}

export async function writeScenes(cache: CacheStore, media: string, analysis: SceneAnalysis) {
  await cache.write(key(media, 'frame-times.f64'), bytesOf(analysis.times));
  await cache.write(key(media, 'frame-scores.f32'), bytesOf(analysis.scores));
  await cache.write(key(media, 'frame-skips.f32'), bytesOf(analysis.skips));
  await writeNote(cache, media, 'scenes', {
    version: sceneAnalysisVersion,
    frames: analysis.times.length,
  });
}
