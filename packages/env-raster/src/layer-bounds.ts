import { smartObjectTransform } from "./smart-object";
import { TileStore } from "./tile-store";
import type { RasterBitDepth } from "./pixel-format";
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
 * dialogs, exporters, the tools mid-gesture. Cached against the layer itself,
 * validated by `pixelsRevision` (docs/master-plan.md §37.6.2); a layer read
 * repeatedly without being edited materialises once.
 */
interface MaterialisedLayer {
  readonly width: number;
  readonly height: number;
  readonly bounds: RasterRect;
  readonly pixels: Uint8ClampedArray;
  /** The source layer's `pixelsRevision` at the moment this projection was built (docs/master-plan.md §37.6.2) — every cached projection for a layer goes stale together the instant its source content changes, so this is checked once per lookup rather than tracked per entry differently. */
  readonly pixelsRevision: number;
}

/**
 * A source layer may be placed more than once as independent Smart Object
 * instances. Keep a small LRU-like set of projections per source instead of
 * evicting the previous instance on every paint pass. The WeakMap still lets
 * all projections disappear as soon as their source layer does; `pixelsRevision`
 * is what lets a projection disappear the instant the source's *content*
 * does, without needing a fresh `layer.pixels` object to key on.
 */
const materialised = new WeakMap<RasterLayer, Map<string, MaterialisedLayer>>();
const MAX_MATERIALISED_PROJECTIONS = 4;

function cachedMaterialisation(layer: RasterLayer, key: string): Uint8ClampedArray | null {
  const entries = materialised.get(layer);
  const cached = entries?.get(key);
  if (!cached || cached.width < 1 || cached.height < 1 || cached.pixelsRevision !== layer.pixelsRevision) return null;
  // Refresh insertion order so the least recently used projection is removed.
  entries!.delete(key); entries!.set(key, cached);
  return cached.pixels;
}

function cacheMaterialisation(layer: RasterLayer, key: string, width: number, height: number, bounds: RasterRect, pixels: Uint8ClampedArray): void {
  const entries = materialised.get(layer) ?? new Map<string, MaterialisedLayer>();
  if (!materialised.has(layer)) materialised.set(layer, entries);
  while (entries.size >= MAX_MATERIALISED_PROJECTIONS) entries.delete(entries.keys().next().value!);
  entries.set(key, { width, height, bounds: { ...bounds }, pixels, pixelsRevision: layer.pixelsRevision });
}

/**
 * A layer's own bounds-local buffer, materialised from `layer.tiles` and cached by
 * `pixelsRevision` — what `layer.pixels` used to just *be*, at zero cost, before
 * docs/master-plan.md §37.6.3 moved storage to `TileStore`. Every reader that wants the whole
 * buffer as one contiguous `Uint8ClampedArray` (the compositor's ordinary-layer fast path,
 * `layerDocumentPixels`'s own two branches, Smart Object resampling) goes through this instead
 * of touching `layer.tiles` directly, so the materialise happens once per edit instead of once
 * per read — the same trade `layerDocumentPixels`'s own cache already makes for document-space
 * projections, one level down. A single-pixel read that must not pay for a full materialise
 * (`layerAlphaAt`) goes to `layer.tiles.readPixel` instead, never through here.
 */
const pixelsViews = new WeakMap<RasterLayer, { pixelsRevision: number; pixels: Uint8ClampedArray }>();

export function layerPixelsView(layer: RasterLayer): Uint8ClampedArray {
  const cached = pixelsViews.get(layer);
  if (cached && cached.pixelsRevision === layer.pixelsRevision) return cached.pixels;
  const pixels = layer.tiles.toPixels();
  pixelsViews.set(layer, { pixelsRevision: layer.pixelsRevision, pixels });
  return pixels;
}

