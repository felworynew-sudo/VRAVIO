import { layerDocumentPixels } from "./layer-bounds";
import { bilinearSample, sampleBilinearInto, type BilinearSample } from "./sampling";
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

/**
 * One RGBA sample, interpolated between the four pixels around a fractional
 * position.
 *
 * Every warp in this file used to take the nearest pixel instead, which is what
 * master-plan.md §1.1 reports as "пиксели не интерполируются": a deformation built
 * from nearest samples reproduces the source's own values in blocks, and reads
 * as a picture torn into tiles rather than bent.
 *
 * Mixed premultiplied and divided back out, so a sample taken beside a
 * transparent pixel does not drag that pixel's meaningless colour into the
 * result — the dark fringe that otherwise appears along every warped edge.
 */
/** Remaps sourceBounds into an arbitrary quadrilateral (TL,TR,BR,BL) instead of scaleLayerPixels'
 * axis-aligned rectangle — the shared engine behind Skew (a parallelogram), Distort (a free
 * quad) and Perspective (a quad the caller keeps trapezoidal by mirroring corner drags), which
 * differ only in how their on-canvas handles are allowed to move, not in how pixels are sampled. */
export function quadLayerPixels(pixels: Uint8ClampedArray, width: number, height: number, sourceBounds: RasterRect, corners: readonly [Point, Point, Point, Point], selection: PixelSelection | null = null): Uint8ClampedArray {
  // One clone: `output` is the only buffer written, so the caller's own array is already
  // the pristine source. Cloning it a second time cost a full document copy per frame of a drag.
  const output = pixels.slice(), source = pixels;
  const sample: BilinearSample = bilinearSample();
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
    // Sampled at the pixel's centre and interpolated: the -0.5 turns a pixel
    // index into the coordinate of its centre, which is the space the mapping
    // works in.
    const sampleX = sourceBounds.x + u * sourceBounds.width - 0.5;
    const sampleY = sourceBounds.y + v * sourceBounds.height - 0.5;
    const nearestX = Math.max(left, Math.min(right - 1, Math.round(sampleX)));
    const nearestY = Math.max(top, Math.min(bottom - 1, Math.round(sampleY)));
    // The mask is read at the nearest pixel rather than interpolated: it says
    // which pixels are the caller's to take, and half of that answer is not a
    // meaningful thing to act on.
    const maskAlpha = selectedAlpha(nearestY * width + nearestX); if (maskAlpha <= 0) continue;
    sampleBilinearInto(source, width, height, sampleX, sampleY, sample);
    const to = (y * width + x) * 4, sourceAlpha = sample.a / 255 * maskAlpha, destinationAlpha = output[to + 3]! / 255, alpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
    if (alpha <= 0) continue;
    output[to] = Math.round((sample.r * sourceAlpha + output[to]! * destinationAlpha * (1 - sourceAlpha)) / alpha);
    output[to + 1] = Math.round((sample.g * sourceAlpha + output[to + 1]! * destinationAlpha * (1 - sourceAlpha)) / alpha);
    output[to + 2] = Math.round((sample.b * sourceAlpha + output[to + 2]! * destinationAlpha * (1 - sourceAlpha)) / alpha);
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
  // One clone: `output` is the only buffer written, so the caller's own array is already
  // the pristine source. Cloning it a second time cost a full document copy per frame of a drag.
  const output = pixels.slice(), source = pixels;
  const sample: BilinearSample = bilinearSample();
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

/**
 * One scale-and-rotate, resampled once.
 *
 * A Free Transform is a whole session: the hand scales, lets go, rotates, lets go, nudges a
 * corner again. Applying each of those to the *previous result* costs a resample per gesture and
 * — far worse — compounds the interpolation. Measured on a hard checker, one 90° turn leaves the
 * picture pixel-crisp while ten 9° turns to the same place muddy 28,518 pixels and spend 117ms
 * doing it. That is the same fault CLAUDE.md already records for the warp mesh ("a warp that
 * resamples its own output smears"), one level up.
 *
 * So the tool keeps the *description* of the whole session and calls this once, at commit —
 * which is exactly what the donors do. GIMP's transform tool holds `trans_infos` and recomputes
 * a matrix all session; the only call to `gimp_transform_tool_transform`, the function that
 * actually touches pixels, is inside `gimp_transform_grid_tool_commit`. Photoshop and Krita
 * likewise apply on Enter.
 *
 * `source` maps onto `target`, and then the result is turned by `degrees` about `target`'s
 * centre — the order the frame itself implies. One inverse map per destination pixel, one
 * bilinear read.
 */
export function transformLayerPixels(
  pixels: Uint8ClampedArray, width: number, height: number,
  source: RasterRect, target: RasterRect, degrees: number,
  selection: PixelSelection | null = null, interpolate = true,
): Uint8ClampedArray {
  const output = pixels.slice();
  const sample: BilinearSample = bilinearSample();
  const radians = degrees * Math.PI / 180, cosine = Math.cos(radians), sine = Math.sin(radians);
  const centerX = target.x + target.width / 2, centerY = target.y + target.height / 2;
  const scaleX = target.width === 0 ? 0 : source.width / target.width;
  const scaleY = target.height === 0 ? 0 : source.height / target.height;

  const insideSource = (x: number, y: number) => x >= source.x && x < source.x + source.width && y >= source.y && y < source.y + source.height;
  const coverage = (x: number, y: number) => x < 0 || x >= width || y < 0 || y >= height ? 0
    : selection ? selection.mask[y * width + x]! / 255
    : (insideSource(x, y) ? 1 : 0);

  // The source rectangle is vacated once, before anything is drawn — the same cut-one-hole rule
  // the rest of this file follows, and the reason a transform cannot smear over its own origin.
  for (let y = Math.max(0, Math.floor(source.y)); y < Math.min(height, Math.ceil(source.y + source.height)); y += 1) {
    for (let x = Math.max(0, Math.floor(source.x)); x < Math.min(width, Math.ceil(source.x + source.width)); x += 1) {
      const alpha = coverage(x, y); if (alpha <= 0) continue;
      const pixel = (y * width + x) * 4, remaining = 1 - alpha;
      output[pixel] = Math.round(output[pixel]! * remaining); output[pixel + 1] = Math.round(output[pixel + 1]! * remaining);
      output[pixel + 2] = Math.round(output[pixel + 2]! * remaining); output[pixel + 3] = Math.round(output[pixel + 3]! * remaining);
    }
  }

  const destination = rotatedDestinationBounds(target, degrees);
  const fromY = Math.max(0, Math.floor(destination.y) - 1), toY = Math.min(height, Math.ceil(destination.y + destination.height) + 1);
  const fromX = Math.max(0, Math.floor(destination.x) - 1), toX = Math.min(width, Math.ceil(destination.x + destination.width) + 1);
  for (let y = fromY; y < toY; y += 1) {
    for (let x = fromX; x < toX; x += 1) {
      // Undo the rotation about the target's centre, then undo the scale that carried the source
      // rectangle onto the target — the inverse of the two steps, in the other order.
      const dx = x + .5 - centerX, dy = y + .5 - centerY;
      const unrotatedX = centerX + cosine * dx + sine * dy, unrotatedY = centerY - sine * dx + cosine * dy;
      const sampleX = source.x + (unrotatedX - target.x) * scaleX;
      const sampleY = source.y + (unrotatedY - target.y) * scaleY;
      const nearestX = Math.floor(sampleX), nearestY = Math.floor(sampleY);
      const maskAlpha = coverage(nearestX, nearestY); if (maskAlpha <= 0) continue;
      if (interpolate) {
        sampleBilinearInto(pixels, width, height, sampleX - .5, sampleY - .5, sample);
      } else {
        const at = (Math.max(0, Math.min(height - 1, nearestY)) * width + Math.max(0, Math.min(width - 1, nearestX))) * 4;
        sample.r = pixels[at]!; sample.g = pixels[at + 1]!; sample.b = pixels[at + 2]!; sample.a = pixels[at + 3]!;
      }
      const to = (y * width + x) * 4, sourceAlpha = sample.a / 255 * maskAlpha, destinationAlpha = output[to + 3]! / 255;
      const alpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha); if (alpha <= 0) continue;
      output[to] = Math.round((sample.r * sourceAlpha + output[to]! * destinationAlpha * (1 - sourceAlpha)) / alpha);
      output[to + 1] = Math.round((sample.g * sourceAlpha + output[to + 1]! * destinationAlpha * (1 - sourceAlpha)) / alpha);
      output[to + 2] = Math.round((sample.b * sourceAlpha + output[to + 2]! * destinationAlpha * (1 - sourceAlpha)) / alpha);
      output[to + 3] = Math.round(alpha * 255);
    }
  }
  return output;
}
/**
 * Where a rotation of `bounds` can put pixels — the four corners turned about the centre, as a
 * box. Exported because the caller needs the same rectangle to tell the screen what to repaint,
 * and two spellings of it are two chances to repaint the wrong band.
 */
