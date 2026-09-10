import type { PixelSelection, Point, RasterRect } from "./types";

export type SelectionCombineMode = "replace" | "add" | "subtract" | "intersect" | "difference";

export function selectionBounds(mask: Uint8ClampedArray, width: number, height: number): RasterRect {
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    if (mask[y * width + x]! === 0) continue;
    left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
  }
  return right < left ? { x: 0, y: 0, width: 0, height: 0 } : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

/** One closed boundary of a selection, as the corners of a rectilinear loop. */
export interface SelectionOutlineLoop { readonly points: readonly Point[] }

/**
 * The selection's boundary, traced into closed loops.
 *
 * Ported from Patchy's `trace_mask_outlines` (core/mask_outline.cpp). What was
 * here before emitted one separate subpath per pixel edge — `M x y h1`,
 * `M x+1 y v1` and so on — which draws the same picture as long as the line is
 * solid, and breaks completely as soon as it is dashed: every subpath is one
 * document unit long and restarts the dash phase, so at any zoom below 400% each
 * fragment fell inside a single "on" dash and the marching ants came out as a
 * plain white line. (That is exactly what the owner reported: correct while
 * dragging, where the preview draws one honest rectangle, wrong the moment the
 * committed outline took over.) A dash pattern needs a path to run along, and a
 * marching offset needs it even more.
 *
 * The walk keeps selected pixels on its right: East along a top edge, South
 * along a right edge, West along a bottom edge, North along a left edge. At a
 * corner it tries a right turn first, then straight, then left — the saddle rule
 * that makes two diagonally touching regions hug their own pixel instead of
 * merging into one contour. A point is recorded only where the direction
 * changes, so a straight run of a thousand pixels is two points, not a thousand.
 *
 * One visited bit per horizontal lattice edge finds each loop exactly once:
 * every closed rectilinear loop has horizontal edges, and a given horizontal
 * edge carries either East or West traffic, never both.
 */
export function traceSelectionOutlines(mask: Uint8ClampedArray, width: number, height: number, threshold = 127): SelectionOutlineLoop[] {
  const loops: SelectionOutlineLoop[] = [];
  if (width <= 0 || height <= 0) return loops;
  const bounds = selectionBounds(mask, width, height);
  if (!bounds.width || !bounds.height) return loops;

  const selected = (x: number, y: number) => x >= 0 && x < width && y >= 0 && y < height && mask[y * width + x]! > threshold;
  // Directions clockwise in y-down coordinates, so +1 is a right turn.
  const east = 0, south = 1, west = 2, north = 3;
  const stepX = [1, 0, -1, 0], stepY = [0, 1, 0, -1];
  const canWalk = (cx: number, cy: number, direction: number) => {
    if (direction === east) return selected(cx, cy) && !selected(cx, cy - 1);
    if (direction === south) return selected(cx - 1, cy) && !selected(cx, cy);
    if (direction === west) return selected(cx - 1, cy - 1) && !selected(cx - 1, cy);
    return selected(cx, cy - 1) && !selected(cx - 1, cy - 1);
  };

  const visited = new Uint8Array(width * (height + 1));
  const edgeIndex = (leftX: number, y: number) => y * width + leftX;

  const traceLoop = (startX: number, startY: number, startDirection: number) => {
    const points: Point[] = [];
    let cx = startX, cy = startY, direction = startDirection;
    for (;;) {
      if (direction === east) visited[edgeIndex(cx, cy)] = 1;
      else if (direction === west) visited[edgeIndex(cx - 1, cy)] = 1;
      cx += stepX[direction]!; cy += stepY[direction]!;
      let next = direction;
      for (const candidate of [(direction + 1) & 3, direction, (direction + 3) & 3]) {
        if (canWalk(cx, cy, candidate)) { next = candidate; break; }
      }
      if (next !== direction) points.push({ x: cx, y: cy });
      if (cx === startX && cy === startY && next === startDirection) break;
      direction = next;
    }
    if (points.length < 2) return;
    // Start at the topmost-leftmost corner, so the same selection always traces
    // to the same list — a path that reshuffles between renders would restart
    // the dash phase and make the ants twitch.
    let best = 0;
    for (let index = 1; index < points.length; index += 1) {
      const point = points[index]!, current = points[best]!;
      if (point.y < current.y || (point.y === current.y && point.x < current.x)) best = index;
    }
    loops.push({ points: [...points.slice(best), ...points.slice(0, best)] });
  };

  const top = Math.max(0, bounds.y), bottom = Math.min(height, bounds.y + bounds.height);
  const left = Math.max(0, bounds.x), right = Math.min(width, bounds.x + bounds.width);
  for (let y = top; y <= bottom; y += 1) for (let x = left; x < right; x += 1) {
    const below = selected(x, y), above = selected(x, y - 1);
    if (below === above || visited[edgeIndex(x, y)]) continue;
    if (below) traceLoop(x, y, east);       // top edge: outer contour, clockwise
    else traceLoop(x + 1, y, west);         // bottom edge: hole contour, counterclockwise
  }
  return loops;
}

