import type { CatalogItem } from './catalog';

/** The MIME type a browser item carries when dragged onto the timeline. */
export const effectDragType = 'application/x-cgv-effect';

/** What is being dragged from the effects browser: an item, or an adjustment layer. */
export type DraggedEffect = { kind: 'item'; item: CatalogItem } | { kind: 'adjustment' };

/**
 * Browsers keep drag data hidden until the drop, so the timeline reads the item
 * being dragged from here while it previews the drop.
 */
export const draggedEffect: { current: DraggedEffect | null } = { current: null };
