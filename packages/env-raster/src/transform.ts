import { layerDocumentPixels } from "./layer-bounds";
import { selectionBounds } from "./selection";
import type { PixelSelection, Point, RasterDocumentState, RasterRect } from "./types";

/** Coefficients of the projective map from the unit square (0,0)-(1,0)-(1,1)-(0,1) onto an
 * arbitrary quadrilateral (corners given in the same TL,TR,BR,BL order), by Heckbert's method
 * ("Fundamentals of Texture Mapping and Image Warping", 1989, §I). Falls back to a plain affine
 * fit when the quad is already a parallelogram, where the general formula divides by zero —
 * covers Skew, which only ever produces parallelograms. */
function quadMapping(corners: readonly [Point, Point, Point, Point]) {
  const [p0, p1, p2, p3] = corners;
  const dx3 = p0.x - p1.x + p2.x - p3.x, dy3 = p0.y - p1.y + p2.y - p3.y;
  if (Math.abs(dx3) < 1e-9 && Math.abs(dy3) < 1e-9) {
    return { a: p1.x - p0.x, b: p2.x - p1.x, c: p0.x, d: p1.y - p0.y, e: p2.y - p1.y, f: p0.y, g: 0, h: 0 };
  }
  const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, dy1 = p1.y - p2.y, dy2 = p3.y - p2.y;
  const denom = dx1 * dy2 - dx2 * dy1;
  const g = denom === 0 ? 0 : (dx3 * dy2 - dx2 * dy3) / denom;
  const h = denom === 0 ? 0 : (dx1 * dy3 - dx3 * dy1) / denom;
  return { a: p1.x - p0.x + g * p1.x, b: p3.x - p0.x + h * p3.x, c: p0.x, d: p1.y - p0.y + g * p1.y, e: p3.y - p0.y + h * p3.y, f: p0.y, g, h };
}

/** Inverse of quadMapping's 3x3 projective matrix [[a,b,c],[d,e,f],[g,h,1]], applied to (x,y,1)
 * and normalized by the resulting third component — turns an absolute canvas point back into
 * the quad's own unit-square (u,v), so the destination can be sampled from the source rectangle. */
function inverseUnitSquare(mapping: ReturnType<typeof quadMapping>, x: number, y: number): { u: number; v: number } {
  const { a, b, c, d, e, f, g, h } = mapping;
  const det = a * (e - f * h) - b * (d - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-12) return { u: -1, v: -1 };
  const i00 = (e - f * h) / det, i01 = (c * h - b) / det, i02 = (b * f - c * e) / det;
  const i10 = (f * g - d) / det, i11 = (a - c * g) / det, i12 = (c * d - a * f) / det;
  const i20 = (d * h - e * g) / det, i21 = (b * g - a * h) / det, i22 = (a * e - b * d) / det;
  const wx = i00 * x + i01 * y + i02, wy = i10 * x + i11 * y + i12, ww = i20 * x + i21 * y + i22;
  if (Math.abs(ww) < 1e-9) return { u: -1, v: -1 };
  return { u: wx / ww, v: wy / ww };
}

/** Remaps sourceBounds into an arbitrary quadrilateral (TL,TR,BR,BL) instead of scaleLayerPixels'
 * axis-aligned rectangle — the shared engine behind Skew (a parallelogram), Distort (a free
 * quad) and Perspective (a quad the caller keeps trapezoidal by mirroring corner drags), which
 * differ only in how their on-canvas handles are allowed to move, not in how pixels are sampled. */
