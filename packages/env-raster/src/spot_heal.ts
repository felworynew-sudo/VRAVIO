import { solveHealMembrane } from "./heal_membrane";

export interface SpotHealSourceMap {
  valid: boolean;
  mirrored: boolean;
  directionX: number;
  directionY: number;
  anchorX: number;
  anchorY: number;
  shift: number;
}

function mapSource(
  map: SpotHealSourceMap,
  x: number,
  y: number
): [number, number] {
  if (map.mirrored) {
    const distance =
      (map.anchorX - x) * map.directionX +
      (map.anchorY - y) * map.directionY;
    return [
      Math.round(x + 2 * distance * map.directionX),
      Math.round(y + 2 * distance * map.directionY),
    ];
  }
  return [
    Math.round(x + map.shift * map.directionX),
    Math.round(y + map.shift * map.directionY),
  ];
}

export function spotHealSourceMap(
  mask: Uint8ClampedArray,
  maskWidth: number,
  maskHeight: number,
  canvasWidth: number,
  canvasHeight: number,
  boundsX: number,
  boundsY: number,
  margin = 2
): SpotHealSourceMap {
  const result: SpotHealSourceMap = {
    valid: false,
    mirrored: false,
    directionX: 0,
    directionY: 0,
    anchorX: 0,
    anchorY: 0,
    shift: 0,
  };

  // Centroid in document space (like Patchy: sum_x += bounds.x + x)
  let sumX = 0;
  let sumY = 0;
  let covered = 0;
  for (let y = 0; y < maskHeight; y++) {
    for (let x = 0; x < maskWidth; x++) {
      if (mask[y * maskWidth + x] !== 0) {
        sumX += boundsX + x;
        sumY += boundsY + y;
        covered++;
      }
    }
  }
  if (covered === 0) return result;

  const centroidX = sumX / covered;
  const centroidY = sumY / covered;

  // coveredAt takes document-space coords, converts to mask-local
  const coveredAt = (docX: number, docY: number): boolean => {
    if (
      docX < boundsX ||
      docX >= boundsX + maskWidth ||
      docY < boundsY ||
      docY >= boundsY + maskHeight
    )
      return false;
    return mask[(docY - boundsY) * maskWidth + (docX - boundsX)] !== 0;
  };

  // boundaryDistance works in document space
  const boundaryDistance = (ux: number, uy: number): number => {
    const limit = maskWidth + maskHeight;
    let distance = 0;
    while (distance <= limit) {
      const x = Math.round(centroidX + ux * distance);
      const y = Math.round(centroidY + uy * distance);
      if (!coveredAt(x, y)) return distance;
      distance += 1;
    }
    return limit;
  };

  // Primary direction: nearest uncovered cell (document space)
  let bestDx = 1;
  let bestDy = 0;
  let bestDistanceSquared = Infinity;
  let foundOutside = false;
  for (let y = 0; y < maskHeight; y++) {
    for (let x = 0; x < maskWidth; x++) {
      if (mask[y * maskWidth + x] !== 0) continue;
      const docX = boundsX + x;
      const docY = boundsY + y;
      const dx = docX - centroidX;
      const dy = docY - centroidY;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestDistanceSquared && d2 > 0) {
        bestDistanceSquared = d2;
        bestDx = dx;
        bestDy = dy;
        foundOutside = true;
      }
    }
  }
  if (!foundOutside) return result;

  const len = Math.sqrt(bestDx * bestDx + bestDy * bestDy);
  bestDx /= len;
  bestDy /= len;

  const directions: [number, number][] = [
    [bestDx, bestDy],
    [-bestDx, -bestDy],
    [-bestDy, bestDx],
    [bestDy, -bestDx],
  ];

  // mapSource takes document-space (x,y), returns document-space (sx,sy)
  const violationsFor = (candidate: SpotHealSourceMap): number => {
    let violations = 0;
    for (let y = 0; y < maskHeight; y++) {
      for (let x = 0; x < maskWidth; x++) {
        if (mask[y * maskWidth + x] === 0) continue;
        const [sx, sy] = mapSource(candidate, boundsX + x, boundsY + y);
        if (
          sx < 0 ||
          sy < 0 ||
          sx >= canvasWidth ||
          sy >= canvasHeight ||
          coveredAt(sx, sy)
        ) {
          violations++;
        }
      }
    }
    return violations;
  };

  let best: SpotHealSourceMap = result;
  let bestViolations = Infinity;

  for (const [ux, uy] of directions) {
    const rim = boundaryDistance(ux, uy);

    const mirrored: SpotHealSourceMap = {
      valid: true,
      mirrored: true,
      directionX: ux,
      directionY: uy,
      anchorX: centroidX + ux * (rim + margin),
      anchorY: centroidY + uy * (rim + margin),
      shift: 0,
    };
    const mirroredViolations = violationsFor(mirrored);
    if (mirroredViolations < bestViolations) {
      bestViolations = mirroredViolations;
      best = mirrored;
    }
    if (bestViolations === 0) return best;

    let maxExtent = 0;
    for (let y = 0; y < maskHeight; y++) {
      for (let x = 0; x < maskWidth; x++) {
        if (mask[y * maskWidth + x] === 0) continue;
        const along =
          (boundsX + x - centroidX) * ux + (boundsY + y - centroidY) * uy;
        maxExtent = Math.max(maxExtent, Math.abs(along));
      }
    }
    const translated: SpotHealSourceMap = {
      valid: true,
      mirrored: false,
      directionX: ux,
      directionY: uy,
      anchorX: 0,
      anchorY: 0,
      shift: 2 * maxExtent + margin + 1,
    };
    const translatedViolations = violationsFor(translated);
    if (translatedViolations < bestViolations) {
      bestViolations = translatedViolations;
      best = translated;
    }
    if (bestViolations === 0) return best;
  }

  return best;
}