/**
 * The one door for code that needs `layer.tiles` itself — not a materialised copy of it — to read
 * or write raw tile bytes directly (`readLocalRegion`/`writeLocalRegion`/`reframe`, the operations
 * `layerPixelsView` above deliberately doesn't cover, since they mutate or address the store below
 * the whole-buffer level). Synchronous passthrough today, same as `layerPixelsView`: every
 * `TileStore` this package builds is fully resident in memory, always.
 *
 * It exists anyway — before docs/master-plan.md §37.3 item 6 (tile swap beyond RAM) needs it, not
 * after — because that item's whole difficulty is that a `RasterLayer`'s tiles are touched from
 * many, mostly-unrelated call sites across this package and `apps/web`, and almost all of them go
 * through `layerPixelsView`/`layerDocumentPixels` already or never touch pixel bytes at all
 * (`{ ...layer, tiles: layer.tiles }`-style structural copies, `clone()`, which only copies the
 * tile *map* and needs no byte resident either way). Auditing the whole codebase found exactly two
 * genuine raw-byte touches outside that whole-buffer door: `region-patch.ts`'s `swapLayerRegion`
 * (undo/redo's GIMP-style rectangle exchange, `readLocalRegion`/`writeLocalRegion`) and its own
 * `trimInPlace` (`toPixels()`, deliberately bypassing `layerPixelsView`'s cache for a reason its own
 * comment explains). Both now go through this function instead of `layer.tiles` directly — not
 * because it does anything different today, but so a future eviction check has exactly one place to
 * land, instead of a second audit of the same ground. Undo/redo in particular can target *any*
 * previously-edited layer, not just the active one, which is exactly the case a hidden+inactive
 * layer's eviction has to plan for.
 */
export function residentLayerTiles(layer: RasterLayer): TileStore {
  return layer.tiles;
}

/** Samples straight-alpha source pixels with bilinear filtering in premultiplied
 * space, avoiding both jagged transformed objects and dark transparent fringes. */
function sampleBilinear(source: Uint8ClampedArray, width: number, height: number, x: number, y: number, target: Uint8ClampedArray, targetOffset: number): void {
  const left = Math.floor(x), top = Math.floor(y), fx = x - left, fy = y - top;
  let red = 0, green = 0, blue = 0, alpha = 0;
  for (let row = 0; row <= 1; row += 1) for (let column = 0; column <= 1; column += 1) {
    // The caller has already rejected samples outside the transformed source
    // rectangle. At the edge, extend the last source pixel instead of mixing
    // it with transparent black (the usual image-resampling edge behaviour).
    const sourceX = Math.max(0, Math.min(width - 1, left + column));
    const sourceY = Math.max(0, Math.min(height - 1, top + row));
    const weight = (column ? fx : 1 - fx) * (row ? fy : 1 - fy);
    const offset = (sourceY * width + sourceX) * 4, sourceAlpha = source[offset + 3]! / 255;
    alpha += sourceAlpha * weight;
    red += source[offset]! * sourceAlpha * weight;
    green += source[offset + 1]! * sourceAlpha * weight;
    blue += source[offset + 2]! * sourceAlpha * weight;
  }
  if (alpha <= 0) return;
  target[targetOffset] = Math.round(red / alpha);
  target[targetOffset + 1] = Math.round(green / alpha);
  target[targetOffset + 2] = Math.round(blue / alpha);
  target[targetOffset + 3] = Math.round(alpha * 255);
}

/**
 * `region`, when given, asks for only that document-space rectangle of the result instead of the
 * whole document (docs/master-plan.md §37.3 item 2 — the same ROI contract `effects.ts`'s
 * `renderLayerEffects` takes). A region smaller than the full document never reads or writes
 * `cachedMaterialisation`/`cacheMaterialisation` below — a partial result is never mistaken for
 * the cached whole one, so this path only ever skips unneeded work, never serves stale data.
 */
