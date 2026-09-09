import type { Point, RasterRect, RgbaColor } from "./types";

/**
 * GIMP's own brush falloff, from `app/core/gimpbrushgenerated.c`.
 *
 * `gauss` there is a piecewise quadratic that is 1 at the centre, 0.5 half way and 0 at the rim
 * — the donor's comment calls it "this aint' a real gauss function", and it is what gives a
 * GIMP brush its soft shoulder instead of a straight ramp. Hardness enters through the exponent
 * `0.4 / (1 - hardness)` applied to the normalised distance before the curve, so a hard brush
 * keeps full coverage almost to the rim and a soft one starts fading immediately.
 *
 * What this replaces was `1 - (d - hardness) / (1 - hardness)`: a straight line, which reads as a
 * cone rather than a brush, and at hardness 1 produced a hard *aliased* rim because coverage
 * jumped from 1 to 0 between neighbouring pixels. GIMP has no such step because it oversamples
 * its lookup table; `accumulateDab` gets the same smooth rim from an explicit one-pixel edge
 * ramp instead (see there), which is the same idea done per pixel rather than per table entry.
 */
function gaussFalloff(f: number): number {
  if (f >= 1) return 0;
  if (f < 0.5) return 1 - 2 * f * f;
  const inverse = 1 - f;
  return 2 * inverse * inverse;
}

/** Entries per falloff table. 1024 steps over the radius is finer than any brush this can be
 * asked for can resolve, and the table is indexed by *normalised* distance, so one table serves
 * every size and every pressure. */
export const FALLOFF_STEPS = 1024;

/**
 * Coverage by normalised distance, for one hardness — built once and reused.
 *
 * The donor builds a lookup table for exactly this reason: `pow` per pixel is far too expensive
 * in a brush's inner loop, and the curve depends only on where a pixel sits between the centre
 * and the rim. Measured here before the change, a soft 200px dab cost 1.8ms — at ten coalesced
 * pointer samples per frame that is a brush that cannot keep up with the hand, which is the
 * complaint this fixes.
 *
 * Keyed by hardness rounded to a thousandth: the option itself is an integer percent, so the
 * cache holds a handful of tables in practice and can never grow without bound.
 */
const falloffTables = new Map<number, Float32Array>();

export function falloffTable(hardness: number): Float32Array {
  const clamped = Math.max(0, Math.min(1, hardness));
  const key = Math.round(clamped * 1000);
  const cached = falloffTables.get(key);
  if (cached) return cached;
  // The donor's own guard against dividing by zero as hardness reaches 1.
  const exponent = 1 - clamped < 0.0000004 ? 1000000 : 0.4 / (1 - clamped);
  const table = new Float32Array(FALLOFF_STEPS + 1);
  for (let step = 0; step <= FALLOFF_STEPS; step += 1) {
    table[step] = gaussFalloff(Math.pow(step / FALLOFF_STEPS, exponent));
  }
  falloffTables.set(key, table);
  return table;
}

/**
 * One dab's coverage, accumulated into a stroke mask instead of composited into the picture.
 *
 * A stroke lays its dabs `spacing` apart — 12% of the tip by default — so a pixel in the middle of
 * the band falls inside roughly eight of them. Compositing each dab straight into the layer
 * therefore blends the same pixel eight times: measured, a 200px brush over 1200px costs 47ms at
 * 12% spacing against 11.9ms at 50%, and the whole of that difference is re-blending pixels that
 * were already painted.
 *
 * It is also why a stroke below full opacity used to darken where it crossed itself, which
 * Photoshop's does not. There, opacity is a *ceiling* for the whole stroke and flow is how fast
 * each dab approaches it — which is what `ceiling` and `flow` are here. Accumulating into one mask
 * is what makes a ceiling mean anything at all: nothing can cap what has already been blended in.
 *
 * The shape comes from the same `falloffTable` the clone stamp and the retouch tools use, so no
 * two of them can come to disagree about what a given hardness looks like.
 */
export function accumulateDab(
  coverage: Uint8ClampedArray, width: number, height: number, point: Point, size: number,
  flow: number, ceiling: number, hardness = 0.82, selectionMask?: Uint8ClampedArray,
  roundness = 1, angleDegrees = 0, pressureSize = true, pressureOpacity = false,
): void {
  const pressure = Math.max(0.05, point.pressure ?? 1);
  const radius = Math.max(0.5, size / 2) * (pressureSize ? pressure : 1);
  const shortRadius = Math.max(0.5, radius * Math.max(0.01, Math.min(1, roundness)));
  const radians = angleDegrees * Math.PI / 180, cosine = Math.cos(radians), sine = Math.sin(radians);
  const left = Math.max(0, Math.floor(point.x - radius));
  const right = Math.min(width - 1, Math.ceil(point.x + radius));
  const top = Math.max(0, Math.floor(point.y - radius));
  const bottom = Math.min(height - 1, Math.ceil(point.y + radius));
  const table = falloffTable(hardness);
  const rate = flow * (pressureOpacity ? pressure : 1);
  if (rate <= 0) return;
  const cap = Math.max(0, Math.min(1, ceiling)) * 255;
  for (let y = top; y <= bottom; y += 1) {
    const dy = y + 0.5 - point.y;
    for (let x = left; x <= right; x += 1) {
      const dx = x + 0.5 - point.x;
      const rotatedX = (dx * cosine + dy * sine) / radius, rotatedY = (-dx * sine + dy * cosine) / shortRadius;
      const squared = rotatedX * rotatedX + rotatedY * rotatedY;
      if (squared >= 1) continue;
      const distance = Math.sqrt(squared);
      const shape = table[(distance * FALLOFF_STEPS) | 0]! * Math.min(1, (1 - distance) * radius);
      if (shape <= 0) continue;
      const index = y * width + x;
      const selectionAlpha = selectionMask ? selectionMask[index]! / 255 : 1;
      if (selectionAlpha <= 0) continue;
      const already = coverage[index]!;
      if (already >= cap) continue;
      // Toward the ceiling, never past it: each dab takes a share of what is still missing, which
      // is what lets a soft brush build smoothly instead of banding at its own rim.
      const next = already + rate * shape * selectionAlpha * (cap - already);
      coverage[index] = next > cap ? cap : next;
    }
  }
}