export function quadLayerPixels(pixels: Uint8ClampedArray, width: number, height: number, sourceBounds: RasterRect, corners: readonly [Point, Point, Point, Point], selection: PixelSelection | null = null): Uint8ClampedArray {
  const output = pixels.slice(), source = pixels.slice();
  const left = Math.max(0, Math.floor(sourceBounds.x)), top = Math.max(0, Math.floor(sourceBounds.y));
  const right = Math.min(width, Math.ceil(sourceBounds.x + sourceBounds.width)), bottom = Math.min(height, Math.ceil(sourceBounds.y + sourceBounds.height));
  const selectedAlpha = (index: number) => selection ? selection.mask[index]! / 255 : (index % width >= left && index % width < right && Math.floor(index / width) >= top && Math.floor(index / width) < bottom ? 1 : 0);
  for (let y = top; y < bottom; y += 1) for (let x = left; x < right; x += 1) {
    const index = y * width + x, alpha = selectedAlpha(index); if (alpha <= 0) continue;
    const pixel = index * 4, remaining = 1 - alpha;
    output[pixel] = Math.round(output[pixel]! * remaining); output[pixel + 1] = Math.round(output[pixel + 1]! * remaining); output[pixel + 2] = Math.round(output[pixel + 2]! * remaining); output[pixel + 3] = Math.round(output[pixel + 3]! * remaining);
  }
  const mapping = quadMapping(corners);
  const xs = corners.map((p) => p.x), ys = corners.map((p) => p.y);
  const targetLeft = Math.floor(Math.min(...xs)), targetTop = Math.floor(Math.min(...ys)), targetRight = Math.ceil(Math.max(...xs)), targetBottom = Math.ceil(Math.max(...ys));
  for (let y = Math.max(0, targetTop); y < Math.min(height, targetBottom); y += 1) for (let x = Math.max(0, targetLeft); x < Math.min(width, targetRight); x += 1) {
    const { u, v } = inverseUnitSquare(mapping, x + .5, y + .5);
    if (u < 0 || u > 1 || v < 0 || v > 1) continue;
    const sourceX = Math.max(left, Math.min(right - 1, Math.floor(sourceBounds.x + u * sourceBounds.width)));
    const sourceY = Math.max(top, Math.min(bottom - 1, Math.floor(sourceBounds.y + v * sourceBounds.height)));
    const sourceIndex = sourceY * width + sourceX, maskAlpha = selectedAlpha(sourceIndex); if (maskAlpha <= 0) continue;
    const from = sourceIndex * 4, to = (y * width + x) * 4, sourceAlpha = source[from + 3]! / 255 * maskAlpha, destinationAlpha = output[to + 3]! / 255, alpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
    if (alpha <= 0) continue;
    output[to] = Math.round((source[from]! * sourceAlpha + output[to]! * destinationAlpha * (1 - sourceAlpha)) / alpha);
    output[to + 1] = Math.round((source[from + 1]! * sourceAlpha + output[to + 1]! * destinationAlpha * (1 - sourceAlpha)) / alpha);
    output[to + 2] = Math.round((source[from + 2]! * sourceAlpha + output[to + 2]! * destinationAlpha * (1 - sourceAlpha)) / alpha);
    output[to + 3] = Math.round(alpha * 255);
  }
  return output;
}

export function quadSelection(selection: PixelSelection | null, width: number, height: number, sourceBounds: RasterRect, corners: readonly [Point, Point, Point, Point]): PixelSelection | null {
  if (!selection) return null;
  const mask = new Uint8ClampedArray(width * height);
  const mapping = quadMapping(corners);
  const xs = corners.map((p) => p.x), ys = corners.map((p) => p.y);
  const targetLeft = Math.floor(Math.min(...xs)), targetTop = Math.floor(Math.min(...ys)), targetRight = Math.ceil(Math.max(...xs)), targetBottom = Math.ceil(Math.max(...ys));
  for (let y = Math.max(0, targetTop); y < Math.min(height, targetBottom); y += 1) for (let x = Math.max(0, targetLeft); x < Math.min(width, targetRight); x += 1) {
    const { u, v } = inverseUnitSquare(mapping, x + .5, y + .5);
    if (u < 0 || u > 1 || v < 0 || v > 1) continue;
    const sourceX = Math.max(0, Math.min(width - 1, Math.floor(sourceBounds.x + u * sourceBounds.width)));
    const sourceY = Math.max(0, Math.min(height - 1, Math.floor(sourceBounds.y + v * sourceBounds.height)));
    mask[y * width + x] = selection.mask[sourceY * width + sourceX]!;
  }
  const bounds = selectionBounds(mask, width, height);
  return bounds.width && bounds.height ? { mask, bounds } : null;
}