/** The traced boundary as an SVG path — one closed subpath per loop. */
export function selectionOutlinePath(mask: Uint8ClampedArray, width: number, height: number, threshold = 127): string {
  return traceSelectionOutlines(mask, width, height, threshold)
    .map((loop) => `M${loop.points.map((point) => `${point.x} ${point.y}`).join("L")}Z`)
    .join("");
}

/**
 * Two-pass separable box blur, each pass a sliding window: the sum for x+1
 * reuses x's sum (add the cell entering the window, drop the one leaving)
 * instead of re-summing all `2*radius+1` cells from scratch. Standard
 * technique — every image library's box filter works this way — and the
 * difference is not cosmetic: re-summing per pixel is O(width×height×radius),
 * which a large feather on a large selection turns into real, measured
 * multi-second stalls (patch.bench.test.ts, found live chasing exactly that
 * on the patch tool, which re-runs this once per drag frame). The sliding
 * window is O(width×height) regardless of radius.
 */
export function boxBlur(mask: Uint8ClampedArray, width: number, height: number, radius: number): Uint8ClampedArray {
  if (radius < 1) return mask;
  const horizontal = new Uint8ClampedArray(mask.length), output = new Uint8ClampedArray(mask.length);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    let sum = 0, count = 0;
    for (let x = 0; x <= Math.min(radius, width - 1); x += 1) { sum += mask[row + x]!; count += 1; }
    horizontal[row] = Math.round(sum / count);
    for (let x = 1; x < width; x += 1) {
      const entering = x + radius, leaving = x - radius - 1;
      if (entering < width) { sum += mask[row + entering]!; count += 1; }
      if (leaving >= 0) { sum -= mask[row + leaving]!; count -= 1; }
      horizontal[row + x] = Math.round(sum / count);
    }
  }
  for (let x = 0; x < width; x += 1) {
    let sum = 0, count = 0;
    for (let y = 0; y <= Math.min(radius, height - 1); y += 1) { sum += horizontal[y * width + x]!; count += 1; }
    output[x] = Math.round(sum / count);
    for (let y = 1; y < height; y += 1) {
      const entering = y + radius, leaving = y - radius - 1;
      if (entering < height) { sum += horizontal[entering * width + x]!; count += 1; }
      if (leaving >= 0) { sum -= horizontal[leaving * width + x]!; count -= 1; }
      output[y * width + x] = Math.round(sum / count);
    }
  }
  return output;
}

