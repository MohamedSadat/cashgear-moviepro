// Mirrors the JSON of crates/cgv-model/src/title.rs: what a title clip draws.
import type { Color } from './types';

export interface TitleFont {
  family: string;
  /** 100 (thin) to 900 (black); 400 is regular. */
  weight?: number;
  italic?: boolean;
}

export type TextAlign = 'left' | 'center' | 'right';
/** Auto takes each paragraph's direction from its first letter with one. */
export type TextDirection = 'auto' | 'ltr' | 'rtl';
export type RevealUnit = 'letter' | 'word' | 'line';
export type ShapeKind = 'rectangle' | 'ellipse' | 'line' | 'arrow' | 'polygon' | 'star';

/** An outline beneath the fill: half its width shows outside. */
export interface TitleStroke {
  color: Color;
  width: number;
}

/** A blurred copy of the fill and outline beneath them. */
export interface TitleShadow {
  color: Color;
  /** Project pixels, scaled with the element but not turned with it. */
  x: number;
  y: number;
  blur: number;
}

export interface TextBackground {
  color: Color;
  padding: number;
  radius?: number;
  /** One box per line instead of one around the block. */
  perLine?: boolean;
}

export interface TextContent {
  type: 'text';
  text: string;
  font: TitleFont;
  /** Font size in project pixels. */
  size: number;
  align?: TextAlign;
  direction?: TextDirection;
  /** A multiple of the font's own line height. */
  lineSpacing?: number;
  /** Extra space after each letter, in project pixels. */
  letterSpacing?: number;
  /** Lines wrap at this width in project pixels. */
  wrap?: number;
  background?: TextBackground;
  /** How much shows, 0 to 1, counted in `revealBy` units. */
  reveal?: number;
  revealBy?: RevealUnit;
}

export interface ShapeContent {
  type: 'shape';
  kind: ShapeKind;
  width: number;
  height: number;
  /** Rounded rectangle corners. */
  radius?: number;
  /** Polygon sides, star points. */
  sides?: number;
  /** A star's inner radius as a fraction of the outer. */
  inner?: number;
}

/** A text block or shape on the title's frame-sized canvas. */
export type TitleElement = {
  id: number;
  /** Centre in project pixels from the frame centre, y down. */
  x: number;
  y: number;
  scale?: number;
  /** Degrees, clockwise. */
  rotation?: number;
  opacity?: number;
  fill: Color;
  stroke?: TitleStroke;
  shadow?: TitleShadow;
} & (TextContent | ShapeContent);

export interface Title {
  /** Back to front. */
  elements: TitleElement[];
}

/** Element settings keyframes can animate: `title.<element id>.<setting>`. */
export type ElementSetting = 'x' | 'y' | 'scale' | 'rotation' | 'opacity' | 'reveal' | 'fill';

export function elementProperty(id: number, setting: ElementSetting): string {
  return `title.${id}.${setting}`;
}