function applySpotHealToRegion(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  mask: Uint8ClampedArray,
  maskOriginX: number,
  maskOriginY: number,
  maskWidth: number,
  maskHeight: number,
  opacity: number
): void {
  const sourceMap = spotHealSourceMap(
    mask,
    maskWidth,
    maskHeight,
    width,
    height,
    maskOriginX,
    maskOriginY
  );
  if (!sourceMap.valid) return;

  const offsets = new Int16Array(maskWidth * maskHeight * 3);
  const interior = new Uint8Array(maskWidth * maskHeight);

  for (let ly = 0; ly < maskHeight; ly++) {
    for (let lx = 0; lx < maskWidth; lx++) {
      if (mask[ly * maskWidth + lx] === 0) continue;
      const x = maskOriginX + lx;
      const y = maskOriginY + ly;
      // mapSource takes and returns document-space coordinates
      const [sx, sy] = mapSource(sourceMap, x, y);
      if (sx < 0 || sx >= width || sy < 0 || sy >= height) continue;

      const destIdx = (y * width + x) * 4;
      const srcIdx = (sy * width + sx) * 4;
      const i = (ly * maskWidth + lx) * 3;
      offsets[i] = pixels[destIdx]! - pixels[srcIdx]!;
      offsets[i + 1] = pixels[destIdx + 1]! - pixels[srcIdx + 1]!;
      offsets[i + 2] = pixels[destIdx + 2]! - pixels[srcIdx + 2]!;
      interior[ly * maskWidth + lx] = 1;
    }
  }

  solveHealMembrane(interior, maskWidth, maskHeight, offsets);

  for (let ly = 0; ly < maskHeight; ly++) {
    for (let lx = 0; lx < maskWidth; lx++) {
      if (mask[ly * maskWidth + lx] === 0) continue;
      const x = maskOriginX + lx;
      const y = maskOriginY + ly;
      const [sx, sy] = mapSource(sourceMap, x, y);
      if (sx < 0 || sx >= width || sy < 0 || sy >= height) continue;

      const srcIdx = (sy * width + sx) * 4;
      const destIdx = (y * width + x) * 4;
      const i = (ly * maskWidth + lx) * 3;
      const m = mask[ly * maskWidth + lx]! / 255;
      const effOpacity = opacity * m;

      const sr = Math.max(0, Math.min(255, pixels[srcIdx]! + offsets[i]!));
      const sg = Math.max(
        0,
        Math.min(255, pixels[srcIdx + 1]! + offsets[i + 1]!)
      );
      const sb = Math.max(
        0,
        Math.min(255, pixels[srcIdx + 2]! + offsets[i + 2]!)
      );

      const dstA = pixels[destIdx + 3]! / 255;
      const srcA = effOpacity;
      const outA = srcA + dstA * (1 - srcA);
      if (outA <= 0) continue;

      pixels[destIdx] = Math.round(
        (sr * srcA + pixels[destIdx]! * dstA * (1 - srcA)) / outA
      );
      pixels[destIdx + 1] = Math.round(
        (sg * srcA + pixels[destIdx + 1]! * dstA * (1 - srcA)) / outA
      );
      pixels[destIdx + 2] = Math.round(
        (sb * srcA + pixels[destIdx + 2]! * dstA * (1 - srcA)) / outA
      );
      pixels[destIdx + 3] = Math.round(outA * 255);
    }
  }
}