export function translateLayerPixels(pixels: Uint8ClampedArray, width: number, height: number, dx: number, dy: number, selection: PixelSelection | null = null): Uint8ClampedArray {
  const offsetX = Math.round(dx), offsetY = Math.round(dy);

  // Moving a whole layer is a block copy, not a composite. With no selection
  // every pixel is taken and every pixel is cleared behind it, so the general
  // path below erases the image and then blends it back over emptiness — two
  // per-pixel passes over the document to express a memmove. That was 134 ms a
  // frame while dragging, which is the pause between moving the mouse and the
  // layer following.
  if (!selection) {
    const output = new Uint8ClampedArray(pixels.length);
    const from = Math.max(0, -offsetX), to = Math.min(width, width - offsetX);
    if (to > from) {
      for (let y = 0; y < height; y += 1) {
        const targetY = y + offsetY;
        if (targetY < 0 || targetY >= height) continue;
        const sourceStart = (y * width + from) * 4;
        output.set(pixels.subarray(sourceStart, sourceStart + (to - from) * 4), (targetY * width + from + offsetX) * 4);
      }
    }
    return output;
  }

  const output = pixels.slice();
  const selectionAlpha = (index: number) => selection.mask[index]! / 255;
  // Only the selected area is taken and only it is cleared, so both passes stay
  // inside its bounds instead of walking the document twice.
  const left = Math.max(0, Math.floor(selection.bounds.x)), top = Math.max(0, Math.floor(selection.bounds.y));
  const right = Math.min(width, Math.ceil(selection.bounds.x + selection.bounds.width));
  const bottom = Math.min(height, Math.ceil(selection.bounds.y + selection.bounds.height));
  for (let y = top; y < bottom; y += 1) for (let x = left; x < right; x += 1) {
    const index = y * width + x;
    const selected = selectionAlpha(index); if (selected <= 0) continue;
    const pixel = index * 4, remaining = 1 - selected;
    output[pixel] = Math.round(output[pixel]! * remaining); output[pixel + 1] = Math.round(output[pixel + 1]! * remaining); output[pixel + 2] = Math.round(output[pixel + 2]! * remaining); output[pixel + 3] = Math.round(output[pixel + 3]! * remaining);
  }
  for (let y = top; y < bottom; y += 1) for (let x = left; x < right; x += 1) {
    const sourcePixel = y * width + x;
    const maskAlpha = selectionAlpha(sourcePixel); if (maskAlpha <= 0) continue;
    const targetX = x + offsetX, targetY = y + offsetY;
    if (targetX < 0 || targetX >= width || targetY < 0 || targetY >= height) continue;
    const source = sourcePixel * 4, target = (targetY * width + targetX) * 4;
    const sourceAlpha = pixels[source + 3]! / 255 * maskAlpha, destinationAlpha = output[target + 3]! / 255, alpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
    if (alpha <= 0) continue;
    output[target] = Math.round((pixels[source]! * sourceAlpha + output[target]! * destinationAlpha * (1 - sourceAlpha)) / alpha);
    output[target + 1] = Math.round((pixels[source + 1]! * sourceAlpha + output[target + 1]! * destinationAlpha * (1 - sourceAlpha)) / alpha);
    output[target + 2] = Math.round((pixels[source + 2]! * sourceAlpha + output[target + 2]! * destinationAlpha * (1 - sourceAlpha)) / alpha);
    output[target + 3] = Math.round(alpha * 255);
  }
  return output;
}

export function translateSelection(selection: PixelSelection | null, width: number, height: number, dx: number, dy: number): PixelSelection | null {
  if (!selection) return null;
  const mask = new Uint8ClampedArray(width * height), offsetX = Math.round(dx), offsetY = Math.round(dy);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const targetX = x + offsetX, targetY = y + offsetY;
    if (targetX >= 0 && targetX < width && targetY >= 0 && targetY < height) mask[targetY * width + targetX] = selection.mask[y * width + x]!;
  }
  const bounds = selectionBounds(mask, width, height);
  return bounds.width && bounds.height ? { mask, bounds } : null;
}

