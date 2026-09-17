import { describe, expect, it } from "vitest";
import { applyRasterFilter } from "./index";

/*
 * docs/master-plan.md §58.1: the first versions of the slowest filters, copied verbatim, as the
 * reference their rewrites must reproduce byte for byte. The rewrites change how the work is done
 * (typed arrays instead of per-pixel allocations, precomputed kernels, prefix sums, a 3x3 cell
 * search) — never what is computed.
 */
const byte = (value: number) => Math.max(0, Math.min(255, Math.round(value)));

const unitFromHash = (hash: number) => hash * (2 / 4294967295) - 1;

function addNoiseHash(x: number, y: number, seed: number): number {
  let value = Math.imul(x + 16384, 374761393) >>> 0;
  value = (value ^ Math.imul(y + 8192, 668265263)) >>> 0;
  value = (value ^ Math.imul(seed, 2246822519)) >>> 0;
  value = (value ^ (value >>> 13)) >>> 0;
  value = Math.imul(value, 1274126177) >>> 0;
  return (value ^ (value >>> 16)) >>> 0;
}

function reference_cellularTessellation(source: Uint8ClampedArray, width: number, height: number, cellSize: number): { cellOf: Int32Array; cellColor: number[][]; points: { x: number; y: number }[] } {
  const size = Math.max(3, Math.round(cellSize)), cols = Math.ceil(width / size), rows = Math.ceil(height / size);
  const points: { x: number; y: number }[] = [];
  for (let row = 0; row < rows; row += 1) for (let col = 0; col < cols; col += 1) {
    const jitterX = (unitFromHash(addNoiseHash(col, row, 11)) * 0.5 + 0.5) * size, jitterY = (unitFromHash(addNoiseHash(col, row, 17)) * 0.5 + 0.5) * size;
    points.push({ x: col * size + jitterX, y: row * size + jitterY });
  }
  const cellOf = new Int32Array(width * height), sums: number[][] = points.map(() => [0, 0, 0, 0, 0]);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const col = Math.floor(x / size), row = Math.floor(y / size);
    let best = -1, bestDistance = Infinity;
    for (let dr = -1; dr <= 1; dr += 1) for (let dc = -1; dc <= 1; dc += 1) {
      const c = col + dc, r = row + dr;
      if (c < 0 || c >= cols || r < 0 || r >= rows) continue;
      const index = r * cols + c, point = points[index]!, distance = (point.x - x) ** 2 + (point.y - y) ** 2;
      if (distance < bestDistance) { bestDistance = distance; best = index; }
    }
    const pixelIndex = (y * width + x) * 4;
    cellOf[y * width + x] = best;
    const sum = sums[best]!;
    sum[0] = sum[0]! + source[pixelIndex]!; sum[1] = sum[1]! + source[pixelIndex + 1]!; sum[2] = sum[2]! + source[pixelIndex + 2]!; sum[3] = sum[3]! + source[pixelIndex + 3]!; sum[4] = sum[4]! + 1;
  }
  const cellColor = sums.map((sum) => sum[4]! > 0 ? [sum[0]! / sum[4]!, sum[1]! / sum[4]!, sum[2]! / sum[4]!, sum[3]! / sum[4]!] : [0, 0, 0, 0]);
  return { cellOf, cellColor, points };
}

function reference_oilPaintFilter(source: Uint8ClampedArray, width: number, height: number, brushSize: number, exponent: number): Uint8ClampedArray {
  const output = new Uint8ClampedArray(source.length), r = Math.max(1, Math.min(8, Math.round(brushSize))), buckets = 32;
  const clampX = (x: number) => Math.max(0, Math.min(width - 1, x)), clampY = (y: number) => Math.max(0, Math.min(height - 1, y));
  const exp = Math.max(1, Math.round(exponent));
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const histogram = new Array(buckets).fill(0);
    const bucketColor: number[][] = Array.from({ length: buckets }, () => [0, 0, 0, 0]);
    for (let dy = -r; dy <= r; dy += 1) for (let dx = -r; dx <= r; dx += 1) {
      if (dx * dx + dy * dy > r * r) continue;
      const index = (clampY(y + dy) * width + clampX(x + dx)) * 4;
      const luma = (source[index]! * 30 + source[index + 1]! * 59 + source[index + 2]! * 11) / 100;
      const bucket = Math.min(buckets - 1, Math.floor((luma / 255) * buckets));
      histogram[bucket] += 1;
      for (let c = 0; c < 4; c += 1) bucketColor[bucket]![c] = bucketColor[bucket]![c]! + source[index + c]!;
    }
    const maxCount = Math.max(1, ...histogram);
    let sum = [0, 0, 0, 0], weightSum = 0;
    for (let b = 0; b < buckets; b += 1) {
      if (histogram[b] === 0) continue;
      let weight = 1;
      const ratio = histogram[b] / maxCount;
      for (let power = 0; power < exp; power += 1) weight *= ratio;
      const perPixel = weight / histogram[b];
      for (let c = 0; c < 4; c += 1) sum[c]! += perPixel * bucketColor[b]![c]!;
      weightSum += weight;
    }
    const i = (y * width + x) * 4;
    for (let c = 0; c < 4; c += 1) output[i + c] = weightSum > 0 ? byte(sum[c]! / weightSum) : source[i + c]!;
  }
  return output;
}

