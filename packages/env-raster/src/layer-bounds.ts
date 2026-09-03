import type { RasterLayer, RasterRect } from "./types";

/** The rectangle outside which a buffer has nothing but transparency. */
export function opaqueBoundsOf(pixels: Uint8ClampedArray, width: number, height: number): RasterRect | null {
  const words = pixels.byteLength === width * height * 4 && pixels.byteOffset % 4 === 0
    ? new Uint32Array(pixels.buffer, pixels.byteOffset, width * height)
    : null;
  let left = width, top = height, right = 0, bottom = 0;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    let rowLeft = -1, rowRight = -1;
    for (let x = 0; x < width; x += 1) {
      const opaque = words ? (words[row + x]! & 0xff000000) !== 0 : pixels[(row + x) * 4 + 3] !== 0;
      if (!opaque) continue;
      if (rowLeft < 0) rowLeft = x;
      rowRight = x;
    }
    if (rowLeft < 0) continue;
    if (y < top) top = y;
    bottom = y + 1;
    if (rowLeft < left) left = rowLeft;
    if (rowRight + 1 > right) right = rowRight + 1;
  }
  return right > left && bottom > top ? { x: left, y: top, width: right - left, height: bottom - top } : null;
}

/**
 * Grows `current` to also cover the (x0,y0)-(x1,y1) segment, padded by
 * `pad` in every direction.
 *
 * The dirty-region accumulator every stroke tool needs: a dab only touches
 * pixels within its own radius of the point it was placed at, so the pad is
 * normally half the brush size — enough margin that a repaint cropped to
 * this rect never clips the stroke it is supposed to show.
 */
export function unionRect(current: RasterRect | null, x0: number, y0: number, x1: number, y1: number, pad: number): RasterRect {
  const left = Math.min(x0, x1) - pad, top = Math.min(y0, y1) - pad, right = Math.max(x0, x1) + pad, bottom = Math.max(y0, y1) + pad;
  if (!current) return { x: left, y: top, width: right - left, height: bottom - top };
  const nextLeft = Math.min(current.x, left), nextTop = Math.min(current.y, top);
  return { x: nextLeft, y: nextTop, width: Math.max(current.x + current.width, right) - nextLeft, height: Math.max(current.y + current.height, bottom) - nextTop };
}

/**
 * The layer's pixels laid out across the whole document.
 *
 * The bridge for everything that still thinks in canvas coordinates — filters,
 * dialogs, exporters, the tools mid-gesture. Cached against the layer's buffer,
 * which is safe because every path that edits pixels assigns a fresh one; a
 * layer read repeatedly without being edited materialises once.
 */
const materialised = new WeakMap<Uint8ClampedArray, { width: number; height: number; bounds: RasterRect; pixels: Uint8ClampedArray }>();

export function layerDocumentPixels(layer: RasterLayer, documentWidth: number, documentHeight: number): Uint8ClampedArray {
  const bounds = layer.bounds;
  if (bounds.x === 0 && bounds.y === 0 && bounds.width === documentWidth && bounds.height === documentHeight) return layer.pixels;

  const cached = materialised.get(layer.pixels);
  if (cached && cached.width === documentWidth && cached.height === documentHeight
    && cached.bounds.x === bounds.x && cached.bounds.y === bounds.y
    && cached.bounds.width === bounds.width && cached.bounds.height === bounds.height) return cached.pixels;

  const pixels = new Uint8ClampedArray(documentWidth * documentHeight * 4);
  const rowBytes = Math.max(0, Math.min(bounds.width, documentWidth - bounds.x)) * 4;
  if (rowBytes > 0) {
    for (let y = 0; y < bounds.height; y += 1) {
      const documentY = bounds.y + y;
      if (documentY < 0 || documentY >= documentHeight) continue;
      const from = y * bounds.width * 4;
      pixels.set(layer.pixels.subarray(from, from + rowBytes), (documentY * documentWidth + bounds.x) * 4);
    }
  }
  materialised.set(layer.pixels, { width: documentWidth, height: documentHeight, bounds: { ...bounds }, pixels });
  return pixels;
}

/**
 * Cuts a document-sized buffer down to what it actually holds.
 *
 * The other half of the bridge: a tool works at canvas size for the length of a
 * gesture — a stroke may go anywhere — and what gets stored is trimmed to the
 * result. An empty result keeps a single pixel rather than a zero-sized buffer,
 * so a layer always has somewhere to be painted next.
 */
export function trimToContent(pixels: Uint8ClampedArray, documentWidth: number, documentHeight: number): { bounds: RasterRect; pixels: Uint8ClampedArray } {
  const bounds = opaqueBoundsOf(pixels, documentWidth, documentHeight) ?? { x: 0, y: 0, width: 1, height: 1 };
  const trimmed = new Uint8ClampedArray(bounds.width * bounds.height * 4);
  for (let y = 0; y < bounds.height; y += 1) {
    const from = ((bounds.y + y) * documentWidth + bounds.x) * 4;
    trimmed.set(pixels.subarray(from, from + bounds.width * 4), y * bounds.width * 4);
  }
  return { bounds, pixels: trimmed };
}

/** Stores a document-sized result on a layer, trimmed to what it holds. */
export function setLayerPixels(layer: RasterLayer, pixels: Uint8ClampedArray, documentWidth: number, documentHeight: number): void {
  const { bounds, pixels: trimmed } = trimToContent(pixels, documentWidth, documentHeight);
  layer.bounds = bounds;
  layer.width = bounds.width;
  layer.height = bounds.height;
  layer.pixels = trimmed;
}

/** Reads one pixel's alpha in document coordinates, without materialising. */
export function layerAlphaAt(layer: RasterLayer, x: number, y: number): number {
  const { bounds } = layer;
  const localX = x - bounds.x, localY = y - bounds.y;
  if (localX < 0 || localY < 0 || localX >= bounds.width || localY >= bounds.height) return 0;
  return layer.pixels[(localY * bounds.width + localX) * 4 + 3] ?? 0;
}

/**
 * Every pixel buffer a document reaches: layers, masks and the selection.
 *
 * Patchy walks the same set to price its history, and the walk matters more
 * than the sum: buffers are shared between a document and its history
 * snapshots, so anything that counts them per snapshot reports several times
 * the memory actually in use and starts discarding undo depth that costs
 * nothing to keep.
 */
export function visitPixelBuffers(state: { layers: readonly RasterLayer[]; selection?: { mask: Uint8ClampedArray } | null }, visit: (buffer: ArrayBufferView) => void): void {
  for (const layer of state.layers) {
    visit(layer.pixels);
    if (layer.mask) visit(layer.mask.pixels);
  }
  if (state.selection) visit(state.selection.mask);
}

/**
 * Bytes held by buffers this document reaches and `seen` has not counted.
 *
 * Each buffer is charged once however many documents or snapshots point at it,
 * and `seen` carries across calls so a whole history can be priced by walking
 * its states in turn.
 */
export function accumulateUniquePixelBytes(
  state: { layers: readonly RasterLayer[]; selection?: { mask: Uint8ClampedArray } | null },
  seen: Set<ArrayBufferView>,
): number {
  let bytes = 0;
  visitPixelBuffers(state, (buffer) => {
    if (seen.has(buffer)) return;
    seen.add(buffer);
    bytes += buffer.byteLength;
  });
  return bytes;
}