/** Non-destructively remaps pixels inside sourceBounds into targetBounds. Transparent
 * source samples do not erase pixels already present under the transformed content. */
export function scaleLayerPixels(pixels: Uint8ClampedArray, width: number, height: number, sourceBounds: RasterRect, targetBounds: RasterRect, selection: PixelSelection | null = null): Uint8ClampedArray {
  const output = pixels.slice(), source = pixels.slice();
  const left = Math.max(0, Math.floor(sourceBounds.x)), top = Math.max(0, Math.floor(sourceBounds.y));
  const right = Math.min(width, Math.ceil(sourceBounds.x + sourceBounds.width)), bottom = Math.min(height, Math.ceil(sourceBounds.y + sourceBounds.height));
  const selectedAlpha = (index: number) => selection ? selection.mask[index]! / 255 : (index % width >= left && index % width < right && Math.floor(index / width) >= top && Math.floor(index / width) < bottom ? 1 : 0);
  for (let y = top; y < bottom; y += 1) for (let x = left; x < right; x += 1) {
    const index = y * width + x, alpha = selectedAlpha(index); if (alpha <= 0) continue;
    const pixel = index * 4, remaining = 1 - alpha;
    output[pixel] = Math.round(output[pixel]! * remaining); output[pixel + 1] = Math.round(output[pixel + 1]! * remaining); output[pixel + 2] = Math.round(output[pixel + 2]! * remaining); output[pixel + 3] = Math.round(output[pixel + 3]! * remaining);
  }
  const targetLeft = Math.floor(targetBounds.x), targetTop = Math.floor(targetBounds.y), targetRight = Math.ceil(targetBounds.x + targetBounds.width), targetBottom = Math.ceil(targetBounds.y + targetBounds.height);
  for (let y = targetTop; y < targetBottom; y += 1) for (let x = targetLeft; x < targetRight; x += 1) {
    if (x < 0 || x >= width || y < 0 || y >= height) continue;
    const u = (x + .5 - targetBounds.x) / Math.max(.001, targetBounds.width), v = (y + .5 - targetBounds.y) / Math.max(.001, targetBounds.height);
    const sourceX = Math.max(left, Math.min(right - 1, Math.floor(sourceBounds.x + u * sourceBounds.width))), sourceY = Math.max(top, Math.min(bottom - 1, Math.floor(sourceBounds.y + v * sourceBounds.height)));
    const sourceIndex = sourceY * width + sourceX, maskAlpha = selectedAlpha(sourceIndex); if (maskAlpha <= 0) continue;
    const from = sourceIndex * 4, to = (y * width + x) * 4, sourceAlpha = source[from + 3]! / 255 * maskAlpha, destinationAlpha = output[to + 3]! / 255, alpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
    if (alpha <= 0) continue;
    output[to] = Math.round((source[from]! * sourceAlpha + output[to]! * destinationAlpha * (1 - sourceAlpha)) / alpha);
    output[to + 1] = Math.round((source[from + 1]! * sourceAlpha + output[to + 1]! * destinationAlpha * (1 - sourceAlpha)) / alpha);
    output[to + 2] = Math.round((source[from + 2]! * sourceAlpha + output[to + 2]! * destinationAlpha * (1 - sourceAlpha)) / alpha);
    output[to + 3] = Math.round(alpha * 255);
  }
  return output;
}

export function scaleSelection(selection: PixelSelection | null, width: number, height: number, sourceBounds: RasterRect, targetBounds: RasterRect): PixelSelection | null {
  if (!selection) return null;
  const mask = new Uint8ClampedArray(width * height), left = Math.floor(targetBounds.x), top = Math.floor(targetBounds.y), right = Math.ceil(targetBounds.x + targetBounds.width), bottom = Math.ceil(targetBounds.y + targetBounds.height);
  for (let y = top; y < bottom; y += 1) for (let x = left; x < right; x += 1) {
    if (x < 0 || x >= width || y < 0 || y >= height) continue;
    const u = (x + .5 - targetBounds.x) / Math.max(.001, targetBounds.width), v = (y + .5 - targetBounds.y) / Math.max(.001, targetBounds.height);
    const sourceX = Math.max(0, Math.min(width - 1, Math.floor(sourceBounds.x + u * sourceBounds.width))), sourceY = Math.max(0, Math.min(height - 1, Math.floor(sourceBounds.y + v * sourceBounds.height)));
    mask[y * width + x] = selection.mask[sourceY * width + sourceX]!;
  }
  const bounds = selectionBounds(mask, width, height);
  return bounds.width && bounds.height ? { mask, bounds } : null;
}

