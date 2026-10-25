import type { Engine } from '../pkg/cgv_wasm';
import type { FramePlan } from '../playback/types';
import { FontCatalog } from './catalog';

/**
 * Gives one engine the font files its titles need, each once. The engine says
 * which families a frame lacks (fallbacks for letters a font has not included).
 */
export class FontLoader {
  private loading = new Map<string, Promise<void>>();
  /** Files that failed to load are not tried again. */
  private failed = new Set<string>();

  constructor(
    private readonly engine: Engine,
    private readonly catalog: FontCatalog,
  ) {}

  /** Loads every file of `families` the engine does not hold yet. */
  async load(families: string[]): Promise<void> {
    const files = families.flatMap((family) => this.catalog.files(family));
    await Promise.all(
      files.map((file) => {
        if (this.engine.has_font(file.source) || this.failed.has(file.source))
          return Promise.resolve();
        let pending = this.loading.get(file.source);
        if (!pending) {
          // A file that fails leaves its letters to the fallback fonts.
          pending = file
            .load()
            .then((bytes) => {
              if (!this.engine.has_font(file.source)) this.engine.load_font(file.source, bytes);
            })
            .catch((error) => {
              this.failed.add(file.source);
              console.warn(`Font ${file.source}: ${String(error)}`);
            })
            .finally(() => this.loading.delete(file.source));
          this.loading.set(file.source, pending);
        }
        return pending;
      }),
    );
  }

  /**
   * Loads the families the frame's titles need and the catalogue has. Resolves
   * to whether it loaded any, so a frame drawn without them can be drawn again.
   */
  async ensure(planJson: string, plan: FramePlan): Promise<boolean> {
    if (!plan.layers.some((layer) => layer.title)) return false;
    const needed = (JSON.parse(this.engine.fonts_needed(planJson)) as string[]).filter((family) =>
      this.catalog.has(family),
    );
    if (needed.length === 0) return false;
    await this.load(needed);
    return true;
  }

  /**
   * For frames that cannot wait (playing): starts loading what the frame's
   * titles need, and says whether any font is still loading.
   */
  prefetch(planJson: string, plan: FramePlan): boolean {
    if (!plan.layers.some((layer) => layer.title)) return false;
    void this.ensure(planJson, plan);
    return this.loading.size > 0;
  }
}

let bundled: FontCatalog | undefined;

/** The catalogue every engine of this worker shares: bundled fonts, and those added. */
export function fontCatalog(): FontCatalog {
  bundled ??= FontCatalog.bundled();
  return bundled;
}