export function createRectangleSelection(width: number, height: number, fromX: number, fromY: number, toX: number, toY: number, feather = 0): PixelSelection {
  const mask = new Uint8ClampedArray(width * height);
  const left = Math.max(0, Math.min(width, Math.floor(Math.min(fromX, toX))));
  const right = Math.max(0, Math.min(width, Math.ceil(Math.max(fromX, toX))));
  const top = Math.max(0, Math.min(height, Math.floor(Math.min(fromY, toY))));
  const bottom = Math.max(0, Math.min(height, Math.ceil(Math.max(fromY, toY))));
  for (let y = top; y < bottom; y += 1) mask.fill(255, y * width + left, y * width + right);
  const softened = boxBlur(mask, width, height, Math.max(0, Math.round(feather)));
  return { mask: softened, bounds: selectionBounds(softened, width, height) };
}

export function createEllipseSelection(width: number, height: number, fromX: number, fromY: number, toX: number, toY: number, feather = 0): PixelSelection {
  const mask = new Uint8ClampedArray(width * height);
  const left = Math.max(0, Math.min(width, Math.floor(Math.min(fromX, toX))));
  const right = Math.max(0, Math.min(width, Math.ceil(Math.max(fromX, toX))));
  const top = Math.max(0, Math.min(height, Math.floor(Math.min(fromY, toY))));
  const bottom = Math.max(0, Math.min(height, Math.ceil(Math.max(fromY, toY))));
  const radiusX = Math.max(0.5, (right - left) / 2), radiusY = Math.max(0.5, (bottom - top) / 2);
  const centerX = left + radiusX, centerY = top + radiusY;
  for (let y = top; y < bottom; y += 1) for (let x = left; x < right; x += 1) {
    const dx = (x + 0.5 - centerX) / radiusX, dy = (y + 0.5 - centerY) / radiusY;
    if (dx * dx + dy * dy <= 1) mask[y * width + x] = 255;
  }
  const softened = boxBlur(mask, width, height, Math.max(0, Math.round(feather)));
  return { mask: softened, bounds: selectionBounds(softened, width, height) };
}

export function createPolygonSelection(width: number, height: number, points: readonly { x: number; y: number }[], feather = 0): PixelSelection {
  const mask = new Uint8ClampedArray(width * height);
  if (points.length < 3) return { mask, bounds: { x: 0, y: 0, width: 0, height: 0 } };
  const minY = Math.max(0, Math.floor(Math.min(...points.map((point) => point.y))));
  const maxY = Math.min(height - 1, Math.ceil(Math.max(...points.map((point) => point.y))));
  for (let y = minY; y <= maxY; y += 1) {
    const scanY = y + 0.5, intersections: number[] = [];
    for (let index = 0; index < points.length; index += 1) {
      const a = points[index]!, b = points[(index + 1) % points.length]!;
      if ((a.y > scanY) === (b.y > scanY)) continue;
      intersections.push(a.x + (scanY - a.y) * (b.x - a.x) / (b.y - a.y));
    }
    intersections.sort((a, b) => a - b);
    for (let index = 0; index + 1 < intersections.length; index += 2) {
      const left = Math.max(0, Math.floor(intersections[index]!)), right = Math.min(width, Math.ceil(intersections[index + 1]!));
      mask.fill(255, y * width + left, y * width + right);
    }
  }
  const softened = boxBlur(mask, width, height, Math.max(0, Math.round(feather)));
  return { mask: softened, bounds: selectionBounds(softened, width, height) };
}

