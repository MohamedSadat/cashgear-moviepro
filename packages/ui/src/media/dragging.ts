/**
 * The media item being dragged from the library. Browsers keep drag data hidden
 * until the drop, so the timeline reads the item from here while it previews.
 */
export const draggedMedia: { id: string | null } = { id: null };
