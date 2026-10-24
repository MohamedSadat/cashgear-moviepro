// Mirrors the JSON of crates/cgv-effects (Definition, ParamDef, CatalogEntry).
import type { ParamValue } from '../project/types';

export type EffectKind = 'effect' | 'transition';

export interface EffectChoice {
  id: string;
  name: string;
  /** An image the shader reads while this is chosen. */
  image?: string;
}

/** One setting of an effect or transition, as its definition describes it. */
export type ParamDef = {
  /** The setting's name in the project and the shader. */
  id: string;
  name: string;
  /** Numbers and colours can be keyframed unless this is false. */
  animate: boolean;
} & (
  | {
      type: 'number';
      min: number;
      max: number;
      default: number;
      step?: number;
      /** Shown after the value, such as `%` or `°`. */
      unit?: string;
      /** The UI shows the value times this (100 for a fraction shown as %). */
      display?: number;
    }
  | { type: 'bool'; default: boolean }
  /** sRGB-encoded, straight alpha, 0 to 1. */
  | { type: 'color'; default: [number, number, number, number] }
  | { type: 'choice'; options: EffectChoice[]; default: string }
  | { type: 'lut' }
);

/** A named set of settings listed as its own item, such as "Wipe left". */
export interface EffectVariant {
  id: string;
  name: string;
  params: Record<string, ParamValue>;
}

/** An effect or transition the engine runs. */
export interface CatalogEntry {
  pack: string;
  id: string;
  name: string;
  category: string;
  type: EffectKind;
  version: number;
  description?: string;
  space: 'linear' | 'srgb';
  params: ParamDef[];
  variants?: EffectVariant[];
}

/** A built-in look: a LUT that ships with the app, imported into a project on use. */
export interface LookInfo {
  id: string;
  name: string;
}