export function createContiguousColorSelection(pixels: Uint8ClampedArray, width: number, height: number, startX: number, startY: number, tolerance: number): PixelSelection {
  const mask = new Uint8ClampedArray(width * height);
  const x = Math.max(0, Math.min(width - 1, Math.floor(startX))), y = Math.max(0, Math.min(height - 1, Math.floor(startY)));
  const seed = (y * width + x) * 4;
  const target = [pixels[seed]!, pixels[seed + 1]!, pixels[seed + 2]!, pixels[seed + 3]!] as const;
  const visited = new Uint8Array(width * height), queue = new Int32Array(width * height);
  let head = 0, tail = 0; queue[tail++] = y * width + x; visited[y * width + x] = 1;
  const limit = Math.max(0, Math.min(255, tolerance));
  while (head < tail) {
    const pixel = queue[head++]!;
    const offset = pixel * 4;
    const difference = Math.max(Math.abs(pixels[offset]! - target[0]), Math.abs(pixels[offset + 1]! - target[1]), Math.abs(pixels[offset + 2]! - target[2]), Math.abs(pixels[offset + 3]! - target[3]));
    if (difference > limit) continue;
    mask[pixel] = 255;
    const px = pixel % width, py = Math.floor(pixel / width);
    const enqueue = (neighbor: number) => { if (!visited[neighbor]) { visited[neighbor] = 1; queue[tail++] = neighbor; } };
    if (px > 0) enqueue(pixel - 1);
    if (px + 1 < width) enqueue(pixel + 1);
    if (py > 0) enqueue(pixel - width);
    if (py + 1 < height) enqueue(pixel + width);
  }
  return { mask, bounds: selectionBounds(mask, width, height) };
}

export function combineSelections(current: PixelSelection | null, incoming: PixelSelection, width: number, height: number, mode: SelectionCombineMode): PixelSelection | null {
  if (!current || mode === "replace") return incoming.bounds.width && incoming.bounds.height ? { mask: incoming.mask.slice(), bounds: { ...incoming.bounds } } : null;
  const mask = new Uint8ClampedArray(width * height);
  for (let index = 0; index < mask.length; index += 1) {
    const a = current.mask[index]!, b = incoming.mask[index]!;
    if (mode === "add") mask[index] = Math.max(a, b);
    else if (mode === "subtract") mask[index] = Math.round(a * (255 - b) / 255);
    else if (mode === "intersect") mask[index] = Math.round(a * b / 255);
    else mask[index] = Math.abs(a - b);
  }
  const bounds = selectionBounds(mask, width, height);
  return bounds.width && bounds.height ? { mask, bounds } : null;
}

/** Limits a selection to pixels that actually contain layer content. */
export function restrictSelectionToAlpha(selection: PixelSelection | null, pixels: Uint8ClampedArray, width: number, height: number): PixelSelection | null {
  if (!selection) return null;
  const mask = new Uint8ClampedArray(width * height);
  for (let index = 0; index < mask.length; index += 1) mask[index] = Math.round(selection.mask[index]! * pixels[index * 4 + 3]! / 255);
  const bounds = selectionBounds(mask, width, height);
  return bounds.width && bounds.height ? { mask, bounds } : null;
}

/**
 * The same restriction, as a *gate* rather than a weight: coverage keeps the
 * selection's own value wherever the layer has any content at all, and drops to
 * zero only where the layer is fully transparent.
 *
 * The difference matters wherever coverage decides how much of a pixel to take
 * and how much to leave — moving a selection, above all. `restrictSelectionToAlpha`
 * multiplies coverage by the pixel's own alpha, so an anti-aliased edge pixel at
 * alpha 128 comes out half-selected; lifting it then takes half of it and leaves
 * `alpha * (1 - coverage)` — 64 — sitting at the old position. That is the faint
 * ghost outline of the moved shape the owner photographed, and its mirror image:
 * the copy that arrives is thinned to `alpha²/255` for the same reason. The
 * layer's transparency is already carried by the pixels; folding it into the
 * selection counts it twice.
 *
 * Both survive because they answer different questions. Weighting is right for
 * "how much of this pixel did the wand select", gating is right for "is this
 * pixel mine to take" — and only gating keeps a partly transparent pixel whole.
 */
