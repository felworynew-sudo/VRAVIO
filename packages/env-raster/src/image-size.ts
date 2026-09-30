import { cloneRasterState } from "./document";
import { layerDocumentPixels, layerPixelsView, setLayerFramePixels, setLayerPixels } from "./layer-bounds";
import { resampleAffine, type Interpolation, type Premultiplied } from "./resample";
import { transformSmartObject } from "./smart-object";
import { TileStore } from "./tile-store";
import { cropRasterDocument } from "./transform";
import { selectionBounds } from "./selection";
import type { RasterDocumentState, RasterLayerMask, RasterRect } from "./types";

/**
 * Image ▸ Image Size and Image ▸ Canvas Size (§65.13) — Photoshop's two, on the one resampler a
 * Free Transform commit already uses (`resample.ts`), so a document shrunk here filters exactly the
 * way a layer shrunk by hand does.
 */

function premultiply(pixels: Uint8ClampedArray, width: number, height: number): Premultiplied {
  const data = new Uint16Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const at = i * 4, alpha = pixels[at + 3]!;
    if (!alpha) continue;
    const factor = alpha / 255 * 257;
    data[at] = Math.round(pixels[at]! * factor); data[at + 1] = Math.round(pixels[at + 1]! * factor); data[at + 2] = Math.round(pixels[at + 2]! * factor);
    data[at + 3] = alpha * 257;
  }
  return { data, width, height };
}

function unpremultiply(image: Premultiplied): Uint8ClampedArray {
  const { data, width, height } = image, out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const at = i * 4, alpha = data[at + 3]!;
    if (!alpha) continue;
    out[at] = Math.round(data[at]! * 255 / alpha); out[at + 1] = Math.round(data[at + 1]! * 255 / alpha); out[at + 2] = Math.round(data[at + 2]! * 255 / alpha);
    out[at + 3] = Math.round(alpha / 257);
  }
  return out;
}

/** An image in document space at `frame`, scaled by `sx`/`sy` about the document origin. */
function scaleFrame(image: Premultiplied, frame: RasterRect, sx: number, sy: number, interpolation: Interpolation): { image: Premultiplied; frame: RasterRect } | null {
  const left = Math.floor(frame.x * sx) - 2, top = Math.floor(frame.y * sy) - 2;
  const clip = { x: left, y: top, width: Math.ceil((frame.x + frame.width) * sx) + 2 - left, height: Math.ceil((frame.y + frame.height) * sy) + 2 - top };
  const result = resampleAffine(image, { a: sx, b: 0, c: 0, d: sy, tx: frame.x * sx, ty: frame.y * sy }, interpolation, clip);
  return result ? { image: result.image, frame: { x: result.x, y: result.y, width: result.image.width, height: result.image.height } } : null;
}

/** A one-channel buffer (a mask, a selection) through the same scale, as alpha. */
function scaleChannel(values: Uint8ClampedArray, frame: RasterRect, sx: number, sy: number, interpolation: Interpolation): { values: Uint8ClampedArray; frame: RasterRect } | null {
  const data = new Uint16Array(frame.width * frame.height * 4);
  for (let i = 0; i < frame.width * frame.height; i += 1) data[i * 4 + 3] = values[i]! * 257;
  const scaled = scaleFrame({ data, width: frame.width, height: frame.height }, frame, sx, sy, interpolation);
  if (!scaled) return null;
  const out = new Uint8ClampedArray(scaled.frame.width * scaled.frame.height);
  for (let i = 0; i < out.length; i += 1) out[i] = Math.round(scaled.image.data[i * 4 + 3]! / 257);
  return { values: out, frame: scaled.frame };
}

/** Window of `values` (in `frame`) onto a fixed rectangle, zero where it does not reach. */
function windowChannel(values: Uint8ClampedArray, frame: RasterRect, target: RasterRect): Uint8ClampedArray {
  const out = new Uint8ClampedArray(target.width * target.height);
  for (let y = 0; y < target.height; y += 1) {
    const sy = target.y + y - frame.y; if (sy < 0 || sy >= frame.height) continue;
    for (let x = 0; x < target.width; x += 1) {
      const sx = target.x + x - frame.x; if (sx < 0 || sx >= frame.width) continue;
      out[y * target.width + x] = values[sy * frame.width + sx]!;
    }
  }
  return out;
}

