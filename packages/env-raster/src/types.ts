import type { ColorLookupTable } from "./lut";

export type RasterBlendMode = "normal" | "dissolve" | "darken" | "multiply" | "colorBurn" | "linearBurn" | "darkerColor" | "lighten" | "screen" | "colorDodge" | "linearDodge" | "lighterColor" | "overlay" | "softLight" | "hardLight" | "vividLight" | "linearLight" | "pinLight" | "hardMix" | "difference" | "exclusion" | "subtract" | "divide" | "hue" | "saturation" | "color" | "luminosity";
export type RasterLayerKind = "pixel" | "text" | "adjustment" | "fill" | "group" | "smart" | "shape" | "3d";
export type SelectiveColorRange = "reds" | "yellows" | "greens" | "cyans" | "blues" | "magentas" | "whites" | "neutrals" | "blacks";
export interface SelectiveColorValues { cyan: number; magenta: number; yellow: number; black: number }

export interface LevelsChannelPoints { blackInput: number; gamma: number; whiteInput: number; blackOutput: number; whiteOutput: number }

export type RasterAdjustment =
  | ({ kind: "levels" } & LevelsChannelPoints & {
      /**
       * Per-channel overrides — Photoshop's Channel dropdown (RGB/Red/Green/
       * Blue): the top-level fields above are the RGB ("master") points,
       * applied to a channel with no entry here. Optional, and absent for
       * every levels adjustment before this field existed (`structuredClone`
       * at every clone site already copies it correctly once present — no
       * migration needed for a field that is simply missing on old data).
       * "Enhance Per Channel Contrast" (auto-levels.ts) is the one auto model
       * that actually needs this: it maximizes each channel's own range
       * independently, which the RGB-locked master fields alone cannot
       * represent — a real, functional reason for the field to exist, not a
       * button added because the dialog "should" have one.
       */
      channels?: { red?: LevelsChannelPoints; green?: LevelsChannelPoints; blue?: LevelsChannelPoints };
    })
  | { kind: "curves"; points: Array<{ x: number; y: number }> }
  | { kind: "hueSaturation"; hue: number; saturation: number; lightness: number }
  | { kind: "colorBalance"; cyanRed: number; magentaGreen: number; yellowBlue: number }
  | { kind: "brightnessContrast"; brightness: number; contrast: number }
  | { kind: "exposure"; exposure: number; offset: number; gamma: number }
  | { kind: "vibrance"; vibrance: number; saturation: number }
  | { kind: "blackWhite"; reds: number; yellows: number; greens: number; cyans: number; blues: number; magentas: number; tint: boolean; tintColor: string }
  | { kind: "photoFilter"; color: string; density: number; preserveLuminosity: boolean }
  | { kind: "channelMixer"; outputChannel: "red" | "green" | "blue"; red: [number, number, number, number]; green: [number, number, number, number]; blue: [number, number, number, number]; monochrome: boolean }
  | { kind: "gradientMap"; from: string; to: string; dither: boolean; reverse: boolean }
  | { kind: "selectiveColor"; range: SelectiveColorRange; values: Record<SelectiveColorRange, SelectiveColorValues>; method: "relative" | "absolute" }
  | { kind: "shadowsHighlights"; shadows: number; highlights: number; colorCorrection: number; midtoneContrast: number; blackClip: number; whiteClip: number }
  | { kind: "invert" }
  | { kind: "posterize"; levels: number }
  | { kind: "threshold"; threshold: number }
  | { kind: "colorLookup"; lut: ColorLookupTable; amount: number };

export interface Scene3DLighting { ambientIntensity: number; ambientColor: string; directionalIntensity: number; directionalColor: string; /** degrees around Y (azimuth) and above the horizon (elevation) */ azimuth: number; elevation: number }

/**
 * What geometry a 3D layer renders, kept as plain data rather than a live scene graph so it
 * survives structuredClone in undo snapshots the same way every other layer property does. A
 * model never carries its own bytes here — `assetId` is a reference into the shared asset store,
 * the same "asset, not a copy" rule every other cross-environment picture in this project follows.
 */
export type Scene3DSource =
  | { kind: "text"; value: string; font: "helvetiker_regular" | "helvetiker_bold"; depth: number; bevelEnabled: boolean; bevelThickness: number; bevelSize: number; bevelSegments: number; curveSegments: number }
  | { kind: "model"; assetId: string; fileName: string }
  | { kind: "extrude"; sourceLayerId: string; depth: number };