export function rotateLayerPixels(pixels: Uint8ClampedArray, width: number, height: number, bounds: RasterRect, degrees: number, selection: PixelSelection | null = null): Uint8ClampedArray {
  const output = pixels.slice(), source = pixels.slice(), radians = degrees * Math.PI / 180, cosine = Math.cos(radians), sine = Math.sin(radians), centerX = bounds.x + bounds.width / 2, centerY = bounds.y + bounds.height / 2;
  const selectedAlpha = (x: number, y: number) => x < 0 || x >= width || y < 0 || y >= height ? 0 : selection ? selection.mask[y * width + x]! / 255 : (x >= bounds.x && x < bounds.x + bounds.width && y >= bounds.y && y < bounds.y + bounds.height ? 1 : 0);
  for (let y = Math.max(0, Math.floor(bounds.y)); y < Math.min(height, Math.ceil(bounds.y + bounds.height)); y += 1) for (let x = Math.max(0, Math.floor(bounds.x)); x < Math.min(width, Math.ceil(bounds.x + bounds.width)); x += 1) {
    const alpha = selectedAlpha(x, y); if (alpha <= 0) continue; const pixel = (y * width + x) * 4, remaining = 1 - alpha;
    output[pixel] = Math.round(output[pixel]! * remaining); output[pixel + 1] = Math.round(output[pixel + 1]! * remaining); output[pixel + 2] = Math.round(output[pixel + 2]! * remaining); output[pixel + 3] = Math.round(output[pixel + 3]! * remaining);
  }
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const dx = x + .5 - centerX, dy = y + .5 - centerY, sourceX = Math.floor(centerX + cosine * dx + sine * dy), sourceY = Math.floor(centerY - sine * dx + cosine * dy), maskAlpha = selectedAlpha(sourceX, sourceY); if (maskAlpha <= 0) continue;
    const from = (sourceY * width + sourceX) * 4, to = (y * width + x) * 4, sourceAlpha = source[from + 3]! / 255 * maskAlpha, destinationAlpha = output[to + 3]! / 255, alpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha); if (alpha <= 0) continue;
    output[to] = Math.round((source[from]! * sourceAlpha + output[to]! * destinationAlpha * (1 - sourceAlpha)) / alpha); output[to + 1] = Math.round((source[from + 1]! * sourceAlpha + output[to + 1]! * destinationAlpha * (1 - sourceAlpha)) / alpha); output[to + 2] = Math.round((source[from + 2]! * sourceAlpha + output[to + 2]! * destinationAlpha * (1 - sourceAlpha)) / alpha); output[to + 3] = Math.round(alpha * 255);
  }
  return output;
}

export function rotateSelection(selection: PixelSelection | null, width: number, height: number, bounds: RasterRect, degrees: number): PixelSelection | null {
  if (!selection) return null;
  const mask = new Uint8ClampedArray(width * height), radians = degrees * Math.PI / 180, cosine = Math.cos(radians), sine = Math.sin(radians), centerX = bounds.x + bounds.width / 2, centerY = bounds.y + bounds.height / 2;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) { const dx = x + .5 - centerX, dy = y + .5 - centerY, sourceX = Math.floor(centerX + cosine * dx + sine * dy), sourceY = Math.floor(centerY - sine * dx + cosine * dy); if (sourceX >= 0 && sourceX < width && sourceY >= 0 && sourceY < height) mask[y * width + x] = selection.mask[sourceY * width + sourceX]!; }
  const rotatedBounds = selectionBounds(mask, width, height); return rotatedBounds.width && rotatedBounds.height ? { mask, bounds: rotatedBounds } : null;
}