export function rotatedDestinationBounds(bounds: RasterRect, degrees: number): RasterRect {
  const radians = degrees * Math.PI / 180, cosine = Math.cos(radians), sine = Math.sin(radians);
  const centerX = bounds.x + bounds.width / 2, centerY = bounds.y + bounds.height / 2;
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const cx of [bounds.x, bounds.x + bounds.width]) for (const cy of [bounds.y, bounds.y + bounds.height]) {
    const dx = cx - centerX, dy = cy - centerY;
    const rx = centerX + cosine * dx - sine * dy, ry = centerY + sine * dx + cosine * dy;
    if (rx < left) left = rx;
    if (rx > right) right = rx;
    if (ry < top) top = ry;
    if (ry > bottom) bottom = ry;
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * Rotates the layer's content about the centre of `bounds`.
 *
 * `interpolate` is the donor's own split between a preview and a result: Krita calls it Instant
 * Preview and shows a cheap approximation while the hand is moving, computing the accurate one
 * once the gesture ends; GIMP and Photoshop likewise transform the already-rendered layer during
 * the drag rather than resampling it per frame. Measured here, bilinear costs about twice
 * nearest-neighbour on a large layer — worth paying once on release, not thirty times a second.
 */
export function rotateLayerPixels(pixels: Uint8ClampedArray, width: number, height: number, bounds: RasterRect, degrees: number, selection: PixelSelection | null = null, interpolate = true): Uint8ClampedArray {
  const sample: BilinearSample = bilinearSample();
  const output = pixels.slice(), source = pixels.slice(), radians = degrees * Math.PI / 180, cosine = Math.cos(radians), sine = Math.sin(radians), centerX = bounds.x + bounds.width / 2, centerY = bounds.y + bounds.height / 2;
  const selectedAlpha = (x: number, y: number) => x < 0 || x >= width || y < 0 || y >= height ? 0 : selection ? selection.mask[y * width + x]! / 255 : (x >= bounds.x && x < bounds.x + bounds.width && y >= bounds.y && y < bounds.y + bounds.height ? 1 : 0);
  for (let y = Math.max(0, Math.floor(bounds.y)); y < Math.min(height, Math.ceil(bounds.y + bounds.height)); y += 1) for (let x = Math.max(0, Math.floor(bounds.x)); x < Math.min(width, Math.ceil(bounds.x + bounds.width)); x += 1) {
    const alpha = selectedAlpha(x, y); if (alpha <= 0) continue; const pixel = (y * width + x) * 4, remaining = 1 - alpha;
    output[pixel] = Math.round(output[pixel]! * remaining); output[pixel + 1] = Math.round(output[pixel + 1]! * remaining); output[pixel + 2] = Math.round(output[pixel + 2]! * remaining); output[pixel + 3] = Math.round(output[pixel + 3]! * remaining);
  }
  // Only where the rotated rectangle can actually land. This used to walk the *whole document*
  // on every frame of a drag, which is why rotating a 200x200 layer cost 19ms on a 1920x1080
  // canvas and 85ms on a 4000x3000 one: the price followed the canvas, not the layer. Its own
  // clearing loop above always had the right idea, and `scaleLayerPixels`/`quadLayerPixels` next
  // door both bound their destination loops the same way — rotate was the one that did not.
  const destination = rotatedDestinationBounds(bounds, degrees);
  const fromY = Math.max(0, Math.floor(destination.y) - 1), toY = Math.min(height, Math.ceil(destination.y + destination.height) + 1);
  const fromX = Math.max(0, Math.floor(destination.x) - 1), toX = Math.min(width, Math.ceil(destination.x + destination.width) + 1);
  for (let y = fromY; y < toY; y += 1) for (let x = fromX; x < toX; x += 1) {
    const dx = x + .5 - centerX, dy = y + .5 - centerY;
    const sampleX = centerX + cosine * dx + sine * dy, sampleY = centerY - sine * dx + cosine * dy;
    const nearestX = Math.floor(sampleX), nearestY = Math.floor(sampleY);
    const maskAlpha = selectedAlpha(nearestX, nearestY); if (maskAlpha <= 0) continue;
    // Interpolated on the accurate pass, like every other transform here — rotation alone used to
    // take the nearest pixel always, so a turned layer came out visibly stepped while the same
    // layer skewed or warped did not.
    if (interpolate) {
      sampleBilinearInto(source, width, height, sampleX - .5, sampleY - .5, sample);
    } else {
      const at = (Math.max(0, Math.min(height - 1, nearestY)) * width + Math.max(0, Math.min(width - 1, nearestX))) * 4;
      sample.r = source[at]!; sample.g = source[at + 1]!; sample.b = source[at + 2]!; sample.a = source[at + 3]!;
    }
    const to = (y * width + x) * 4, sourceAlpha = sample.a / 255 * maskAlpha, destinationAlpha = output[to + 3]! / 255, alpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha); if (alpha <= 0) continue;
    output[to] = Math.round((sample.r * sourceAlpha + output[to]! * destinationAlpha * (1 - sourceAlpha)) / alpha); output[to + 1] = Math.round((sample.g * sourceAlpha + output[to + 1]! * destinationAlpha * (1 - sourceAlpha)) / alpha); output[to + 2] = Math.round((sample.b * sourceAlpha + output[to + 2]! * destinationAlpha * (1 - sourceAlpha)) / alpha); output[to + 3] = Math.round(alpha * 255);
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

/**
 * Crops a document-sized single-channel (grayscale) buffer to a rectangle at
 * the document's own stride — the shared arithmetic {@link cropRasterDocument}
 * uses for both the selection mask and every layer's mask, since a layer
 * mask has no bounds of its own (`RasterLayerMask` — always exactly
 * document-sized, see types.ts's own comment on the field).
 */
function cropChannel(pixels: Uint8ClampedArray, sourceWidth: number, left: number, top: number, width: number, height: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y += 1) out.set(pixels.subarray((top + y) * sourceWidth + left, (top + y) * sourceWidth + left + width), y * width);
  return out;
}

/**
 * Slides a layer's own buffer into the new canvas's coordinate space without
 * touching its pixels, for the `deleteCroppedPixels: false` path below —
 * *except* on whichever of the left/top edges the shift would carry past
 * zero. Every other bounds-producing path in this codebase (`trimToContent`,
 * which `setLayerPixels`/every ordinary layer edit goes through) derives
 * `bounds` from a full canvas-sized buffer, so a negative `bounds.x`/`y` has
 * never been a representable state anywhere else — `layerDocumentPixels`
 * indexes `(documentY * documentWidth + bounds.x) * 4` directly into the
 * destination array, and a negative `bounds.x` makes that a negative offset,
 * which throws ("offset is out of bounds") the moment anything tries to
 * composite the layer. Found by driving this live, not by reasoning about
 * the invariant in the abstract: crop-then-Enter on an ordinary full-canvas
 * layer crashed the whole app the first time this shipped with unclamped
 * `x - left`/`y - top`.
 *
 * So a layer's content that falls into the cropped-away region on the
 * left/top is genuinely lost (this codebase has no way to remember "pixels
 * that used to be off-canvas to the left/top" — a real, smaller gap than
 * Photoshop's own Non-destructive Crop, tracked in docs/master-plan.md
 * §2.1). Content overhanging the new canvas's right/bottom edge is fully
 * preserved: `bounds.x >= 0` with `bounds.width` extending past
 * `documentWidth - bounds.x` is already the ordinary, already-supported
 * case `layerDocumentPixels` clips to what's visible without touching the
 * stored buffer.
 */
function slideLayerBounds<T extends { bounds: RasterRect; width: number; height: number; pixels: Uint8ClampedArray }>(layer: T, left: number, top: number): Pick<T, "bounds" | "width" | "height" | "pixels"> {
  const shiftedX = layer.bounds.x - left, shiftedY = layer.bounds.y - top;
  const dropLeft = Math.max(0, -shiftedX), dropTop = Math.max(0, -shiftedY);
  if (dropLeft === 0 && dropTop === 0) return { bounds: { ...layer.bounds, x: shiftedX, y: shiftedY }, width: layer.width, height: layer.height, pixels: layer.pixels };
  const width = layer.bounds.width - dropLeft, height = layer.bounds.height - dropTop;
  if (width <= 0 || height <= 0) return { bounds: { x: 0, y: 0, width: 1, height: 1 }, width: 1, height: 1, pixels: new Uint8ClampedArray(4) };
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const from = ((y + dropTop) * layer.bounds.width + dropLeft) * 4;
    pixels.set(layer.pixels.subarray(from, from + width * 4), y * width * 4);
  }
  return { bounds: { x: Math.max(0, shiftedX), y: Math.max(0, shiftedY), width, height }, width, height, pixels };
}

