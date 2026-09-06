import { colorToCss, type Color } from "@vravio/kernel";
import type { RasterBlendMode } from "@vravio/env-raster";

/**
 * Stage 6 of docs/vector-plan.md: "an object looks like it does in
 * Illustrator, not one fill and one line". Blend mode is `RasterBlendMode`
 * imported as-is from `@vravio/env-raster`, not a second enum — a blend mode
 * is the same concept whether it sits on a raster layer or a vector fill,
 * and two independently-typed lists of the same 26 names is exactly the
 * kind of drift `Color` was moved to the kernel to avoid (stage 2's own
 * writeup). The name stays "Raster…" for now, which is a real, minor,
 * acknowledged wart — relocating it to the kernel would touch every file in
 * `env-raster` that already imports it under that name, which is a bigger
 * change than this stage's actual scope, not something to fold in quietly.
 */
export type BlendMode = RasterBlendMode;

export interface GradientStop {
  /** 0..1 along the gradient. */
  readonly offset: number;
  readonly color: Color;
}

/**
 * `from`/`to` are normalized 0..1 against the shape's own local bounding
 * box — (0,0) its top-left corner, (1,1) its bottom-right — the same
 * convention SVG's `objectBoundingBox` gradient units use, and for the same
 * reason: a gradient defined this way still looks right after the shape is
 * resized, with nothing to re-position by hand. For `radial`, `from` is the
 * center and the distance to `to` sets the radius.
 */
export interface Gradient {
  readonly kind: "linear" | "radial";
  readonly stops: readonly GradientStop[];
  readonly from: { readonly x: number; readonly y: number };
  readonly to: { readonly x: number; readonly y: number };
}

export type Paint = { readonly kind: "color"; readonly color: Color } | { readonly kind: "gradient"; readonly gradient: Gradient };

export type StrokeCap = "butt" | "round" | "square";
export type StrokeJoin = "miter" | "round" | "bevel";
/** SVG's own `stroke` has no native inner/outer alignment — it is always
 * centered on the path. `"inner"`/`"outer"` render at double width,
 * confined to (or excluded from) the shape's own geometry via a
 * `<clipPath>`/`<mask>` — see `VectorWorkspace.tsx`'s `renderShape` and
 * `vector-svg-export.ts`'s `strokeMarkup` for the actual technique and the
 * cross-renderer bug (`clipRule="evenodd"` across separate SVG elements
 * does not reliably combine the way two subpaths of one `<path>` do) that
 * shaped it. */
export type StrokeAlignment = "center" | "inner" | "outer";

export interface FillLayer {
  readonly id: string;
  paint: Paint;
  opacity: number;
  visible: boolean;
  blendMode: BlendMode;
}

export interface StrokeLayer {
  readonly id: string;
  paint: Paint;
  width: number;
  opacity: number;
  visible: boolean;
  blendMode: BlendMode;
  /** Empty means solid — not a special case elsewhere, since
   * `stroke-dasharray=""` already means solid to SVG. */
  dash: readonly number[];
  cap: StrokeCap;
  join: StrokeJoin;
  alignment: StrokeAlignment;
}

/**
 * Fills and strokes are separate stacks, not one interleaved Illustrator-
 * style appearance list — a deliberate simplification. Illustrator lets a
 * stroke sit *under* a fill in paint order; here every fill paints first
 * (bottom to top within its own list), then every stroke on top of all of
 * them. This covers the overwhelming majority of real use (multiple fills
 * for texture, multiple strokes for an outline-within-an-outline look)
 * without needing a single merged list with a "kind" tag on each entry.
 */
export interface VectorStyle {
  fills: FillLayer[];
  strokes: StrokeLayer[];
  opacity: number;
  blendMode: BlendMode;
}

let counter = 0;
function nextAppearanceId(prefix: "fill" | "stroke"): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

export const colorPaint = (color: Color): Paint => ({ kind: "color", color });

export function solidFill(color: Color): FillLayer {
  return { id: nextAppearanceId("fill"), paint: colorPaint(color), opacity: 1, visible: true, blendMode: "normal" };
}