export function spotHealDab(
  mask: Uint8ClampedArray,
  maskOriginX: number,
  maskOriginY: number,
  maskWidth: number,
  maskHeight: number,
  targetX: number,
  targetY: number,
  size: number,
  hardness = 0.82,
  roundness = 1,
  angleDegrees = 0
): void {
  const radius = Math.max(0.5, size / 2);
  const shortRadius = Math.max(
    0.5,
    radius * Math.max(0.01, Math.min(1, roundness))
  );
  const radians = (angleDegrees * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);

  const localLeft = Math.max(0, Math.floor(targetX - radius) - maskOriginX);
  const localRight = Math.min(
    maskWidth - 1,
    Math.ceil(targetX + radius) - maskOriginX
  );
  const localTop = Math.max(0, Math.floor(targetY - radius) - maskOriginY);
  const localBottom = Math.min(
    maskHeight - 1,
    Math.ceil(targetY + radius) - maskOriginY
  );

  for (let ly = localTop; ly <= localBottom; ly++) {
    for (let lx = localLeft; lx <= localRight; lx++) {
      const x = maskOriginX + lx;
      const y = maskOriginY + ly;
      const dx = x + 0.5 - targetX;
      const dy = y + 0.5 - targetY;
      const rx = dx * cosine + dy * sine;
      const ry = -dx * sine + dy * cosine;
      const distance = Math.hypot(rx / radius, ry / shortRadius);
      if (distance > 1) continue;

      const coverage =
        distance <= hardness
          ? 1
          : 1 - (distance - hardness) / Math.max(0.0001, 1 - hardness);

      const idx = ly * maskWidth + lx;
      const existing = mask[idx]!;
      mask[idx] = Math.max(existing, Math.round(coverage * 255));
    }
  }
}

export function spotHealStrokeSegment(
  mask: Uint8ClampedArray,
  maskOriginX: number,
  maskOriginY: number,
  maskWidth: number,
  maskHeight: number,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  size: number,
  hardness = 0.82,
  roundness = 1,
  angleDegrees = 0
): void {
  const distance = Math.hypot(toX - fromX, toY - fromY);
  const steps = Math.max(1, Math.ceil(distance / Math.max(1, size * 0.18)));
  for (let step = 0; step <= steps; step++) {
    const t = step / steps;
    const x = fromX + (toX - fromX) * t;
    const y = fromY + (toY - fromY) * t;
    spotHealDab(
      mask,
      maskOriginX,
      maskOriginY,
      maskWidth,
      maskHeight,
      x,
      y,
      size,
      hardness,
      roundness,
      angleDegrees
    );
  }
}

export function spotHealApply(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  mask: Uint8ClampedArray,
  maskOriginX: number,
  maskOriginY: number,
  maskWidth: number,
  maskHeight: number,
  opacity: number
): void {
  applySpotHealToRegion(
    pixels,
    width,
    height,
    mask,
    maskOriginX,
    maskOriginY,
    maskWidth,
    maskHeight,
    opacity
  );
}
