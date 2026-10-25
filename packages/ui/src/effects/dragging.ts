import type { Sticker } from '../stickers/catalog';
import type { TitleTemplate } from '../titles/templates';
import type { CatalogItem } from './catalog';

/** The MIME type a browser item carries when dragged onto the timeline. */
export const effectDragType = 'application/x-cgv-effect';

/**
 * What is being dragged from a browser: an effect or transition, an adjustment
 * layer, a title template (titles and shapes) or a sticker.
 */
export type DraggedEffect =
  | { kind: 'item'; item: CatalogItem }
  | { kind: 'adjustment' }
  | { kind: 'title'; template: TitleTemplate }
  | { kind: 'sticker'; sticker: Sticker };

/**
 * Browsers keep drag data hidden until the drop, so the timeline reads the item
 * being dragged from here while it previews the drop.
 */
export const draggedEffect: { current: DraggedEffect | null } = { current: null };