export function restrictSelectionToContent(selection: PixelSelection | null, pixels: Uint8ClampedArray, width: number, height: number): PixelSelection | null {
  if (!selection) return null;
  const mask = new Uint8ClampedArray(width * height);
  for (let index = 0; index < mask.length; index += 1) mask[index] = pixels[index * 4 + 3]! > 0 ? selection.mask[index]! : 0;
  const bounds = selectionBounds(mask, width, height);
  return bounds.width && bounds.height ? { mask, bounds } : null;
}

export function selectOpaquePixels(pixels: Uint8ClampedArray, width: number, height: number): PixelSelection | null {
  const mask = new Uint8ClampedArray(width * height);
  for (let index = 0; index < mask.length; index += 1) mask[index] = pixels[index * 4 + 3]!;
  const bounds = selectionBounds(mask, width, height);
  return bounds.width && bounds.height ? { mask, bounds } : null;
}

export function selectAllPixels(width: number, height: number): PixelSelection {
  const mask = new Uint8ClampedArray(width * height);
  mask.fill(255);
  return { mask, bounds: { x: 0, y: 0, width, height } };
}

export function invertPixelSelection(current: PixelSelection | null, width: number, height: number): PixelSelection | null {
  if (!current) return selectAllPixels(width, height);
  const mask = Uint8ClampedArray.from(current.mask, (alpha) => 255 - alpha);
  const bounds = selectionBounds(mask, width, height);
  return bounds.width && bounds.height ? { mask, bounds } : null;
}

/**
 * Softens a selection's edge by a radius, the way Select > Modify > Feather does.
 *
 * A box blur run twice approximates a Gaussian closely enough for an edge that
 * is about to be used as an alpha, and costs two linear passes instead of a
 * quadratic kernel — which matters because this runs over the whole document.
 */
export function featherSelection(
  selection: PixelSelection | null, width: number, height: number, radius: number,
): PixelSelection | null {
  if (!selection) return null;
  const size = Math.max(0, Math.round(radius));
  if (size === 0) return { mask: selection.mask.slice(), bounds: { ...selection.bounds } };

  let mask: Uint8ClampedArray = selection.mask.slice();
  for (let pass = 0; pass < 2; pass += 1) {
    mask = blurAxis(mask, width, height, size, true);
    mask = blurAxis(mask, width, height, size, false);
  }
  const bounds = selectionBounds(mask, width, height);
  return bounds.width && bounds.height ? { mask, bounds } : null;
}

/** One separable box-blur pass, along rows or columns. */
function blurAxis(mask: Uint8ClampedArray, width: number, height: number, radius: number, horizontal: boolean): Uint8ClampedArray {
  const output = new Uint8ClampedArray(mask.length);
  const outer = horizontal ? height : width, inner = horizontal ? width : height;
  const at = (major: number, minor: number) => (horizontal ? major * width + minor : minor * width + major);
  for (let major = 0; major < outer; major += 1) {
    let sum = 0;
    // Prime the window with the clamped left edge, then slide it.
    for (let offset = -radius; offset <= radius; offset += 1) sum += mask[at(major, Math.max(0, Math.min(inner - 1, offset)))]!;
    const span = radius * 2 + 1;
    for (let minor = 0; minor < inner; minor += 1) {
      output[at(major, minor)] = Math.round(sum / span);
      const leaving = Math.max(0, Math.min(inner - 1, minor - radius));
      const entering = Math.max(0, Math.min(inner - 1, minor + radius + 1));
      sum += mask[at(major, entering)]! - mask[at(major, leaving)]!;
    }
  }
  return output;
}

export interface MarqueeOptions {
  /** Shift held during the drag: a square, or a circle for the ellipse. */
  readonly square?: boolean;
  /** Alt/Option held during the drag: the start point becomes the centre. */
  readonly fromCentre?: boolean;
}

/**
 * The corners a marquee drag describes, once its modifiers are applied.
 *
 * Photoshop reads Shift and Alt twice, and means different things by them. Held
 * before the drag starts they choose how the new selection combines with the
 * old one; held during the drag they constrain the shape and move its origin to
 * the centre. This is the second reading — the geometry — and it is separated
 * out because the two are easy to conflate and impossible to test together.
 */