function reference_noiseReductionFilter(source: Uint8ClampedArray, width: number, height: number, iterations: number): Uint8ClampedArray {
  let current = source;
  const clampX = (x: number) => Math.max(0, Math.min(width - 1, x)), clampY = (y: number) => Math.max(0, Math.min(height - 1, y));
  const offsets: [number, number][] = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
  for (let pass = 0; pass < Math.max(0, Math.round(iterations)); pass += 1) {
    const next = new Uint8ClampedArray(current.length), snapshot = current;
    const at = (x: number, y: number, c: number) => snapshot[(clampY(y) * width + clampX(x)) * 4 + c]!;
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      for (let c = 0; c < 3; c += 1) {
        const center = at(x, y, c);
        const metric = (axis: number) => {
          const [bx, by] = offsets[axis]!, [ax, ay] = offsets[7 - axis]!;
          const before = at(x + bx, y + by, c), after = at(x + ax, y + ay, c);
          return (center * 2 - before - after) ** 2;
        };
        const reference = [metric(0), metric(1), metric(2), metric(3)];
        let sum = center, count = 1;
        for (let direction = 0; direction < 8; direction += 1) {
          const [ox, oy] = offsets[direction]!, neighbor = at(x + ox, y + oy, c), candidate = neighbor * 0.5 + center * 0.5;
          let valid = true;
          for (let axis = 0; axis < 4 && valid; axis += 1) {
            const [bx, by] = offsets[axis]!, [ax, ay] = offsets[7 - axis]!;
            const before = axis === direction % 4 ? candidate : at(x + bx, y + by, c);
            const after = 7 - axis === direction ? candidate : at(x + ax, y + ay, c);
            if ((center * 2 - before - after) ** 2 > reference[axis]!) valid = false;
          }
          if (valid) { sum += candidate; count += 1; }
        }
        next[i + c] = byte(sum / count);
      }
      next[i + 3] = snapshot[i + 3]!;
    }
    current = next;
  }
  return current === source ? source.slice() : current;
}

function reference_surfaceBlurFilter(source: Uint8ClampedArray, width: number, height: number, radius: number, thresholdPercent: number): Uint8ClampedArray {
  const output = new Uint8ClampedArray(source.length), r = Math.max(1, Math.min(50, Math.round(radius))), maxDelta = Math.max(0, Math.min(100, thresholdPercent)) * 2.55;
  const clampX = (x: number) => Math.max(0, Math.min(width - 1, x)), clampY = (y: number) => Math.max(0, Math.min(height - 1, y));
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const centerIndex = (y * width + x) * 4, sum = [0, 0, 0], weightSum = [0, 0, 0];
    for (let dy = -r; dy <= r; dy += 1) for (let dx = -r; dx <= r; dx += 1) {
      const distanceSquared = dx * dx + dy * dy;
      if (distanceSquared > r * r) continue;
      const sampleIndex = (clampY(y + dy) * width + clampX(x + dx)) * 4;
      const weight = Math.exp(-0.5 * distanceSquared / r) * (source[sampleIndex + 3]! / 255);
      for (let c = 0; c < 3; c += 1) {
        const diff = source[centerIndex + c]! - source[sampleIndex + c]!;
        if (diff > maxDelta || diff < -maxDelta) continue;
        sum[c]! += weight * source[sampleIndex + c]!;
        weightSum[c]! += weight;
      }
    }
    for (let c = 0; c < 3; c += 1) output[centerIndex + c] = weightSum[c]! > 0 ? byte(sum[c]! / weightSum[c]!) : source[centerIndex + c]!;
    output[centerIndex + 3] = source[centerIndex + 3]!;
  }
  return output;
}

function reference_lensBlurFilter(source: Uint8ClampedArray, width: number, height: number, radius: number): Uint8ClampedArray {
  const output = new Uint8ClampedArray(source.length), r = Math.max(1, Math.min(50, Math.round(radius)));
  const clampX = (x: number) => Math.max(0, Math.min(width - 1, x)), clampY = (y: number) => Math.max(0, Math.min(height - 1, y));
  const offsets: [number, number][] = [];
  for (let dy = -r; dy <= r; dy += 1) for (let dx = -r; dx <= r; dx += 1) if (dx * dx + dy * dy <= r * r) offsets.push([dx, dy]);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const sum = [0, 0, 0, 0];
    for (const [dx, dy] of offsets) {
      const index = (clampY(y + dy) * width + clampX(x + dx)) * 4;
      for (let c = 0; c < 4; c += 1) sum[c]! += source[index + c]!;
    }
    const i = (y * width + x) * 4;
    for (let c = 0; c < 4; c += 1) output[i + c] = byte(sum[c]! / offsets.length);
  }
  return output;
}

