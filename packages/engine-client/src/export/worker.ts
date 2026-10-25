import { FontLoader, fontCatalog } from '../fonts/loader';
import { loadPackImages } from '../effects/assets';
import { expose } from 'comlink';
import { AudioBlocks } from '../media/audio-blocks';
import { MediaService } from '../media/service';
import initWasm, { Engine, MediaLibrary, ProjectSession } from '../pkg/cgv_wasm';
import { drawsGpuFrames } from '../playback/draw';
import { cancelled, runExport } from './job';
import { openTarget } from './targets';
import type { ExportWorkerApi } from './types';

// The export worker: its own engine (WASM, GPU device, decoders) and its own
// copy of the project, so editing and preview carry on while it runs. One
// worker runs one export, then the page terminates it.

const stop = new AbortController();
let started = false;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const api: ExportWorkerApi = {
  async run(job, target, events) {
    if (started) throw new Error('This export worker has already run');
    started = true;
    fontCatalog().addEntries(job.fonts ?? []);
    await initWasm({ module_or_path: new URL('../pkg/cgv_wasm_bg.wasm', import.meta.url) });
    // The engine renders off screen: its canvas is never shown.
    const engine = await Engine.create(
      new OffscreenCanvas(16, 16),
      job.backend,
      (problem: string) => stop.abort(new Error(problem)),
    );
    await loadPackImages(engine);
    const media = new MediaService(new MediaLibrary(job.platform));
    // Exports wait for every frame, so the decoders' stalls at clip ends cost nothing.
    media.decode = job.decode && job.decode !== 'auto' ? job.decode : 'fastest';
    let session: ProjectSession | null = null;
    try {
      const outcomes = await media.import(job.media.map(({ id, source }) => ({ id, source })));
      for (const outcome of outcomes)
        if ('error' in outcome)
          console.warn(`Export: ${outcome.id} could not be opened: ${outcome.error}`);
      for (const { id, proxy } of job.media)
        if (proxy)
          await media
            .attachProxy(id, proxy)
            .catch((error) => console.warn(`Export: the proxy of ${id} failed: ${message(error)}`));
      if (stop.signal.aborted) throw stop.signal.reason ?? cancelled();
      session = ProjectSession.open(job.project, false, undefined);
      const blocks = new AudioBlocks((id) => media.audioTrack(id));
      const file = await openTarget(target, events);
      return await runExport(
        {
          engine,
          fonts: new FontLoader(engine, fontCatalog()),
          media,
          session,
          blocks,
          planes: !drawsGpuFrames(engine),
          signal: stop.signal,
        },
        job,
        file,
        (progress) => void events.progress(progress),
      );
    } finally {
      session?.free();
      media.clear();
      await media.releaseFrames().catch(() => {});
      engine.dispose();
      engine.free();
    }
  },
  cancel() {
    stop.abort(cancelled());
  },
};
expose(api);