/** Bounding box of non-transparent pixels; falls back to the full canvas for an empty layer. */
export function layerContentBounds(pixels: Uint8ClampedArray, width: number, height: number): RasterRect {
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    if (pixels[(y * width + x) * 4 + 3] === 0) continue;
    left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
  }
  return right < left ? { x: 0, y: 0, width, height } : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

export type AlignEdge = "left" | "centerH" | "right" | "top" | "centerV" | "bottom";

/** Photoshop-style Align: each bound moves so its edge/center matches referenceBounds' edge/center. */
export function computeAlignOffsets(bounds: RasterRect[], edge: AlignEdge, referenceBounds: RasterRect): Array<{ dx: number; dy: number }> {
  return bounds.map((box) => {
    switch (edge) {
      case "left": return { dx: referenceBounds.x - box.x, dy: 0 };
      case "right": return { dx: referenceBounds.x + referenceBounds.width - (box.x + box.width), dy: 0 };
      case "centerH": return { dx: referenceBounds.x + referenceBounds.width / 2 - (box.x + box.width / 2), dy: 0 };
      case "top": return { dx: 0, dy: referenceBounds.y - box.y };
      case "bottom": return { dx: 0, dy: referenceBounds.y + referenceBounds.height - (box.y + box.height) };
      case "centerV": return { dx: 0, dy: referenceBounds.y + referenceBounds.height / 2 - (box.y + box.height / 2) };
    }
  });
}

/** Photoshop-style Distribute: the outermost two layers stay put, the rest are spaced evenly between them. Needs 3+ bounds. */
export function computeDistributeOffsets(bounds: RasterRect[], edge: AlignEdge): Array<{ dx: number; dy: number }> {
  const horizontal = edge === "left" || edge === "centerH" || edge === "right";
  const key = (box: RasterRect) => edge === "left" ? box.x : edge === "right" ? box.x + box.width : edge === "centerH" ? box.x + box.width / 2 : edge === "top" ? box.y : edge === "bottom" ? box.y + box.height : box.y + box.height / 2;
  const order = bounds.map((_, index) => index).sort((a, b) => key(bounds[a]!) - key(bounds[b]!));
  const first = key(bounds[order[0]!]!), last = key(bounds[order[order.length - 1]!]!), step = order.length > 1 ? (last - first) / (order.length - 1) : 0;
  const offsets = bounds.map(() => ({ dx: 0, dy: 0 }));
  order.forEach((index, position) => {
    const delta = first + step * position - key(bounds[index]!);
    offsets[index] = horizontal ? { dx: delta, dy: 0 } : { dx: 0, dy: delta };
  });
  return offsets;
}

export function cropRasterDocument(state: RasterDocumentState, crop: RasterRect): RasterDocumentState {
  const left = Math.max(0, Math.min(state.width - 1, Math.floor(crop.x))), top = Math.max(0, Math.min(state.height - 1, Math.floor(crop.y)));
  const right = Math.max(left + 1, Math.min(state.width, Math.ceil(crop.x + crop.width))), bottom = Math.max(top + 1, Math.min(state.height, Math.ceil(crop.y + crop.height)));
  const width = right - left, height = bottom - top;
  const layers = state.layers.map((layer) => {
    // Read in canvas space: a layer is stored at the size of its content, so
    // its own buffer cannot be indexed by the document's stride.
    const canvas = layerDocumentPixels(layer, state.width, state.height);
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      const source = ((top + y) * state.width + left) * 4;
      pixels.set(canvas.subarray(source, source + width * 4), y * width * 4);
    }
    return { ...layer, bounds: { x: 0, y: 0, width, height }, width, height, pixels };
  });
  let selection: PixelSelection | null = null;
  if (state.selection) {
    const mask = new Uint8ClampedArray(width * height);
    for (let y = 0; y < height; y += 1) mask.set(state.selection.mask.subarray((top + y) * state.width + left, (top + y) * state.width + left + width), y * width);
    const bounds = selectionBounds(mask, width, height);
    if (bounds.width && bounds.height) selection = { mask, bounds };
  }
  return { ...state, width, height, layers, selection };
}

