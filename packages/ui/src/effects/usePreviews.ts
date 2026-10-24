import { useEffect, useState } from 'react';
import { renderPreviews, type PreviewRequest } from '@cgv/engine-client';
import type { Catalog, CatalogItem } from './catalog';

/** Preview image URLs by item key, rendered once per session. */
let rendered: Promise<Record<string, string>> | null = null;

function request(item: CatalogItem): PreviewRequest {
  const lut = item.entry.params.find((param) => param.type === 'lut');
  return {
    type: item.entry.type,
    pack: item.entry.pack,
    kind: item.entry.id,
    params: item.params,
    lut: lut?.id,
    // Moving transitions read best part of the way through; dips at their darkest.
    progress: item.entry.id === 'dip' ? 0.45 : 0.5,
  };
}

/** The browser's previews: each item drawn by the engine on a sample picture. */
export function usePreviews(catalog: Catalog | null): Record<string, string> {
  const [urls, setUrls] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!catalog) return;
    let live = true;
    const items = [...catalog.effects, ...catalog.transitions];
    rendered ??= renderPreviews(items.map(request)).then((images) => {
      const out: Record<string, string> = {};
      images.forEach((image, index) => {
        if (image) out[items[index].key] = URL.createObjectURL(image);
      });
      return out;
    });
    rendered.then(
      (next) => live && setUrls(next),
      (error) => {
        console.warn('Effect previews failed:', error);
        rendered = null;
      },
    );
    return () => {
      live = false;
    };
  }, [catalog]);
  return urls;
}
