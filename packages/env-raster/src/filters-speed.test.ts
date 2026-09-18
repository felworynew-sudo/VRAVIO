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

function reference_sampleBilinear(source: Uint8ClampedArray, width: number, height: number, x: number, y: number): [number, number, number, number] {
  const cx = Math.max(0, Math.min(width - 1.001, x)), cy = Math.max(0, Math.min(height - 1.001, y));
  const x0 = Math.floor(cx), y0 = Math.floor(cy), x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1), fx = cx - x0, fy = cy - y0;
  const i00 = (y0 * width + x0) * 4, i10 = (y0 * width + x1) * 4, i01 = (y1 * width + x0) * 4, i11 = (y1 * width + x1) * 4, out: [number, number, number, number] = [0, 0, 0, 0];
  for (let c = 0; c < 4; c += 1) { const top = source[i00 + c]! * (1 - fx) + source[i10 + c]! * fx, bottom = source[i01 + c]! * (1 - fx) + source[i11 + c]! * fx; out[c] = top * (1 - fy) + bottom * fy; }
  return out;
}

function reference_motionBlurFilter(source: Uint8ClampedArray, width: number, height: number, distance: number, angleDeg: number): Uint8ClampedArray {
  const output = new Uint8ClampedArray(source.length), theta = angleDeg * Math.PI / 180, length = Math.max(1, distance);
  const steps = Math.ceil(length) + 1, offsetX = length * Math.cos(theta), offsetY = length * Math.sin(theta);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const sum = [0, 0, 0, 0];
    for (let step = 0; step < steps; step += 1) {
      const t = steps === 1 ? 0 : step / (steps - 1) - 0.5;
      const [r, g, b, a] = reference_sampleBilinear(source, width, height, x + offsetX * t, y + offsetY * t);
      sum[0] = sum[0]! + r; sum[1] = sum[1]! + g; sum[2] = sum[2]! + b; sum[3] = sum[3]! + a;
    }
    const i = (y * width + x) * 4;
    for (let c = 0; c < 4; c += 1) output[i + c] = byte(sum[c]! / steps);
  }
  return output;
}

function reference_radialBlurFilter(source: Uint8ClampedArray, width: number, height: number, amountPercent: number, method: number): Uint8ClampedArray {
  const output = new Uint8ClampedArray(source.length), cx = width / 2, cy = height / 2;
  if (method >= 1) {
    const factor = Math.max(0, Math.min(100, amountPercent)) / 100 * 0.5;
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
      const endX = x + (cx - x) * factor, endY = y + (cy - y) * factor;
      const steps = Math.max(3, Math.min(64, Math.ceil(Math.hypot(endX - x, endY - y)) + 1));
      const sum = [0, 0, 0, 0];
      for (let step = 0; step < steps; step += 1) {
        const t = step / (steps - 1);
        const [r, g, b, a] = reference_sampleBilinear(source, width, height, x + (endX - x) * t, y + (endY - y) * t);
        sum[0] = sum[0]! + r; sum[1] = sum[1]! + g; sum[2] = sum[2]! + b; sum[3] = sum[3]! + a;
      }
      const i = (y * width + x) * 4;
      for (let c = 0; c < 4; c += 1) output[i + c] = byte(sum[c]! / steps);
    }
    return output;
  }
  const angle = Math.max(0, Math.min(100, amountPercent)) / 100 * Math.PI / 6;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const dx = x - cx, dy = y - cy, r = Math.hypot(dx, dy);
    const steps = Math.max(3, Math.min(64, Math.ceil(r * angle * 1.41)));
    const phiBase = Math.atan2(dy, dx), phiStart = phiBase + angle / 2, phiStep = angle / steps;
    const sum = [0, 0, 0, 0];
    for (let step = 0; step < steps; step += 1) {
      const phi = phiStart - step * phiStep;
      const [sr, sg, sb, sa] = reference_sampleBilinear(source, width, height, cx + r * Math.cos(phi), cy + r * Math.sin(phi));
      sum[0] = sum[0]! + sr; sum[1] = sum[1]! + sg; sum[2] = sum[2]! + sb; sum[3] = sum[3]! + sa;
    }
    const i = (y * width + x) * 4;
    for (let c = 0; c < 4; c += 1) output[i + c] = byte(sum[c]! / steps);
  }
  return output;
}