function reference_pointillizeFilter(source: Uint8ClampedArray, width: number, height: number, cellSize: number): Uint8ClampedArray {
  const size = Math.max(3, Math.round(cellSize)), { cellColor, points } = reference_cellularTessellation(source, width, height, cellSize);
  const output = new Uint8ClampedArray(source.length).fill(255);
  for (let i = 3; i < output.length; i += 4) output[i] = 255;
  const dotRadius = size * 0.42;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const i = (y * width + x) * 4;
    let best = -1, bestDistance = dotRadius * dotRadius;
    for (let index = 0; index < points.length; index += 1) {
      const point = points[index]!, distance = (point.x - x) ** 2 + (point.y - y) ** 2;
      if (distance < bestDistance) { bestDistance = distance; best = index; }
    }
    if (best >= 0) { const color = cellColor[best]!; output[i] = byte(color[0]!); output[i + 1] = byte(color[1]!); output[i + 2] = byte(color[2]!); output[i + 3] = byte(color[3]!); }
  }
  return output;
}

function randomImage(width: number, height: number, seed: number): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(width * height * 4);
  let state = seed;
  const next = () => (state = (state * 1103515245 + 12345) & 0x7fffffff) & 255;
  for (let index = 0; index < pixels.length; index += 4) { pixels[index] = next(); pixels[index + 1] = next(); pixels[index + 2] = next(); pixels[index + 3] = index % 28 === 0 ? next() : 255; }
  return pixels;
}

const cases: [string, Record<string, number>, (source: Uint8ClampedArray, width: number, height: number, settings: Record<string, number>) => Uint8ClampedArray][] = [
  ["oil_paint", { brushSize: 1, stylization: 1 }, (s, w, h, p) => reference_oilPaintFilter(s, w, h, p.brushSize!, p.stylization!)],
  ["oil_paint", { brushSize: 4, stylization: 8 }, (s, w, h, p) => reference_oilPaintFilter(s, w, h, p.brushSize!, p.stylization!)],
  ["oil_paint", { brushSize: 8, stylization: 20 }, (s, w, h, p) => reference_oilPaintFilter(s, w, h, p.brushSize!, p.stylization!)],
  ["despeckle", {}, (s, w, h) => reference_noiseReductionFilter(s, w, h, 1)],
  ["reduce_noise", { strength: 3 }, (s, w, h, p) => reference_noiseReductionFilter(s, w, h, p.strength!)],
  ["surface_blur", { radius: 1, threshold: 0 }, (s, w, h, p) => reference_surfaceBlurFilter(s, w, h, p.radius!, p.threshold!)],
  ["surface_blur", { radius: 5, threshold: 15 }, (s, w, h, p) => reference_surfaceBlurFilter(s, w, h, p.radius!, p.threshold!)],
  ["surface_blur", { radius: 12, threshold: 100 }, (s, w, h, p) => reference_surfaceBlurFilter(s, w, h, p.radius!, p.threshold!)],
  ["lens_blur", { radius: 1 }, (s, w, h, p) => reference_lensBlurFilter(s, w, h, p.radius!)],
  ["lens_blur", { radius: 8 }, (s, w, h, p) => reference_lensBlurFilter(s, w, h, p.radius!)],
  ["lens_blur", { radius: 30 }, (s, w, h, p) => reference_lensBlurFilter(s, w, h, p.radius!)],
  ["pointillize", { cellSize: 3 }, (s, w, h, p) => reference_pointillizeFilter(s, w, h, p.cellSize!)],
  ["pointillize", { cellSize: 12 }, (s, w, h, p) => reference_pointillizeFilter(s, w, h, p.cellSize!)],
  ["pointillize", { cellSize: 40 }, (s, w, h, p) => reference_pointillizeFilter(s, w, h, p.cellSize!)],
];

describe("rewritten slow filters reproduce their first versions exactly", () => {
  for (const [id, settings, reference] of cases) {
    it(`${id} ${JSON.stringify(settings)}`, () => {
      for (const [width, height, seed] of [[37, 23, 1], [64, 64, 2], [5, 90, 3]] as const) {
        const source = randomImage(width, height, seed);
        const expected = reference(source, width, height, settings);
        const actual = applyRasterFilter(source, width, height, id, settings);
        expect(actual.length).toBe(expected.length);
        let firstDifference = -1;
        for (let index = 0; index < expected.length; index += 1) if (actual[index] !== expected[index]) { firstDifference = index; break; }
        expect(firstDifference, `${width}x${height}`).toBe(-1);
      }
    });
  }
});
