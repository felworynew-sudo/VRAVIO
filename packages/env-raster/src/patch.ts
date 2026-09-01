import { solveHealMembrane } from "./heal_membrane";

export interface PatchRegion {
  mask: Uint8ClampedArray;
  width: number;
  height: number;
  originX: number;
  originY: number;
}

export function createPatchRegion(
  pixels: Uint8ClampedArray,
  canvasWidth: number,
  canvasHeight: number,
  regionMask: Uint8ClampedArray,
  regionWidth: number,
  regionHeight: number,
  regionOriginX: number,
  regionOriginY: number,
  sourceOffsetX: number,
  sourceOffsetY: number,
  opacity: number,
  mode: "source" | "destination" = "source"
): void {
  const sourcePixels = pixels.slice();
  const interior = new Uint8Array(regionWidth * regionHeight);
  const offsets = new Int16Array(regionWidth * regionHeight * 3);

  for (let ly = 0; ly < regionHeight; ly++) {
    for (let lx = 0; lx < regionWidth; lx++) {
      if (regionMask[ly * regionWidth + lx] === 0) continue;

      const destX = regionOriginX + lx;
      const destY = regionOriginY + ly;

      let srcX: number;
      let srcY: number;
      if (mode === "source") {
        srcX = destX + sourceOffsetX;
        srcY = destY + sourceOffsetY;
      } else {
        srcX = destX - sourceOffsetX;
        srcY = destY - sourceOffsetY;
      }

      if (
        srcX < 0 ||
        srcX >= canvasWidth ||
        srcY < 0 ||
        srcY >= canvasHeight
      )
        continue;

      const destIdx = (destY * canvasWidth + destX) * 4;
      const srcIdx = (srcY * canvasWidth + srcX) * 4;
      const i = (ly * regionWidth + lx) * 3;

      offsets[i] = sourcePixels[destIdx]! - sourcePixels[srcIdx]!;
      offsets[i + 1] = sourcePixels[destIdx + 1]! - sourcePixels[srcIdx + 1]!;
      offsets[i + 2] = sourcePixels[destIdx + 2]! - sourcePixels[srcIdx + 2]!;
      interior[ly * regionWidth + lx] = 1;
    }
  }

  solveHealMembrane(interior, regionWidth, regionHeight, offsets);

  for (let ly = 0; ly < regionHeight; ly++) {
    for (let lx = 0; lx < regionWidth; lx++) {
      if (regionMask[ly * regionWidth + lx] === 0) continue;

      const destX = regionOriginX + lx;
      const destY = regionOriginY + ly;

      let srcX: number;
      let srcY: number;
      if (mode === "source") {
        srcX = destX + sourceOffsetX;
        srcY = destY + sourceOffsetY;
      } else {
        srcX = destX - sourceOffsetX;
        srcY = destY - sourceOffsetY;
      }

      if (
        srcX < 0 ||
        srcX >= canvasWidth ||
        srcY < 0 ||
        srcY >= canvasHeight
      )
        continue;

      const srcIdx = (srcY * canvasWidth + srcX) * 4;
      const destIdx = (destY * canvasWidth + destX) * 4;
      const i = (ly * regionWidth + lx) * 3;
      const m = regionMask[ly * regionWidth + lx]! / 255;
      const effOpacity = opacity * m;

      const sr = Math.max(0, Math.min(255, sourcePixels[srcIdx]! + offsets[i]!));
      const sg = Math.max(
        0,
        Math.min(255, sourcePixels[srcIdx + 1]! + offsets[i + 1]!)
      );
      const sb = Math.max(
        0,
        Math.min(255, sourcePixels[srcIdx + 2]! + offsets[i + 2]!)
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

export function patchFromSelection(
  pixels: Uint8ClampedArray,
  canvasWidth: number,
  canvasHeight: number,
  selectionMask: Uint8ClampedArray | null,
  selectionBounds: { x: number; y: number; width: number; height: number },
  sourceOffsetX: number,
  sourceOffsetY: number,
  opacity: number,
  mode: "source" | "destination" = "source",
  feather = 0
): void {
  if (!selectionMask) return;

  const localMask = new Uint8ClampedArray(selectionBounds.width * selectionBounds.height);
  for (let y = 0; y < selectionBounds.height; y += 1) for (let x = 0; x < selectionBounds.width; x += 1) {
    const canvasX = selectionBounds.x + x, canvasY = selectionBounds.y + y;
    if (canvasX >= 0 && canvasX < canvasWidth && canvasY >= 0 && canvasY < canvasHeight) localMask[y * selectionBounds.width + x] = selectionMask[canvasY * canvasWidth + canvasX]!;
  }

  let effectiveMask: Uint8ClampedArray<ArrayBufferLike> = localMask;
  if (feather > 0) {
    effectiveMask = featherMask(
      localMask,
      selectionBounds.width,
      selectionBounds.height,
      feather
    );
  }

  createPatchRegion(
    pixels,
    canvasWidth,
    canvasHeight,
    effectiveMask,
    selectionBounds.width,
    selectionBounds.height,
    selectionBounds.x,
    selectionBounds.y,
    sourceOffsetX,
    sourceOffsetY,
    opacity,
    mode
  );
}

function featherMask(
  mask: Uint8ClampedArray,
  width: number,
  height: number,
  radius: number
): Uint8ClampedArray {
  const result = new Uint8ClampedArray(mask);
  const temp = new Float32Array(width * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let minDist = Infinity;
      const val = mask[y * width + x]! / 255;
      if (val === 0) continue;

      for (let fy = Math.max(0, y - Math.ceil(radius)); fy <= Math.min(height - 1, y + Math.ceil(radius)); fy++) {
        for (let fx = Math.max(0, x - Math.ceil(radius)); fx <= Math.min(width - 1, x + Math.ceil(radius)); fx++) {
          if (mask[fy * width + fx] === 0) {
            const d = Math.hypot(fx - x, fy - y);
            minDist = Math.min(minDist, d);
          }
        }
      }

      const factor = minDist >= radius ? 1 : minDist / radius;
      temp[y * width + x] = val * factor;
    }
  }

  for (let i = 0; i < width * height; i++) {
    result[i] = Math.round(Math.max(0, Math.min(255, temp[i]!)));
  }
  return result;
}