function resizeMask(mask: RasterLayerMask, oldWidth: number, oldHeight: number, width: number, height: number, interpolation: Interpolation): RasterLayerMask {
  const sx = width / oldWidth, sy = height / oldHeight;
  const canvas = { x: 0, y: 0, width, height };
  const scaled = scaleChannel(mask.tiles.toPixels(), { x: 0, y: 0, width: oldWidth, height: oldHeight }, sx, sy, interpolation);
  const tiles = TileStore.fromPixels(scaled ? windowChannel(scaled.values, scaled.frame, canvas) : new Uint8ClampedArray(width * height), width, height, 1);
  const outside = mask.outside ? scaleChannel(mask.outside.tiles.toPixels(), mask.outside.bounds, sx, sy, interpolation) : null;
  const { outside: _old, ...rest } = mask;
  return {
    ...rest, tiles, pixelsRevision: mask.pixelsRevision + 1,
    ...(outside ? { outside: { tiles: TileStore.fromPixels(outside.values, outside.frame.width, outside.frame.height, 1), bounds: outside.frame } } : {}),
  };
}

/**
 * Image Size with Resample on: every layer, mask and the selection scaled to `width`×`height`.
 * A pixel layer is resampled in its own frame (whatever it holds past the canvas scales with it);
 * a Smart Object only has its placement scaled — its embedded source is never resampled, as in
 * Photoshop. Text and 3D layers are resampled here too as a stand-in; the caller re-renders them
 * from their own data at the new size, since they are not pixels at heart.
 */
export function resizeRasterDocument(state: RasterDocumentState, width: number, height: number, interpolation: Interpolation): RasterDocumentState {
  const next = cloneRasterState(state);
  const sx = width / state.width, sy = height / state.height;
  next.width = width;
  next.height = height;
  next.guides = state.guides.map((guide) => ({ ...guide, position: guide.position * (guide.orientation === "vertical" ? sx : sy) }));
  for (const layer of next.layers) {
    if (layer.kind === "smart") {
      transformSmartObject(layer, { x: 0, y: 0, width: state.width, height: state.height }, { x: 0, y: 0, width, height }, 0);
    } else if (layer.kind !== "group" && layer.kind !== "adjustment") {
      const scaled = scaleFrame(premultiply(layerPixelsView(layer), layer.width, layer.height), layer.bounds, sx, sy, interpolation);
      if (scaled) setLayerFramePixels(layer, unpremultiply(scaled.image), scaled.frame);
      else setLayerPixels(layer, new Uint8ClampedArray(width * height * 4), width, height);
    }
    if (layer.mask) layer.mask = resizeMask(layer.mask, state.width, state.height, width, height, interpolation);
  }
  if (state.selection) {
    const scaled = scaleChannel(state.selection.mask, { x: 0, y: 0, width: state.width, height: state.height }, sx, sy, interpolation);
    const mask = scaled ? windowChannel(scaled.values, scaled.frame, { x: 0, y: 0, width, height }) : new Uint8ClampedArray(width * height);
    const bounds = selectionBounds(mask, width, height);
    next.selection = bounds.width && bounds.height ? { mask, bounds } : null;
  }
  return next;
}

export type CanvasAnchor = readonly [-1 | 0 | 1, -1 | 0 | 1];

/** Where the old canvas sits in the new one — in the old canvas's own coordinates, the rectangle
 * the new canvas covers — for a 3×3 anchor: -1 keeps that edge, 0 centres, 1 keeps the far edge. */
export function canvasSizeRect(oldWidth: number, oldHeight: number, width: number, height: number, anchor: CanvasAnchor): RasterRect {
  const place = (oldSize: number, size: number, side: -1 | 0 | 1) => side === -1 ? 0 : side === 1 ? oldSize - size : Math.round((oldSize - size) / 2);
  return { x: place(oldWidth, width, anchor[0]), y: place(oldHeight, height, anchor[1]), width, height };
}

/**
 * Canvas Size: the canvas grows or shrinks around the anchor, and no layer is resampled. Shrinking
 * keeps what falls outside in each layer (Crop's "Delete Cropped Pixels" off), so growing back
 * reveals it. `fill`, when given, paints the newly added area of the bottom layer — Photoshop's
 * "Canvas extension color", which it applies to the Background layer; without one, new canvas is
 * transparent.
 */
export function resizeRasterCanvas(state: RasterDocumentState, width: number, height: number, anchor: CanvasAnchor, fill: readonly [number, number, number, number] | null): RasterDocumentState {
  const rect = canvasSizeRect(state.width, state.height, width, height, anchor);
  const next = cropRasterDocument(state, rect, false, true);
  const bottom = next.layers.find((layer) => layer.parentId === null);
  if (fill && bottom && bottom.kind === "pixel") {
    const pixels = layerDocumentPixels(bottom, width, height).slice();
    const oldLeft = -rect.x, oldTop = -rect.y;
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
      if (x >= oldLeft && x < oldLeft + state.width && y >= oldTop && y < oldTop + state.height) continue;
      pixels.set(fill, (y * width + x) * 4);
    }
    setLayerPixels(bottom, pixels, width, height, null, { keepOutsideDocument: true });
  }
  return next;
}