export function solidStroke(color: Color, width = 2): StrokeLayer {
  return { id: nextAppearanceId("stroke"), paint: colorPaint(color), width, opacity: 1, visible: true, blendMode: "normal", dash: [], cap: "butt", join: "miter", alignment: "center" };
}

export function emptyVectorStyle(): VectorStyle {
  return { fills: [], strokes: [], opacity: 1, blendMode: "normal" };
}

export function defaultVectorStyle(): VectorStyle {
  return { fills: [solidFill({ space: "srgb", components: [0x5b, 0xe0, 0xb3], alpha: 1 })], strokes: [], opacity: 1, blendMode: "normal" };
}

/** A CSS colour, or a `url(#id)` reference into an `<svg><defs>` this
 * shape's own render is expected to have written a matching gradient
 * element into — the two things an SVG `fill`/`stroke` attribute can be. */
function paintCss(paint: Paint, gradientId: string): string {
  return paint.kind === "color" ? colorToCss(paint.color) : `url(#${gradientId})`;
}

export interface ResolvedPaintLayer<TLayer> {
  readonly layer: TLayer;
  readonly css: string;
}

export interface GradientDef {
  readonly id: string;
  readonly gradient: Gradient;
}

export interface ResolvedAppearance {
  readonly fills: readonly ResolvedPaintLayer<FillLayer>[];
  readonly strokes: readonly ResolvedPaintLayer<StrokeLayer>[];
  /** Every gradient this style actually uses, each with the id its own
   * `css` string (`url(#id)`) already points at — a renderer writes exactly
   * these into `<defs>` and nothing else, so a style with no gradients
   * writes no `<defs>` at all. */
  readonly gradientDefs: readonly GradientDef[];
}

/** Whether this style has anything to fill with — used by hit-testing and by
 * the renderer alike, so "is there a fill" is answered the same way in both
 * (a shape whose only fill layer is turned off should be exactly as
 * unclickable as it is invisible). Per-layer `opacity` is deliberately not
 * checked: a fill dimmed to 1% is still visually and logically "there", the
 * same way a raster layer at 1% opacity still is. */
export const hasVisibleFill = (style: VectorStyle): boolean => style.opacity > 0 && style.fills.some((fill) => fill.visible);

/** The width to use for stroke hit-testing and for padding a shape's bounds
 * — the *widest* visible stroke, since that is how far the shape's painted
 * edge actually reaches; a narrower stroke on top of it does not shrink
 * what is clickable or what needs to fit on screen. `0` when there is no
 * visible stroke at all, which every caller already treats as "no stroke". */
export function maxVisibleStrokeWidth(style: VectorStyle): number {
  if (style.opacity <= 0) return 0;
  const widths = style.strokes.filter((stroke) => stroke.visible).map((stroke) => stroke.width);
  return widths.length ? Math.max(...widths) : 0;
}

/**
 * The one place a `VectorStyle` becomes "what to actually draw" — a pure
 * function so it is testable without a DOM (this package has none) and so
 * the SVG renderer (`VectorWorkspace.tsx`) and the canvas export path
 * (`vector-environment.ts`) compute the same answer from the same style
 * instead of two hand-written copies of "is this a gradient or a colour"
 * quietly drifting apart.
 */
export function resolveAppearance(style: VectorStyle, shapeId: string): ResolvedAppearance {
  const gradientDefs: GradientDef[] = [];
  const resolve = <TLayer extends { paint: Paint }>(layer: TLayer, prefix: string, index: number): ResolvedPaintLayer<TLayer> => {
    if (layer.paint.kind === "color") return { layer, css: paintCss(layer.paint, "") };
    const id = `${shapeId}-${prefix}-${index}`;
    gradientDefs.push({ id, gradient: layer.paint.gradient });
    return { layer, css: paintCss(layer.paint, id) };
  };
  return {
    fills: style.fills.map((layer, index) => resolve(layer, "fill", index)),
    strokes: style.strokes.map((layer, index) => resolve(layer, "stroke", index)),
    gradientDefs,
  };
}