export interface FloatingPixels {
  /** The layer with the selected content taken out, computed once. */
  readonly base: Uint8ClampedArray;
  /** The content that was taken, in place, transparent everywhere else. */
  readonly content: Uint8ClampedArray;
  /** Where the content sat when it was lifted, for bounding the redraw. */
  readonly bounds: RasterRect;
}

/**
 * Takes the selected content off a layer, once.
 *
 * This is GIMP's floating selection and Photoshop's floating content, and the
 * reason both work that way: a move that cuts and pastes on every frame is
 * cutting from an image it has already cut from, so a soft edge leaves a
 * fraction of itself behind at every position the pointer passed through. Lift
 * once, then move what was lifted — the hole is made a single time and cannot
 * be made again.
 *
 * Coverage is honoured on both halves: what the float takes is exactly what the
 * base loses, so a feathered edge stays continuous across the pair.
 */
export function liftSelection(
  pixels: Uint8ClampedArray, width: number, height: number, selection: PixelSelection | null,
): FloatingPixels {
  const base = pixels.slice();
  const content = new Uint8ClampedArray(pixels.length);
  if (!selection) {
    // No selection means the whole layer floats and the layer is left empty.
    content.set(pixels);
    base.fill(0);
    return { base, content, bounds: { x: 0, y: 0, width, height } };
  }

  const left = Math.max(0, Math.floor(selection.bounds.x)), top = Math.max(0, Math.floor(selection.bounds.y));
  const right = Math.min(width, Math.ceil(selection.bounds.x + selection.bounds.width));
  const bottom = Math.min(height, Math.ceil(selection.bounds.y + selection.bounds.height));
  for (let y = top; y < bottom; y += 1) for (let x = left; x < right; x += 1) {
    const index = y * width + x;
    const coverage = selection.mask[index]! / 255;
    if (coverage <= 0) continue;
    const at = index * 4;
    const alpha = pixels[at + 3]!;
    content[at] = pixels[at]!; content[at + 1] = pixels[at + 1]!; content[at + 2] = pixels[at + 2]!;
    content[at + 3] = Math.round(alpha * coverage);
    base[at + 3] = Math.round(alpha * (1 - coverage));
  }
  return { base, content, bounds: { x: left, y: top, width: right - left, height: bottom - top } };
}

/**
 * Puts floating content back down at an offset, over the layer it came from.
 *
 * Pure composition — nothing is removed here, so however many times a float is
 * placed, the hole underneath stays the one hole that was cut when it was
 * lifted.
 */
export function stampFloating(
  float: FloatingPixels, width: number, height: number, dx: number, dy: number,
): Uint8ClampedArray {
  const output = float.base.slice();
  const offsetX = Math.round(dx), offsetY = Math.round(dy);
  const { bounds } = float;
  for (let y = bounds.y; y < bounds.y + bounds.height; y += 1) {
    const targetY = y + offsetY;
    if (targetY < 0 || targetY >= height) continue;
    for (let x = bounds.x; x < bounds.x + bounds.width; x += 1) {
      const targetX = x + offsetX;
      if (targetX < 0 || targetX >= width) continue;
      const source = (y * width + x) * 4;
      const sourceAlpha = float.content[source + 3]! / 255;
      if (sourceAlpha <= 0) continue;
      const target = (targetY * width + targetX) * 4;
      const destinationAlpha = output[target + 3]! / 255;
      const alpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
      if (alpha <= 0) continue;
      const carry = destinationAlpha * (1 - sourceAlpha);
      output[target] = Math.round((float.content[source]! * sourceAlpha + output[target]! * carry) / alpha);
      output[target + 1] = Math.round((float.content[source + 1]! * sourceAlpha + output[target + 1]! * carry) / alpha);
      output[target + 2] = Math.round((float.content[source + 2]! * sourceAlpha + output[target + 2]! * carry) / alpha);
      output[target + 3] = Math.round(alpha * 255);
    }
  }
  return output;
}