/**
 * `deleteCroppedPixels` (Photoshop's own name for the option, default
 * `false` to match Photoshop's own default): `true` trims every layer's own
 * pixel buffer to the crop rectangle, discarding anything outside it —
 * `false` keeps as much of each layer's own buffer intact as `bounds`' own
 * never-negative invariant allows (see {@link slideLayerBounds}), so content
 * overhanging the crop is still there if the canvas is grown back later. A
 * layer mask has no bounds of its own to slide — see {@link cropChannel}'s
 * comment — so it is always physically cropped either way; only a layer's
 * own `pixels`/`bounds` follow the toggle.
 */
export function cropRasterDocument(state: RasterDocumentState, crop: RasterRect, deleteCroppedPixels = false): RasterDocumentState {
  const left = Math.max(0, Math.min(state.width - 1, Math.floor(crop.x))), top = Math.max(0, Math.min(state.height - 1, Math.floor(crop.y)));
  const right = Math.max(left + 1, Math.min(state.width, Math.ceil(crop.x + crop.width))), bottom = Math.max(top + 1, Math.min(state.height, Math.ceil(crop.y + crop.height)));
  const width = right - left, height = bottom - top;
  const layers = state.layers.map((layer) => {
    const maskPatch = layer.mask ? { mask: { ...layer.mask, pixels: cropChannel(layer.mask.pixels, state.width, left, top, width, height) } } : {};
    if (!deleteCroppedPixels) return { ...layer, ...maskPatch, ...slideLayerBounds(layer, left, top) };
    // Read in canvas space: a layer is stored at the size of its content, so
    // its own buffer cannot be indexed by the document's stride.
    const canvas = layerDocumentPixels(layer, state.width, state.height);
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      const source = ((top + y) * state.width + left) * 4;
      pixels.set(canvas.subarray(source, source + width * 4), y * width * 4);
    }
    return { ...layer, ...maskPatch, bounds: { x: 0, y: 0, width, height }, width, height, pixels };
  });
  let selection: PixelSelection | null = null;
  if (state.selection) {
    const mask = cropChannel(state.selection.mask, state.width, left, top, width, height);
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
 * The pixels a layer is left with once the selection's contents are removed —
 * Delete, and the deleting half of Cut.
 *
 * Deliberately `liftSelection`'s own result rather than a second copy of the
 * same arithmetic: what a clear removes has to be exactly what a move takes,
 * coverage for coverage, or a feathered edge would delete differently depending
 * on which of the two the user reached for. The float's content buffer is
 * discarded here, which costs one document-sized allocation on a keypress and
 * buys the guarantee that the two can never drift apart.
 *
 * A null selection clears the whole layer, which is what the no-selection case
 * means everywhere else in this file too.
 */
export function clearSelectedPixels(
  pixels: Uint8ClampedArray, width: number, height: number, selection: PixelSelection | null,
): Uint8ClampedArray {
  return liftSelection(pixels, width, height, selection).base;
}

/**
 * Blends a layer mask's single-channel value toward `target` over a
 * selection (or the whole mask, with none active) — the mask equivalent of
 * `fillSelectedPixels` (fill.ts), which does the same per-channel lerp for a
 * layer's RGBA. One door for "paint this value here, this much" on a mask,
 * whether the caller is a hotkey punching a hole (`punchSelectionIntoMask`
 * below), Alt/Ctrl+Backspace filling white or black while editing a mask, or
 * the Fill dialog's own opacity slider scaling how far it goes.
 */
export function fillSelectionInMask(
  pixels: Uint8ClampedArray, width: number, height: number,
  selection: PixelSelection | null, target: number, opacity = 1,
): Uint8ClampedArray {
  const result = pixels.slice();
  const strength = Math.max(0, Math.min(1, opacity));
  if (strength <= 0) return result;
  for (let index = 0; index < width * height; index += 1) {
    const coverage = (selection ? selection.mask[index]! / 255 : 1) * strength;
    if (coverage <= 0) continue;
    result[index] = Math.round(result[index]! + (target - result[index]!) * coverage);
  }
  return result;
}

/**
 * Punches a hole in a layer mask over the active selection — Delete/Backspace
 * while editing a mask, with a selection active. Photoshop paints the
 * selection black on the mask (hides it) rather than deleting the mask
 * itself.
 *
 * A null selection is not this function's business — the caller (Delete
 * without a selection, mask "selected" via its thumbnail) removes the whole
 * mask instead, same as `clearSelectedPixels` would clear a whole layer.
 */
export function punchSelectionIntoMask(
  pixels: Uint8ClampedArray, width: number, height: number, selection: PixelSelection,
): Uint8ClampedArray {
  return fillSelectionInMask(pixels, width, height, selection, 0);
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

/** Photoshop's default Warp grid: 3x3 cells, so 4x4 draggable anchor points, row-major. */
export const WARP_GRID = 3;

/** The undistorted 4x4 anchor grid a warp always resamples from — fixed for the life of one
 * Warp session (the caller's own pending-transform state carries the fixed base bounds this is
 * built from), regardless of how far any point has since been dragged. */
export function regularMesh(bounds: RasterRect, gridSize: number): Point[] {
  const points: Point[] = [];
  for (let row = 0; row <= gridSize; row += 1) for (let col = 0; col <= gridSize; col += 1) {
    points.push({ x: bounds.x + (bounds.width * col) / gridSize, y: bounds.y + (bounds.height * row) / gridSize });
  }
  return points;
}

/**
 * Warps basePixels by treating the mesh as a grid of independent quads, each resampled from its
 * own undistorted rectangle of baseBounds via quadLayerPixels — the same engine Skew, Distort and
 * Perspective use, just tiled. Every cell reads from the SAME fixed original pixels (chained
 * through `output` only so later cells composite over earlier ones, never so a cell resamples
 * another cell's already-resampled pixels), which is what keeps a multi-point drag from
 * accumulating resampling blur cell over cell.
 */
/** Bernstein weights of the cubic basis — the donor's own `bernstein_weights`
 * for order 4 (Patchy, core/warp_mesh.cpp). */
function bernstein3(t: number): [number, number, number, number] {
  const s = 1 - t;
  return [s * s * s, 3 * s * s * t, 3 * s * t * t, t * t * t];
}

/**
 * Where the point at (u, v) of the original rectangle lands, for a warp mesh.
 *
 * The sixteen anchors are the **control points** of a bicubic Bézier patch, not
 * the corners of nine flat cells — which is what Photoshop's Warp is, what the
 * donor stores (`SmartObjectWarp`'s `u_order`/`v_order` are 4, evaluated by
 * `evaluate_warp_mesh` with exactly these weights), and the whole difference
 * between a picture that bends and one that folds. Read as cell corners, a
 * dragged anchor pulls its neighbouring cells into a tent with straight edges
 * and visible creases along every cell border; read as control points, the same
 * drag bulges the surface smoothly and the creases cannot exist, because there
 * is one surface rather than nine patches meeting at an angle.
 *
 * A mesh still sitting on its regular grid evaluates to the identity map:
 * evenly spaced control points make a cubic Bézier the linear function.
 */
export function evaluateWarpMesh(mesh: readonly Point[], u: number, v: number): Point {
  const wu = bernstein3(u), wv = bernstein3(v);
  let x = 0, y = 0;
  for (let row = 0; row < 4; row += 1) for (let col = 0; col < 4; col += 1) {
    const point = mesh[row * 4 + col];
    if (!point) continue;
    const weight = wu[col]! * wv[row]!;
    x += weight * point.x;
    y += weight * point.y;
  }
  return { x, y };
}

/** How finely the Bézier surface is diced before it is drawn. Each piece is
 * small enough to be treated as a flat quad without a visible kink, and 24 of
 * them per axis is well past the point where more stops being distinguishable
 * on a real layer. */
const WARP_SUBDIVISIONS = 24;

/** The destination quad and matching source rectangle of one diced piece. */
function warpPatch(mesh: readonly Point[], bounds: RasterRect, column: number, row: number) {
  const u0 = column / WARP_SUBDIVISIONS, u1 = (column + 1) / WARP_SUBDIVISIONS;
  const v0 = row / WARP_SUBDIVISIONS, v1 = (row + 1) / WARP_SUBDIVISIONS;
  const corners: [Point, Point, Point, Point] = [
    evaluateWarpMesh(mesh, u0, v0), evaluateWarpMesh(mesh, u1, v0),
    evaluateWarpMesh(mesh, u1, v1), evaluateWarpMesh(mesh, u0, v1),
  ];
  const source: RasterRect = {
    x: bounds.x + u0 * bounds.width, y: bounds.y + v0 * bounds.height,
    width: bounds.width / WARP_SUBDIVISIONS, height: bounds.height / WARP_SUBDIVISIONS,
  };
  return { corners, source };
}

/**
 * Warps a layer through the 4x4 anchor grid — the Warp transform.
 *
 * One pass over the destination, reading the *pristine* source every time. What
 * it replaces walked nine cells one at a time and handed each cell's own output
 * to the next as its input, so every cell after the first resampled a picture
 * the earlier ones had already resampled and partly cleared, and cells erased
 * their neighbours where their source rectangles overlapped.
 *
 * The surface is the donor's: a bicubic Bézier patch over the sixteen anchors
 * (see `evaluateWarpMesh`), diced into small quads that are flat enough to fill
 * by the same projective inverse a single quad transform uses.
 */
export function meshLayerPixels(basePixels: Uint8ClampedArray, width: number, height: number, baseBounds: RasterRect, mesh: readonly Point[], selection: PixelSelection | null): Uint8ClampedArray {
  const source = basePixels;
  const sample: BilinearSample = bilinearSample();
  const output = basePixels.slice();
  const left = Math.max(0, Math.floor(baseBounds.x)), top = Math.max(0, Math.floor(baseBounds.y));
  const right = Math.min(width, Math.ceil(baseBounds.x + baseBounds.width));
  const bottom = Math.min(height, Math.ceil(baseBounds.y + baseBounds.height));
  const selectedAlpha = (index: number) => selection
    ? selection.mask[index]! / 255
    : (index % width >= left && index % width < right && Math.floor(index / width) >= top && Math.floor(index / width) < bottom ? 1 : 0);

  // The warped area is vacated once, before anything is drawn — the same
  // cut-one-hole rule `liftSelection` follows, and the reason pieces can no
  // longer erase each other: clearing is not part of drawing one.
  for (let y = top; y < bottom; y += 1) for (let x = left; x < right; x += 1) {
    const index = y * width + x, coverage = selectedAlpha(index);
    if (coverage <= 0) continue;
    const pixel = index * 4, remaining = 1 - coverage;
    output[pixel] = Math.round(output[pixel]! * remaining);
    output[pixel + 1] = Math.round(output[pixel + 1]! * remaining);
    output[pixel + 2] = Math.round(output[pixel + 2]! * remaining);
    output[pixel + 3] = Math.round(output[pixel + 3]! * remaining);
  }

  for (let row = 0; row < WARP_SUBDIVISIONS; row += 1) for (let column = 0; column < WARP_SUBDIVISIONS; column += 1) {
    const { corners, source: cellSource } = warpPatch(mesh, baseBounds, column, row);
    const mapping = quadMapping(corners);
    const xs = corners.map((point) => point.x), ys = corners.map((point) => point.y);
    const cellLeft = Math.max(0, Math.floor(Math.min(...xs))), cellTop = Math.max(0, Math.floor(Math.min(...ys)));
    const cellRight = Math.min(width, Math.ceil(Math.max(...xs)) + 1), cellBottom = Math.min(height, Math.ceil(Math.max(...ys)) + 1);
    for (let y = cellTop; y < cellBottom; y += 1) for (let x = cellLeft; x < cellRight; x += 1) {
      const { u, v } = inverseUnitSquare(mapping, x + 0.5, y + 0.5);
      // A hair of tolerance, so the seam between two pieces is covered by one of
      // them rather than falling between both — 576 pieces means 576 seams, and a
      // gap on each would read as a grid drawn through the artwork.
      if (u < -0.002 || u > 1.002 || v < -0.002 || v > 1.002) continue;
      const cu = Math.max(0, Math.min(1, u)), cv = Math.max(0, Math.min(1, v));
      const sampleX = cellSource.x + cu * cellSource.width - 0.5;
      const sampleY = cellSource.y + cv * cellSource.height - 0.5;
      const nearestX = Math.max(left, Math.min(right - 1, Math.round(sampleX)));
      const nearestY = Math.max(top, Math.min(bottom - 1, Math.round(sampleY)));
      const maskAlpha = selectedAlpha(nearestY * width + nearestX);
      if (maskAlpha <= 0) continue;
      sampleBilinearInto(source, width, height, sampleX, sampleY, sample);
      const to = (y * width + x) * 4;
      const sourceAlpha = sample.a / 255 * maskAlpha;
      const destinationAlpha = output[to + 3]! / 255;
      const alpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
      if (alpha <= 0) continue;
      output[to] = Math.round((sample.r * sourceAlpha + output[to]! * destinationAlpha * (1 - sourceAlpha)) / alpha);
      output[to + 1] = Math.round((sample.g * sourceAlpha + output[to + 1]! * destinationAlpha * (1 - sourceAlpha)) / alpha);
      output[to + 2] = Math.round((sample.b * sourceAlpha + output[to + 2]! * destinationAlpha * (1 - sourceAlpha)) / alpha);
      output[to + 3] = Math.round(alpha * 255);
    }
  }
  return output;
}

/**
 * Selection counterpart of `meshLayerPixels`: the same Bézier surface, the same
 * dicing, one mask written in one pass. (It used to call `quadSelection` per
 * cell, each allocating a canvas-sized mask; at 576 pieces that is not a
 * refactor away from being unusable, it is a different algorithm.)
 */
export function meshSelection(selection: PixelSelection | null, width: number, height: number, baseBounds: RasterRect, mesh: readonly Point[]): PixelSelection | null {
  if (!selection) return null;
  const mask = new Uint8ClampedArray(width * height);
  for (let row = 0; row < WARP_SUBDIVISIONS; row += 1) for (let column = 0; column < WARP_SUBDIVISIONS; column += 1) {
    const { corners, source: cellSource } = warpPatch(mesh, baseBounds, column, row);
    const mapping = quadMapping(corners);
    const xs = corners.map((point) => point.x), ys = corners.map((point) => point.y);
    const cellLeft = Math.max(0, Math.floor(Math.min(...xs))), cellTop = Math.max(0, Math.floor(Math.min(...ys)));
    const cellRight = Math.min(width, Math.ceil(Math.max(...xs)) + 1), cellBottom = Math.min(height, Math.ceil(Math.max(...ys)) + 1);
    for (let y = cellTop; y < cellBottom; y += 1) for (let x = cellLeft; x < cellRight; x += 1) {
      const { u, v } = inverseUnitSquare(mapping, x + 0.5, y + 0.5);
      if (u < -0.002 || u > 1.002 || v < -0.002 || v > 1.002) continue;
      const cu = Math.max(0, Math.min(1, u)), cv = Math.max(0, Math.min(1, v));
      const sourceX = Math.max(0, Math.min(width - 1, Math.round(cellSource.x + cu * cellSource.width - 0.5)));
      const sourceY = Math.max(0, Math.min(height - 1, Math.round(cellSource.y + cv * cellSource.height - 0.5)));
      const coverage = selection.mask[sourceY * width + sourceX]!;
      const at = y * width + x;
      // Brighter wins where two pieces overlap on a seam, the same merge the
      // per-cell version used and for the same reason: a plain overwrite would
      // let the second piece punch a hole in the first.
      if (coverage > mask[at]!) mask[at] = coverage;
    }
  }
  const bounds = selectionBounds(mask, width, height);
  return bounds.width && bounds.height ? { mask, bounds } : null;
}