function reference_lensFlareFilter(source: Uint8ClampedArray, width: number, height: number, brightnessPercent: number, lensType: number, positionXPercent: number, positionYPercent: number): Uint8ClampedArray {
  const output = source.slice();
  const centerX = (positionXPercent / 100) * width, centerY = (positionYPercent / 100) * height;
  const lensPresets = [
    { matteScale: 1, reflectionStrength: 1, anamorphic: false },
    { matteScale: 0.6, reflectionStrength: 0.65, anamorphic: false },
    { matteScale: 0.85, reflectionStrength: 1.15, anamorphic: false },
    { matteScale: 0.9, reflectionStrength: 0.45, anamorphic: true },
  ];
  const preset = lensPresets[Math.round(lensType)] ?? lensPresets[0]!;
  const matte = width * preset.matteScale, brightness = Math.max(0, brightnessPercent) / 100;
  const colorSize = matte * 0.0375, glowSize = matte * 0.078125, innerSize = matte * 0.1796875, outerSize = matte * 0.3359375, haloSize = matte * 0.084375;
  const color = [0.937255, 0.937255, 0.937255], glow = [0.960784, 0.960784, 0.960784], inner = [1, 0.14902, 0.168627], outer = [0.270588, 0.231373, 0.25098], halo = [0.313726, 0.058824, 0.015686];
  const xh = width / 2, yh = height / 2, dx = xh - centerX, dy = yh - centerY;
  const reflections: { size: number; xp: number; yp: number; type: number; color: number[] }[] = [
    { f: 0.6699, size: 0.027, type: 1, color: [0, 0.054902, 0.443137] },
    { f: 0.2692, size: 0.01, type: 1, color: [0.352941, 0.709804, 0.556863] },
    { f: -0.0112, size: 0.005, type: 1, color: [0.219608, 0.54902, 0.415686] },
    { f: 0.649, size: 0.031, type: 2, color: [0.035294, 0.113725, 0.07451] },
    { f: 0.4696, size: 0.015, type: 2, color: [0.094118, 0.054902, 0] },
    { f: 0.4087, size: 0.037, type: 2, color: [0.094118, 0.054902, 0] },
    { f: -0.2003, size: 0.022, type: 2, color: [0.164706, 0.07451, 0] },
    { f: -0.4103, size: 0.025, type: 2, color: [0, 0.035294, 0.066667] },
    { f: -0.4503, size: 0.058, type: 2, color: [0, 0.015686, 0.039216] },
    { f: -0.5112, size: 0.017, type: 2, color: [0.019608, 0.019608, 0.054902] },
    { f: -1.496, size: 0.2, type: 2, color: [0.035294, 0.015686, 0] },
    { f: -1.496, size: 0.5, type: 2, color: [0.035294, 0.015686, 0] },
    { f: 0.4487, size: 0.075, type: 3, color: [0.133333, 0.07451, 0] },
    { f: 1, size: 0.1, type: 3, color: [0.054902, 0.101961, 0] },
    { f: -1.301, size: 0.039, type: 3, color: [0.039216, 0.098039, 0.05098] },
    { f: 1.309, size: 0.19, type: 4, color: [0.035294, 0, 0.066667] },
    { f: 1.309, size: 0.195, type: 4, color: [0.035294, 0.062745, 0.019608] },
    { f: 1.309, size: 0.2, type: 4, color: [0.066667, 0.015686, 0] },
    { f: -1.301, size: 0.038, type: 4, color: [0.066667, 0.015686, 0] },
  ].map((r) => ({ size: matte * r.size, xp: r.f * dx + xh, yp: r.f * dy + yh, type: r.type, color: r.color }));
  const fixPixel = (pixel: number[], percent: number, colorProportion: number[]) => { for (let c = 0; c < 3; c += 1) pixel[c]! += (1 - pixel[c]!) * percent * colorProportion[c]! * brightness; };
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const i = (y * width + x) * 4;
    const pixel = [source[i]! / 255, source[i + 1]! / 255, source[i + 2]! / 255];
    const hyp = Math.hypot(x - centerX, y - centerY);
    let percent = (colorSize - hyp) / colorSize; if (percent > 0) fixPixel(pixel, percent * percent, color);
    percent = (glowSize - hyp) / glowSize; if (percent > 0) fixPixel(pixel, percent * percent, glow);
    percent = (innerSize - hyp) / innerSize; if (percent > 0) fixPixel(pixel, percent * percent, inner);
    percent = (outerSize - hyp) / outerSize; if (percent > 0) fixPixel(pixel, percent, outer);
    percent = Math.abs((hyp - haloSize) / (haloSize * 0.07)); if (percent < 1) fixPixel(pixel, 1 - percent, halo);
    for (const reflection of reflections) {
      const rhyp = Math.hypot(x - reflection.xp, y - reflection.yp);
      if (reflection.type === 1) { const p = (reflection.size - rhyp) / reflection.size; if (p > 0) fixPixel(pixel, p * p * preset.reflectionStrength, reflection.color); }
      else if (reflection.type === 2) { const p = Math.min(1, (reflection.size - rhyp) / (reflection.size * 0.15)); if (p > 0) fixPixel(pixel, p * preset.reflectionStrength, reflection.color); }
      else if (reflection.type === 3) { let p = (reflection.size - rhyp) / (reflection.size * 0.12); if (p > 0) { if (p > 1) p = 1 - p * 0.12; fixPixel(pixel, p * preset.reflectionStrength, reflection.color); } }
      else { const p = Math.abs((rhyp - reflection.size) / (reflection.size * 0.04)); if (p < 1) fixPixel(pixel, (1 - p) * preset.reflectionStrength, reflection.color); }
    }
    if (preset.anamorphic) {
      const bandHalf = height * 0.006 + 1.5, distY = Math.abs(y - centerY);
      if (distY < bandHalf) fixPixel(pixel, (1 - distY / bandHalf) * Math.max(0, 1 - Math.abs(x - centerX) / (width * 0.6)) * 0.85, [0.6, 0.75, 1]);
    }
    output[i] = byte(pixel[0]! * 255); output[i + 1] = byte(pixel[1]! * 255); output[i + 2] = byte(pixel[2]! * 255); output[i + 3] = source[i + 3]!;
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
  ["motion_blur", { distance: 20, angle: 35 }, (s, w, h, p) => reference_motionBlurFilter(s, w, h, p.distance!, p.angle!)],
  ["motion_blur", { distance: 1, angle: 0 }, (s, w, h, p) => reference_motionBlurFilter(s, w, h, p.distance!, p.angle!)],
  ["radial_blur", { amount: 60, method: 0 }, (s, w, h, p) => reference_radialBlurFilter(s, w, h, p.amount!, p.method!)],
  ["radial_blur", { amount: 60, method: 1 }, (s, w, h, p) => reference_radialBlurFilter(s, w, h, p.amount!, p.method!)],
  ["lens_flare", { brightness: 100, lensType: 0, positionX: 50, positionY: 50 }, (s, w, h, p) => reference_lensFlareFilter(s, w, h, p.brightness!, p.lensType!, p.positionX!, p.positionY!)],
  ["lens_flare", { brightness: 160, lensType: 3, positionX: 20, positionY: 80 }, (s, w, h, p) => reference_lensFlareFilter(s, w, h, p.brightness!, p.lensType!, p.positionX!, p.positionY!)],
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