/**
 * An invisible surface a 3D layer's own shadow falls onto — the owner's own
 * request: "как-то реально обозначить невидимой плоскостью где находится
 * этот стол, чтобы на него могла откинуться тень как в 3D пространстве"
 * (mark, with an invisible plane, where a table in the background actually
 * is, so the object can cast a shadow onto it like it would in real 3D
 * space). Deliberately not a full single-view camera calibration (solving a
 * ground plane's true 3D orientation from a photo needs a known focal
 * length/sensor size this project has no source for) — `tiltX`/`distance`
 * are the two knobs a live shadow preview can be *dragged into place* with,
 * matching the table's own perspective by eye, which is both simpler to
 * reason about and more convenient than a numeric calibration dialog would
 * be: what you see while dragging is exactly what commits.
 */
export interface Scene3DGround {
  enabled: boolean;
  /** Degrees the plane tilts away from the camera around X — 0 is
   * face-on (a wall), 90 is a floor seen from directly above. */
  tiltX: number;
  /** Degrees the plane additionally tilts around Z, applied after `tiltX` — together the two
   * let a point-placed plane (three or four clicks, "Cast Shadow…") tip toward an arbitrary
   * direction rather than only toward or away from the camera. 0 for the classic single-axis
   * floor/wall case `tiltX` alone already covered, and for any ground saved before this field
   * existed (read back as `undefined`, meant as 0). */
  tiltZ: number;
  /** How far below the object's own centered origin the plane sits, in
   * the same units as `Scene3DLayerData.size`. */
  distance: number;
  /** 0–100, the shadow's own darkness where it falls. */
  opacity: number;
  /** 0–20-ish, the shadow edge's blur radius — a bare point light has a
   * hard-edged shadow at 0, larger values read as a bigger/softer light
   * source (an overcast sky, a big window) the way a real shadow would. */
  softness: number;
}

export const defaultScene3DGround: Scene3DGround = { enabled: false, tiltX: 65, tiltZ: 0, distance: 60, opacity: 55, softness: 6 };

export interface Scene3DLayerData {
  source: Scene3DSource;
  size: number;
  color: string;
  metalness: number;
  roughness: number;
  rotationX: number;
  rotationY: number;
  rotationZ: number;
  lighting: Scene3DLighting;
  /** Absent on every layer created before this field existed — `structuredClone` already
   * carries it through undo snapshots once present, the same as every other optional layer
   * property in this project; a layer with no `ground` renders exactly as it always has. */
  ground?: Scene3DGround;
}

export interface RasterTextPath { start: { x: number; y: number }; control: { x: number; y: number }; end: { x: number; y: number }; flip?: boolean }
export interface RasterTextTransform { a: number; b: number; c: number; d: number; e: number; f: number }
export interface RasterTextData { value: string; x: number; y: number; fontFamily: string; fontSize: number; lineHeight: number; letterSpacing: number; align: "left" | "center" | "right"; color: string; bold?: boolean; italic?: boolean; underline?: boolean; mode?: "point" | "area" | "path" | "dynamic"; /** Paragraph (bounded) text word-wraps within this width instead of only breaking on explicit newlines. */ boxWidth?: number; boxHeight?: number; path?: RasterTextPath; dynamicPreset?: "circle" | "arch" | "bow"; /** Non-destructive affine transform applied to the live text geometry. */ transform?: RasterTextTransform; /** Cached visible raster bounds, refreshed by the text renderer. */ visualBounds?: RasterRect }
export interface RasterLayerEffects {
  dropShadow?: { enabled: boolean; color: string; opacity: number; offsetX: number; offsetY: number };
  innerShadow?: { enabled: boolean; color: string; opacity: number; offsetX: number; offsetY: number };
  outerGlow?: { enabled: boolean; color: string; opacity: number; radius: number };
  innerGlow?: { enabled: boolean; color: string; opacity: number; radius: number };
  bevel?: { enabled: boolean; strength: number };
  gradientOverlay?: { enabled: boolean; from: string; to: string; opacity: number; angle: number };
}

export interface RasterLayerMask {
  /** Working grayscale mask. Asset-backed persistence can replace this buffer without changing the compositor contract. */
  pixels: Uint8ClampedArray;
  assetId: string | null;
  enabled: boolean;
  // No `inverted` flag — deliberately removed (master-plan.md §19.2).
  // Painting on the mask writes raw pixels (raster-pixel-buffers.ts's
  // maskToRgba/rgbaToMask), with no idea a logical inversion could exist —
  // a lazy `inverted` flag the compositor applied only at render time made
  // white strokes hide instead of reveal the instant it became reachable
  // through a UI command. "Invert Mask" physically rewrites pixels
  // (255 - value) instead, so every mask consumer — brush, thumbnail,
  // mask→selection, export — reads one consistent truth. Costs
  // O(width×height) per invert click, not per frame; Patchy's own
  // LayerMask does the same physical rewrite for the same reason.
  linked: boolean;
  density: number;
  feather: number;
}

