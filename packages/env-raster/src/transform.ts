import { selectionBounds } from "./selection";
import type { PixelSelection, RasterDocumentState, RasterRect } from "./types";

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
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      const source = ((top + y) * state.width + left) * 4;
      pixels.set(layer.pixels.subarray(source, source + width * 4), y * width * 4);
    }
    return { ...layer, width, height, pixels };
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
