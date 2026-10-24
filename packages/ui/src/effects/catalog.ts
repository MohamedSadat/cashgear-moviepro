import { useEffect, useState } from 'react';
import type {
  CatalogEntry,
  Color,
  EffectVariant,
  EngineClient,
  LookInfo,
  ParamDef,
  ParamValue,
  Params,
} from '@cgv/engine-client';

/** One item of the browser: a definition, or one of its variants. */
export interface CatalogItem {
  /** `pack/id`, or `pack/id:variant`. */
  key: string;
  entry: CatalogEntry;
  variant: EffectVariant | null;
  name: string;
  /** The settings the item sets: its variant's, or none. */
  params: Params;
}

export interface Catalog {
  entries: CatalogEntry[];
  effects: CatalogItem[];
  transitions: CatalogItem[];
  looks: LookInfo[];
  find(pack: string, id: string): CatalogEntry | undefined;
}

export function itemsOf(entries: CatalogEntry[], type: CatalogEntry['type']): CatalogItem[] {
  return entries
    .filter((entry) => entry.type === type)
    .flatMap((entry): CatalogItem[] =>
      entry.variants?.length
        ? entry.variants.map((variant) => ({
            key: `${entry.pack}/${entry.id}:${variant.id}`,
            entry,
            variant,
            name: variant.name,
            params: variant.params,
          }))
        : [
            {
              key: `${entry.pack}/${entry.id}`,
              entry,
              variant: null,
              name: entry.name,
              params: {},
            },
          ],
    );
}

export function catalogOf(entries: CatalogEntry[], looks: LookInfo[]): Catalog {
  return {
    entries,
    effects: itemsOf(entries, 'effect'),
    transitions: itemsOf(entries, 'transition'),
    looks,
    find: (pack, id) => entries.find((entry) => entry.pack === pack && entry.id === id),
  };
}

export function defaultValue(param: ParamDef): ParamValue | undefined {
  switch (param.type) {
    case 'color': {
      const [r, g, b, a] = param.default;
      return { r, g, b, a };
    }
    case 'lut':
      return undefined;
    default:
      return param.default;
  }
}

/** Every setting at its default: what Reset sends. */
export function defaultsOf(entry: CatalogEntry): Params {
  const params: Params = {};
  for (const param of entry.params) {
    const value = defaultValue(param);
    if (value !== undefined) params[param.id] = value;
  }
  return params;
}

/** A setting's value: as set, or its default. */
export function valueOf(params: Params, param: ParamDef): ParamValue | undefined {
  return params[param.id] ?? defaultValue(param);
}

const sameValue = (a: ParamValue | undefined, b: ParamValue | undefined) =>
  JSON.stringify(a) === JSON.stringify(b);

/** The name a transition or effect shows: its variant's, when its settings match one. */
export function nameOf(entry: CatalogEntry, params: Params): string {
  const variant = entry.variants?.find((v) =>
    Object.entries(v.params).every(([id, value]) => {
      const param = entry.params.find((p) => p.id === id);
      return param && sameValue(valueOf(params, param), value);
    }),
  );
  return variant?.name ?? entry.name;
}

export const colorToHex = (c: Color) =>
  '#' +
  [c.r, c.g, c.b]
    .map((v) =>
      Math.round(Math.min(1, Math.max(0, v)) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('');

export function hexToColor(hex: string, alpha = 1): Color {
  const value = Number.parseInt(hex.slice(1), 16);
  return {
    r: ((value >> 16) & 255) / 255,
    g: ((value >> 8) & 255) / 255,
    b: (value & 255) / 255,
    a: alpha,
  };
}

let loaded: Promise<Catalog> | null = null;

/** The engine's effects, transitions and looks; loaded once per session. */
export function useCatalog(client: EngineClient | null): Catalog | null {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  useEffect(() => {
    if (!client) return;
    let live = true;
    loaded ??= Promise.all([client.api.effectsCatalog(), client.api.builtinLooks()]).then(
      ([entries, looks]) => catalogOf(entries, looks),
    );
    loaded.then(
      (next) => live && setCatalog(next),
      () => {
        loaded = null;
      },
    );
    return () => {
      live = false;
    };
  }, [client]);
  return catalog;
}