export interface RasterSmartSource {
  assetId: string;
  pinnedRev: string | null;
  sourceKind: "raster" | "vector" | "document";
}

export interface RasterLayer {
  id: string;
  name: string;
  /**
   * Where this layer's pixels live in the document.
   *
   * A layer is sized to what it holds, not to the canvas — the way Photoshop,
   * GIMP and Patchy all store one. A four-hundred-pixel shape on a 1920x1080
   * canvas is 640 KB here and eight megabytes if every layer is canvas-sized,
   * and a working file accumulates dozens of them. Everything downstream pays
   * that difference again: history, autosave, and every pass that walks a layer.
   *
   * `width` and `height` mirror `bounds` and are kept because a great deal of
   * code reads them; they are the layer's size, never the document's.
   */
  bounds: RasterRect;
  width: number;
  height: number;
  /** Sized to `bounds`, addressed in bounds-local coordinates. */
  pixels: Uint8ClampedArray;
  visible: boolean;
  opacity: number;
  fillOpacity: number;
  blendMode: RasterBlendMode;
  /** Lock All: nothing about the layer can be changed. */
  locked: boolean;
  /**
   * Photoshop's other three locks, each narrower than the last.
   *
   * Transparency keeps paint inside what the layer already covers; pixels stops
   * painting altogether while still allowing a move; position pins it in place
   * while still allowing paint. They are separate because they answer different
   * questions, and Lock All is not simply all three at once — it also stops
   * renaming, restyling and deletion.
   */
  lockTransparent?: boolean;
  lockPixels?: boolean;
  lockPosition?: boolean;
  /** Panel colour marker, as Photoshop's layer context menu sets. */
  colorLabel?: "none" | "red" | "orange" | "yellow" | "green" | "blue" | "violet" | "grey";
  /**
   * Layers sharing this token move and transform together.
   *
   * Photoshop's chain link. Stored as a shared token rather than a list of
   * partners so that linking and unlinking cannot leave the two halves of a
   * pair disagreeing about each other.
   */
  linkGroup?: string;
  kind: RasterLayerKind;
  adjustment?: RasterAdjustment;
  text?: RasterTextData;
  scene3d?: Scene3DLayerData;
  effects: RasterLayerEffects;
  /** Normalized tree link. null means document root. */
  parentId: string | null;
  /** Lexicographically sortable stable sibling position. */
  orderKey: string;
  expanded?: boolean;
  groupMode?: "passThrough" | "isolated";
  clipping?: boolean;
  mask?: RasterLayerMask;
  smartSource?: RasterSmartSource;
  /**
   * Asset whose revisions are the undo history of this buffer.
   *
   * Keeping the bytes in the asset store rather than inside history steps is
   * what makes deep undo affordable: a step holds two revision numbers instead
   * of two copies of the layer.
   */
  pixelAssetId?: string;
  maskAssetId?: string;
}

export interface RasterRect { x: number; y: number; width: number; height: number }
export interface RasterGuide { orientation: "horizontal" | "vertical"; position: number }

export interface PixelSelection {
  /** Grayscale alpha, one byte per document pixel. */
  mask: Uint8ClampedArray;
  /** Bounding box of non-zero pixels, cached for rendering and commands. */
  bounds: RasterRect;
}

export interface RasterDocumentState {
  kind: "raster";
  schemaVersion: 1 | 2;
  width: number;
  height: number;
  colorSpace: "srgb";
  resolution: number;
  resolutionUnit: "ppi" | "ppcm";
  /** 16 and 32 bit force the precise compositing path; see composite-plan.ts. */
  bitDepth: 8 | 16 | 32;
  pixelAspectRatio: number;
  backgroundColor: string | null;
  layers: RasterLayer[];
  activeLayerId: string;
  selection: PixelSelection | null;
  guides: RasterGuide[];
}

export interface RasterDocumentOptions {
  resolution?: number;
  resolutionUnit?: "ppi" | "ppcm";
  pixelAspectRatio?: number;
  backgroundColor?: string | null;
}

export interface RgbaColor { r: number; g: number; b: number; a: number }
export interface Point { x: number; y: number; pressure?: number }
