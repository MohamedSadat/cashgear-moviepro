import { useEffect, useState } from 'react';
import { renderPreviews } from '@cgv/engine-client';
import { headline } from './apply';
import { projectTemplates } from './templates';

/** Preview image URLs by template id, rendered once per session. */
let rendered: Promise<Record<string, string>> | null = null;

/** The templates browser's previews: each template's headline drawn by the engine over a sample picture. */
export function useTemplatePreviews(active: boolean): Record<string, string> {
  const [urls, setUrls] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!active) return;
    let live = true;
    const items = projectTemplates.flatMap((template) => {
      const title = headline(template);
      return title ? [{ id: template.id, title }] : [];
    });
    rendered ??= renderPreviews(
      items.map((item) => ({
        type: 'title' as const,
        pack: '',
        kind: item.id,
        params: {},
        title: item.title,
      })),
    ).then((images) => {
      const out: Record<string, string> = {};
      images.forEach((image, index) => {
        if (image) out[items[index].id] = URL.createObjectURL(image);
      });
      return out;
    });
    rendered.then(
      (next) => live && setUrls(next),
      (error) => {
        console.warn('Template previews failed:', error);
        rendered = null;
      },
    );
    return () => {
      live = false;
    };
  }, [active]);
  return urls;
}
