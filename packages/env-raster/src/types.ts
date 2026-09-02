import type { ColorLookupTable } from "./lut";

export type RasterBlendMode = "normal" | "dissolve" | "darken" | "multiply" | "colorBurn" | "linearBurn" | "darkerColor" | "lighten" | "screen" | "colorDodge" | "linearDodge" | "lighterColor" | "overlay" | "softLight" | "hardLight" | "vividLight" | "linearLight" | "pinLight" | "hardMix" | "difference" | "exclusion" | "subtract" | "divide" | "hue" | "saturation" | "color" | "luminosity";
export type RasterLayerKind = "pixel" | "text" | "adjustment" | "fill" | "group" | "smart" | "shape" | "3d";

export type RasterAdjustment =
  | { kind: "levels"; blackInput: number; gamma: number; whiteInput: number; blackOutput: number; whiteOutput: number }
  | { kind: "curves"; points: Array<{ x: number; y: number }> }
  | { kind: "hueSaturation"; hue: number; saturation: number; lightness: number }
  | { kind: "colorBalance"; cyanRed: number; magentaGreen: number; yellowBlue: number }
  | { kind: "brightnessContrast"; brightness: number; contrast: number }
  | { kind: "invert" }
  | { kind: "posterize"; levels: number }
  | { kind: "threshold"; threshold: number }
  | { kind: "colorLookup"; lut: ColorLookupTable; amount: number };

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
  inverted: boolean;
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
  width: number;
  height: number;
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
