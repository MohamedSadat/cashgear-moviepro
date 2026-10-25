import { useEffect, useState } from 'react';
import { renderPreviews } from '@cgv/engine-client';
import { titleItems } from './TitlesBrowser';

/** Preview image URLs by template id, rendered once per session. */
let rendered: Promise<Record<string, string>> | null = null;

/** The titles browser's previews: each template drawn by the engine over a sample picture. */
export function useTitlePreviews(active: boolean): Record<string, string> {
  const [urls, setUrls] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!active) return;
    let live = true;
    rendered ??= renderPreviews(
      titleItems.map((item) => ({
        type: 'title' as const,
        pack: '',
        kind: item.id,
        params: {},
        title: item.title,
      })),
    ).then((images) => {
      const out: Record<string, string> = {};
      images.forEach((image, index) => {
        if (image) out[titleItems[index].id] = URL.createObjectURL(image);
      });
      return out;
    });
    rendered.then(
      (next) => live && setUrls(next),
      (error) => {
        console.warn('Title previews failed:', error);
        rendered = null;
      },
    );
    return () => {
      live = false;
    };
  }, [active]);
  return urls;
}
