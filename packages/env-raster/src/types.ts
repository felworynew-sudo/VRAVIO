export type RasterBlendMode = "normal" | "dissolve" | "darken" | "multiply" | "colorBurn" | "linearBurn" | "darkerColor" | "lighten" | "screen" | "colorDodge" | "linearDodge" | "lighterColor" | "overlay" | "softLight" | "hardLight" | "vividLight" | "linearLight" | "pinLight" | "hardMix" | "difference" | "exclusion" | "subtract" | "divide" | "hue" | "saturation" | "color" | "luminosity";
export type RasterLayerKind = "pixel" | "text" | "adjustment" | "fill";

export type RasterAdjustment =
  | { kind: "levels"; blackInput: number; gamma: number; whiteInput: number; blackOutput: number; whiteOutput: number }
  | { kind: "curves"; points: Array<{ x: number; y: number }> }
  | { kind: "hueSaturation"; hue: number; saturation: number; lightness: number }
  | { kind: "colorBalance"; cyanRed: number; magentaGreen: number; yellowBlue: number }
  | { kind: "brightnessContrast"; brightness: number; contrast: number }
  | { kind: "invert" }
  | { kind: "posterize"; levels: number }
  | { kind: "threshold"; threshold: number };

export interface RasterTextData { value: string; x: number; y: number; fontFamily: string; fontSize: number; lineHeight: number; letterSpacing: number; align: "left" | "center" | "right"; color: string; bold?: boolean; italic?: boolean; underline?: boolean; /** Paragraph (bounded) text word-wraps within this width instead of only breaking on explicit newlines. */ boxWidth?: number }
export interface RasterLayerEffects {
  dropShadow?: { enabled: boolean; color: string; opacity: number; offsetX: number; offsetY: number };
  innerShadow?: { enabled: boolean; color: string; opacity: number; offsetX: number; offsetY: number };
  outerGlow?: { enabled: boolean; color: string; opacity: number; radius: number };
  innerGlow?: { enabled: boolean; color: string; opacity: number; radius: number };
  bevel?: { enabled: boolean; strength: number };
  gradientOverlay?: { enabled: boolean; from: string; to: string; opacity: number; angle: number };
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
  locked: boolean;
  kind: RasterLayerKind;
  adjustment?: RasterAdjustment;
  text?: RasterTextData;
  effects: RasterLayerEffects;
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
  schemaVersion: 1;
  width: number;
  height: number;
  colorSpace: "srgb";
  resolution: number;
  resolutionUnit: "ppi" | "ppcm";
  bitDepth: 8;
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