export function marqueeCorners(
  fromX: number, fromY: number, toX: number, toY: number, options: MarqueeOptions = {},
): { fromX: number; fromY: number; toX: number; toY: number } {
  let dx = toX - fromX, dy = toY - fromY;
  if (options.square) {
    // The larger extent wins, so the shape follows the pointer rather than
    // collapsing to whichever axis moved least.
    const extent = Math.max(Math.abs(dx), Math.abs(dy));
    dx = extent * (dx < 0 ? -1 : 1);
    dy = extent * (dy < 0 ? -1 : 1);
  }
  if (options.fromCentre) return { fromX: fromX - dx, fromY: fromY - dy, toX: fromX + dx, toY: fromY + dy };
  return { fromX, fromY, toX: fromX + dx, toY: fromY + dy };
}

/** The same corners as a normalized rectangle, for drawing the preview. */
export function marqueeRect(
  fromX: number, fromY: number, toX: number, toY: number, options: MarqueeOptions = {},
): RasterRect {
  const corners = marqueeCorners(fromX, fromY, toX, toY, options);
  return {
    x: Math.min(corners.fromX, corners.toX),
    y: Math.min(corners.fromY, corners.toY),
    width: Math.abs(corners.toX - corners.fromX),
    height: Math.abs(corners.toY - corners.fromY),
  };
}

/**
 * The mask a brush should honour, given the selection and the layer's locks.
 *
 * Lock Transparency does not forbid painting, it confines it to what the layer
 * already covers — which is the same shape of restriction a selection is, so it
 * folds into the same mask rather than needing its own path through every tool.
 * Returns undefined when nothing restricts the brush, so the tools keep their
 * fast unmasked path.
 */
export function paintMask(
  selection: PixelSelection | null,
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  lockTransparent: boolean,
): Uint8ClampedArray | undefined {
  if (!lockTransparent) return selection?.mask;
  const mask = new Uint8ClampedArray(width * height);
  for (let index = 0; index < mask.length; index += 1) {
    const alpha = pixels[index * 4 + 3]!;
    mask[index] = selection ? Math.round((selection.mask[index]! * alpha) / 255) : alpha;
  }
  return mask;
}

/**
 * Keeps an edit inside the selection.
 *
 * A selection is a statement about where work may happen, and it has to hold
 * for every tool — the brush, the stamp, the smudge, the healing brush, and
 * every filter added later. Enforcing that inside each tool means enforcing it
 * again in each new one, and the first one that forgets is a bug nobody sees
 * until pixels move where they should not have. So it is enforced once, at the
 * point every pixel edit passes through.
 *
 * Partial coverage blends rather than cutting: a feathered selection has to
 * fade the edit out across its edge, which is the whole reason for feathering.
 */
export function confineToSelection(
  before: Uint8ClampedArray,
  after: Uint8ClampedArray,
  mask: Uint8ClampedArray,
): Uint8ClampedArray {
  const result = after.slice();
  for (let index = 0; index < mask.length; index += 1) {
    const coverage = mask[index]!;
    if (coverage === 255) continue;
    const at = index * 4;
    if (coverage === 0) {
      result[at] = before[at]!; result[at + 1] = before[at + 1]!;
      result[at + 2] = before[at + 2]!; result[at + 3] = before[at + 3]!;
      continue;
    }
    const weight = coverage / 255, rest = 1 - weight;
    result[at] = Math.round(after[at]! * weight + before[at]! * rest);
    result[at + 1] = Math.round(after[at + 1]! * weight + before[at + 1]! * rest);
    result[at + 2] = Math.round(after[at + 2]! * weight + before[at + 2]! * rest);
    result[at + 3] = Math.round(after[at + 3]! * weight + before[at + 3]! * rest);
  }
  return result;
}