export function layerDocumentPixels(layer: RasterLayer, documentWidth: number, documentHeight: number, region?: RasterRect): Uint8ClampedArray {
  const bounds = layer.bounds;
  const fullRegion = !region || (region.x === 0 && region.y === 0 && region.width === documentWidth && region.height === documentHeight);
  const target = fullRegion ? { x: 0, y: 0, width: documentWidth, height: documentHeight } : region!;
  const placement = smartObjectTransform(layer);
  if (placement) {
    let cacheKey = "";
    if (fullRegion) {
      const placementKey = `${placement.a},${placement.b},${placement.c},${placement.d},${placement.e},${placement.f}`;
      cacheKey = `smart:${documentWidth}x${documentHeight}:${placementKey}`;
      const cached = cachedMaterialisation(layer, cacheKey);
      if (cached) return cached;
    }
    const determinant = placement.a * placement.d - placement.b * placement.c;
    const pixels = new Uint8ClampedArray(target.width * target.height * 4);
    if (Math.abs(determinant) > 1e-8) {
      const left = Math.max(target.x, bounds.x), right = Math.min(target.x + target.width, bounds.x + bounds.width);
      const top = Math.max(target.y, bounds.y), bottom = Math.min(target.y + target.height, bounds.y + bounds.height);
      // Materialised once, not once per destination pixel — this loop can run millions of times.
      const source = layerPixelsView(layer);
      for (let y = top; y < bottom; y += 1) for (let x = left; x < right; x += 1) {
        const dx = x + .5 - placement.e, dy = y + .5 - placement.f;
        // Coordinates above address source-pixel centres. Shift by half a
        // pixel so identity placement remains exact while fractional scale and
        // rotation interpolate the surrounding four source pixels.
        const sourceCentreX = (placement.d * dx - placement.c * dy) / determinant;
        const sourceCentreY = (-placement.b * dx + placement.a * dy) / determinant;
        if (sourceCentreX < 0 || sourceCentreY < 0 || sourceCentreX >= layer.width || sourceCentreY >= layer.height) continue;
        const sourceX = sourceCentreX - .5;
        const sourceY = sourceCentreY - .5;
        sampleBilinear(source, layer.width, layer.height, sourceX, sourceY, pixels, ((y - target.y) * target.width + (x - target.x)) * 4);
      }
    }
    if (fullRegion) cacheMaterialisation(layer, cacheKey, documentWidth, documentHeight, bounds, pixels);
    return pixels;
  }
  if (fullRegion && bounds.x === 0 && bounds.y === 0 && bounds.width === documentWidth && bounds.height === documentHeight) return layerPixelsView(layer);

  let cacheKey = "";
  if (fullRegion) {
    cacheKey = `layer:${documentWidth}x${documentHeight}:${bounds.x},${bounds.y},${bounds.width},${bounds.height}`;
    const cached = cachedMaterialisation(layer, cacheKey);
    if (cached) return cached;
  }

  const source = layerPixelsView(layer);
  const pixels = new Uint8ClampedArray(target.width * target.height * 4);
  // Non-destructive crop can put retained pixels left/above the canvas. Read
  // only the visible intersection, never using a negative destination offset.
  const visibleLeft = Math.max(target.x, bounds.x);
  const visibleRight = Math.min(target.x + target.width, bounds.x + bounds.width);
  const rowBytes = Math.max(0, visibleRight - visibleLeft) * 4;
  const sourceOffset = Math.max(0, visibleLeft - bounds.x) * 4;
  if (rowBytes > 0) {
    for (let y = 0; y < bounds.height; y += 1) {
      const documentY = bounds.y + y;
      if (documentY < target.y || documentY >= target.y + target.height) continue;
      const from = y * bounds.width * 4 + sourceOffset;
      pixels.set(source.subarray(from, from + rowBytes), ((documentY - target.y) * target.width + (visibleLeft - target.x)) * 4);
    }
  }
  if (fullRegion) cacheMaterialisation(layer, cacheKey, documentWidth, documentHeight, bounds, pixels);
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
/** Crops a document-sized buffer to exactly `rect` — the copy loop `trimToContent` and
 *  `setLayerPixels`'s own add-only fast path (§32.6, below) both need, kept in one place so
 *  an edge-clamping mistake only needs fixing once. */
function cropToRect(pixels: Uint8ClampedArray, documentWidth: number, rect: RasterRect): Uint8ClampedArray {
  const cropped = new Uint8ClampedArray(rect.width * rect.height * 4);
  for (let y = 0; y < rect.height; y += 1) {
    const from = ((rect.y + y) * documentWidth + rect.x) * 4;
    cropped.set(pixels.subarray(from, from + rect.width * 4), y * rect.width * 4);
  }
  return cropped;
}

export function trimToContent(pixels: Uint8ClampedArray, documentWidth: number, documentHeight: number): { bounds: RasterRect; pixels: Uint8ClampedArray } {
  const bounds = opaqueBoundsOf(pixels, documentWidth, documentHeight) ?? { x: 0, y: 0, width: 1, height: 1 };
  return { bounds, pixels: cropToRect(pixels, documentWidth, bounds) };
}

/**
 * A layer's pixels laid out in an arbitrary rectangle of document space — the document-sized
 * `layerDocumentPixels`, but for a frame that may reach past the canvas.
 *
 * A transform whose result lands partly outside the document has to be computed somewhere that
 * can hold it; the engine's own transforms (`transformLayerPixels`, `stampFloating`, …) take any
 * width/height, so handing them this frame instead of the canvas is all it takes. Pixel layers
 * only — a Smart Object's placement is transformed without sampling and never comes here.
 */
export function layerFramePixels(layer: RasterLayer, frame: RasterRect): Uint8ClampedArray {
  const output = new Uint8ClampedArray(frame.width * frame.height * 4);
  const bounds = layer.bounds;
  const left = Math.max(frame.x, bounds.x), top = Math.max(frame.y, bounds.y);
  const right = Math.min(frame.x + frame.width, bounds.x + bounds.width), bottom = Math.min(frame.y + frame.height, bounds.y + bounds.height);
  if (right <= left || bottom <= top) return output;
  const source = layerPixelsView(layer), rowBytes = (right - left) * 4;
  for (let y = top; y < bottom; y += 1) {
    const from = ((y - bounds.y) * bounds.width + (left - bounds.x)) * 4;
    output.set(source.subarray(from, from + rowBytes), ((y - frame.y) * frame.width + (left - frame.x)) * 4);
  }
  return output;
}

/** A document-sized buffer (`channels` per pixel) placed into `frame`, zero outside the document. */
export function documentToFrame(pixels: Uint8ClampedArray, documentWidth: number, documentHeight: number, frame: RasterRect, channels = 4): Uint8ClampedArray {
  const output = new Uint8ClampedArray(frame.width * frame.height * channels);
  const left = Math.max(0, frame.x), top = Math.max(0, frame.y);
  const right = Math.min(documentWidth, frame.x + frame.width), bottom = Math.min(documentHeight, frame.y + frame.height);
  const rowBytes = (right - left) * channels;
  if (rowBytes <= 0) return output;
  for (let y = top; y < bottom; y += 1) {
    const from = (y * documentWidth + left) * channels;
    output.set(pixels.subarray(from, from + rowBytes), ((y - frame.y) * frame.width + (left - frame.x)) * channels);
  }
  return output;
}

/** Stores a buffer laid out in `frame` on a layer, trimmed to what it holds — `setLayerPixels`
 * for a result that was computed outside the canvas's bounds rather than inside them. */
/**
 * The depth a layer's own storage is in, so that rebuilding it never silently demotes it.
 *
 * Every function below replaces `layer.tiles` wholesale (that is how a bounds change works — see
 * `setLayerPixels`), and a plain `TileStore.fromPixels(pixels8, ...)` would hand back an 8-bit
 * store no matter what the layer was. That is the quiet kind of wrong CLAUDE.md §4 is about: the
 * picture would look identical and the document would have lost its precision (master-plan §59.2).
 */
const layerDepth = (layer: RasterLayer): RasterBitDepth => layer.tiles?.depth ?? 8;

export function setLayerFramePixels(layer: RasterLayer, pixels: Uint8ClampedArray, frame: RasterRect): void {
  const inner = opaqueBoundsOf(pixels, frame.width, frame.height) ?? { x: 0, y: 0, width: 1, height: 1 };
  layer.bounds = { x: frame.x + inner.x, y: frame.y + inner.y, width: inner.width, height: inner.height };
  layer.width = inner.width;
  layer.height = inner.height;
  layer.tiles = TileStore.fromPixels(cropToRect(pixels, frame.width, inner), inner.width, inner.height, 4, layerDepth(layer));
  layer.pixelsRevision += 1;
}

export interface SetLayerPixelsOptions {
  /**
   * The buffer is an *edit* of the layer, not a replacement for it: keep whatever the layer holds
   * outside the document untouched.
   *
   * A layer's own buffer can reach past the canvas — Crop with "Delete Cropped Pixels" off, a
   * move that drags content over an edge — and that is Photoshop's and GIMP's model too: a
   * drawable is not the image, and painting on it never trims it to the image. A document-sized
   * buffer cannot represent those pixels at all, so without this every brush stroke, fill or
   * filter on such a layer silently deleted them.
   *
   * Only for edits. A caller that *regenerates* the layer from a description (a text or 3D layer
   * re-rendered, a merge result, a freshly created layer) must leave this off, or the previous
   * render's off-canvas part would stay behind next to the new one.
   */
  readonly keepOutsideDocument?: boolean;
}

function reachesOutsideDocument(layer: RasterLayer, documentWidth: number, documentHeight: number): boolean {
  const { bounds } = layer;
  if (smartObjectTransform(layer) || layer.tiles.evicted) return false;
  return bounds.x < 0 || bounds.y < 0 || bounds.x + bounds.width > documentWidth || bounds.y + bounds.height > documentHeight;
}

/**
 * Writes the document-space part of `pixels` into a layer whose buffer extends past the document,
 * leaving every pixel outside the document as it was — the same grow/write/trim a GIMP undo swap
 * does (`swapLayerRegion`), which never needed a document-sized frame either.
 */
function writeInsideDocument(layer: RasterLayer, pixels: Uint8ClampedArray, documentWidth: number, documentHeight: number, edit: { bounds: RasterRect; canShrink: boolean } | null): void {
  const hinted = edit && !edit.canShrink ? edit.bounds : { x: 0, y: 0, width: documentWidth, height: documentHeight };
  const left = Math.max(0, Math.floor(hinted.x)), top = Math.max(0, Math.floor(hinted.y));
  const right = Math.min(documentWidth, Math.ceil(hinted.x + hinted.width)), bottom = Math.min(documentHeight, Math.ceil(hinted.y + hinted.height));
  if (right <= left || bottom <= top) return;
  const region: RasterRect = { x: left, y: top, width: right - left, height: bottom - top };

  const old = layer.bounds;
  const frameLeft = Math.min(old.x, region.x), frameTop = Math.min(old.y, region.y);
  const frameRight = Math.max(old.x + old.width, region.x + region.width), frameBottom = Math.max(old.y + old.height, region.y + region.height);
  const frame: RasterRect = { x: frameLeft, y: frameTop, width: frameRight - frameLeft, height: frameBottom - frameTop };
  // `reframe` returns a new store, so the write below never reaches tiles a history snapshot or a
  // duplicated layer still shares with the old one.
  let tiles = layer.tiles.reframe(frame.x - old.x, frame.y - old.y, frame.width, frame.height);
  tiles.writeLocalRegion({ x: region.x - frame.x, y: region.y - frame.y, width: region.width, height: region.height }, cropToRect(pixels, documentWidth, region));

  let bounds = frame;
  if (!edit || edit.canShrink) {
    // The edit may have erased what used to hold the layer's extent in place.
    const inner = opaqueBoundsOf(tiles.toPixels(), frame.width, frame.height) ?? { x: 0, y: 0, width: 1, height: 1 };
    if (inner.x !== 0 || inner.y !== 0 || inner.width !== frame.width || inner.height !== frame.height) {
      tiles = tiles.reframe(inner.x, inner.y, inner.width, inner.height);
      bounds = { x: frame.x + inner.x, y: frame.y + inner.y, width: inner.width, height: inner.height };
    }
  }
  layer.bounds = bounds;
  layer.width = bounds.width;
  layer.height = bounds.height;
  layer.tiles = tiles;
  layer.pixelsRevision += 1;
}

/**
 * Stores a document-sized result on a layer, trimmed to what it holds.
 *
 * `edit`, when given, is docs/master-plan.md §32.6's fast path: the caller is promising the
 * edit rectangle it names only ever *added* opaque pixels (`canShrink: false`) — Krita's own
 * `exactBoundsAmortized` makes the identical trade for the identical reason (a full scan on
 * every stroke release is too slow to pay for a bound this cheap to estimate instead: "могут
 * быть слишком медленным ... `extent()` — объединение затронутых тайлов"). The new bounds
 * are then just the old ones grown to cover the edit rectangle, no pixels read at all; a few
 * always-transparent pixels can end up inside that box at its own edges (a round dab inside
 * its own square bounding rect, say), which costs nothing and breaks nothing — the
 * buffer-length/bounds invariant (CLAUDE.md §4) holds exactly either way, since the returned
 * buffer is always cropped to match the returned bounds precisely. Anything that can shrink
 * the layer (the eraser, `clear`, a transparent fill, `canShrink: true`, or simply no `edit`
 * at all) still takes the scanning path below.
 */
export function setLayerPixels(
  layer: RasterLayer, pixels: Uint8ClampedArray, documentWidth: number, documentHeight: number,
  edit?: { bounds: RasterRect; canShrink: boolean } | null, options?: SetLayerPixelsOptions,
): void {
  if (options?.keepOutsideDocument && reachesOutsideDocument(layer, documentWidth, documentHeight)) {
    writeInsideDocument(layer, pixels, documentWidth, documentHeight, edit ?? null);
    return;
  }
  if (edit && !edit.canShrink) {
    const target = edit.bounds;
    const grown = unionRect(layer.bounds, target.x, target.y, target.x + target.width, target.y + target.height, 0);
    const left = Math.max(0, Math.floor(grown.x));
    const top = Math.max(0, Math.floor(grown.y));
    const width = Math.max(0, Math.min(documentWidth, Math.ceil(grown.x + grown.width)) - left);
    const height = Math.max(0, Math.min(documentHeight, Math.ceil(grown.y + grown.height)) - top);
    if (width > 0 && height > 0) {
      const bounds: RasterRect = { x: left, y: top, width, height };
      layer.bounds = bounds;
      layer.width = width;
      layer.height = height;
      layer.tiles = TileStore.fromPixels(cropToRect(pixels, documentWidth, bounds), width, height, 4, layerDepth(layer));
      layer.pixelsRevision += 1;
      return;
    }
    // The grown rectangle collapsed (documentWidth/Height of 0, or an edit rect entirely
    // outside the document) — falls through to the scan below rather than leaving the layer
    // in a state the invariant above doesn't hold for.
  }
  const { bounds, pixels: trimmed } = trimToContent(pixels, documentWidth, documentHeight);
  layer.bounds = bounds;
  layer.width = bounds.width;
  layer.height = bounds.height;
  layer.tiles = TileStore.fromPixels(trimmed, bounds.width, bounds.height, 4, layerDepth(layer));
  layer.pixelsRevision += 1;
}

/** Assigns an already-local raster surface without materialising document
 * space. Used by round-trip assets, whose header carries exactly these local
 * dimensions while the layer itself owns the document-space origin. */
export function setLayerLocalPixels(layer: RasterLayer, pixels: Uint8ClampedArray, bounds: RasterRect): void {
  if (!Number.isInteger(bounds.width) || !Number.isInteger(bounds.height) || bounds.width < 1 || bounds.height < 1) throw new RangeError("Local layer dimensions must be positive integers");
  if (pixels.length !== bounds.width * bounds.height * 4) throw new RangeError("Local layer pixels do not match bounds");
  layer.bounds = { ...bounds };
  layer.width = bounds.width;
  layer.height = bounds.height;
  layer.tiles = TileStore.fromPixels(pixels, bounds.width, bounds.height, 4, layerDepth(layer));
  layer.pixelsRevision += 1;
}

/** Reads one pixel's alpha in document coordinates, without materialising. */
export function layerAlphaAt(layer: RasterLayer, x: number, y: number): number {
  const placement = smartObjectTransform(layer);
  if (placement) {
    const determinant = placement.a * placement.d - placement.b * placement.c;
    if (Math.abs(determinant) <= 1e-8) return 0;
    const dx = x + .5 - placement.e, dy = y + .5 - placement.f;
    const localX = Math.floor((placement.d * dx - placement.c * dy) / determinant), localY = Math.floor((-placement.b * dx + placement.a * dy) / determinant);
    return localX < 0 || localY < 0 || localX >= layer.width || localY >= layer.height ? 0 : layer.tiles.readPixel(localX, localY)[3] ?? 0;
  }
  const { bounds } = layer;
  const localX = x - bounds.x, localY = y - bounds.y;
  if (localX < 0 || localY < 0 || localX >= bounds.width || localY >= bounds.height) return 0;
  return layer.tiles.readPixel(localX, localY)[3] ?? 0;
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
    for (const tile of layer.tiles.tileBuffers()) visit(tile);
    // A mask's tiles partition its content with no overlap, so visiting each one individually
    // still totals the same bytes `visit(mask.pixels)` used to in one call — and now correctly
    // prices a duplicate mask that shares most of its tiles with its source as mostly-free,
    // rather than either double-counting or (as the old whole-buffer version did) only getting
    // that right when the whole buffer happened to be the same shared reference.
    if (layer.mask) for (const tile of layer.mask.tiles.tileBuffers()) visit(tile);
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