/**
 * The spaced walk along one quadratic slice of the pointer's path, accumulating coverage.
 *
 * `carry` in, carry out. That is the whole point, and it is the fix for the owner's report that a
 * freehand stroke crawls while a Shift-straight line flies. A freehand stroke arrives as a stream
 * of pointer samples a few pixels apart — every coalesced sample the browser buffered, at that —
 * and this used to be walked with `steps = max(1, ceil(length / spacing))` per slice, so *every
 * sample got at least one dab* however close together they were. With a 600px brush, spacing asks
 * for one dab every 72px and freehand was laying one every 3px: twenty-four times the work. A
 * straight line, being a single call over the whole distance, obeyed the spacing exactly — which
 * is precisely why it felt fast.
 *
 * It was a visible fault as well as a slow one: the number of dabs followed how fast the hand
 * moved rather than how far it went, so a slow stroke came out darker than a quick one at the
 * same opacity.
 *
 * Every brush engine carries this remainder — Krita keeps a whole `KisDistanceInformation` for it,
 * GIMP threads `distance` through `gimp_paint_core_paint`. Here it is one number that lives on the
 * stroke and comes back from each call.
 */
export function accumulateStrokeSegment(
  coverage: Uint8ClampedArray, width: number, height: number, from: Point, control: Point, to: Point,
  size: number, flow: number, ceiling: number, selectionMask?: Uint8ClampedArray, hardness = 0.82,
  spacing = 0.12, roundness = 1, angleDegrees = 0, pressureSize = true, pressureOpacity = false, carry = 0,
): number {
  const approximateLength = Math.hypot(control.x - from.x, control.y - from.y) + Math.hypot(to.x - control.x, to.y - control.y);
  const step = Math.max(0.5, size * Math.max(0.01, spacing));
  if (!(approximateLength > 0)) return carry;
  const walk = Math.max(1, Math.ceil(approximateLength / Math.min(step, 2)));
  const at = (t: number): Point => {
    const inverse = 1 - t;
    return {
      x: inverse * inverse * from.x + 2 * inverse * t * control.x + t * t * to.x,
      y: inverse * inverse * from.y + 2 * inverse * t * control.y + t * t * to.y,
      pressure: inverse * inverse * (from.pressure ?? 1) + 2 * inverse * t * (control.pressure ?? 1) + t * t * (to.pressure ?? 1),
    };
  };
  let previous = at(0);
  let travelled = carry;
  for (let index = 1; index <= walk; index += 1) {
    const current = at(index / walk);
    travelled += Math.hypot(current.x - previous.x, current.y - previous.y);
    previous = current;
    if (travelled < step) continue;
    travelled -= step;
    accumulateDab(coverage, width, height, current, size, flow, ceiling, hardness, selectionMask, roundness, angleDegrees, pressureSize, pressureOpacity);
  }
  return travelled;
}

/**
 * Lays a stroke's accumulated coverage onto the picture — once, over the rectangle it covers.
 *
 * `base` is what the layer held before the stroke and is only ever read, so a frame may
 * recomposite the same band as often as it likes without the stroke building on itself. That is
 * the property the whole accumulation exists for.
 */
export function compositeCoverage(
  output: Uint8ClampedArray, base: Uint8ClampedArray, coverage: Uint8ClampedArray,
  width: number, height: number, region: RasterRect, color: RgbaColor, erase = false,
): void {
  const left = Math.max(0, Math.floor(region.x)), top = Math.max(0, Math.floor(region.y));
  const right = Math.min(width, Math.ceil(region.x + region.width));
  const bottom = Math.min(height, Math.ceil(region.y + region.height));
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const index = y * width + x, pixel = index * 4;
      const alpha = coverage[index]! / 255;
      if (alpha <= 0) {
        output[pixel] = base[pixel]!; output[pixel + 1] = base[pixel + 1]!;
        output[pixel + 2] = base[pixel + 2]!; output[pixel + 3] = base[pixel + 3]!;
        continue;
      }
      const destinationAlpha = base[pixel + 3]! / 255;
      if (erase) {
        output[pixel] = base[pixel]!; output[pixel + 1] = base[pixel + 1]!; output[pixel + 2] = base[pixel + 2]!;
        output[pixel + 3] = Math.round(destinationAlpha * (1 - alpha) * 255);
        continue;
      }
      const sourceAlpha = (color.a / 255) * alpha;
      const outputAlpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
      if (outputAlpha <= 0) { output[pixel + 3] = 0; continue; }
      output[pixel] = Math.round((color.r * sourceAlpha + base[pixel]! * destinationAlpha * (1 - sourceAlpha)) / outputAlpha);
      output[pixel + 1] = Math.round((color.g * sourceAlpha + base[pixel + 1]! * destinationAlpha * (1 - sourceAlpha)) / outputAlpha);
      output[pixel + 2] = Math.round((color.b * sourceAlpha + base[pixel + 2]! * destinationAlpha * (1 - sourceAlpha)) / outputAlpha);
      output[pixel + 3] = Math.round(outputAlpha * 255);
    }
  }
}
