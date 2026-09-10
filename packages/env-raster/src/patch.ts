import { solveHealMembrane } from "./heal_membrane";
import { boxBlur } from "./selection";

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
  mode: "source" | "destination" = "source",
  sweepScale = 1
): void {
  const sourcePixels = pixels.slice();
  const interior = new Uint8Array(regionWidth * regionHeight);
  const offsets = new Int16Array(regionWidth * regionHeight * 3);

  // Source mode fixes the selection in place and reads from the dragged-to
  // spot (`destX = regionOriginX + lx`, the region's own rectangle). Destination
  // mode swaps which side is fixed and which is read — the *content* moves to
  // the drop point, not just the direction the membrane samples from — so the
  // whole write/solve rectangle has to shift by the drag offset, not merely the
  // read formula inside it. Getting this wrong (leaving destX anchored at
  // regionOriginX for both modes, only flipping the ± on srcX) makes
  // Destination read from the mirror side while still painting over the
  // original selection — never actually relocating anything, which is the bug
  // this shift fixes: found live, reported by the owner as "не по тем
  // принципам" against Photoshop's own Destination ("образец... тащится туда
  // куда ты его тащишь").
  const destOriginX = mode === "source" ? regionOriginX : regionOriginX + sourceOffsetX;
  const destOriginY = mode === "source" ? regionOriginY : regionOriginY + sourceOffsetY;

  for (let ly = 0; ly < regionHeight; ly++) {
    // Offsets are gathered across the whole region rectangle: the cells the
    // selection leaves out carry the Dirichlet data that makes the patch meet
    // its surroundings without a seam. Gathering them only inside the selection
    // left the boundary at zero, and a membrane with zero boundary is zero.
    for (let lx = 0; lx < regionWidth; lx++) {
      const destX = destOriginX + lx;
      const destY = destOriginY + ly;
      if (destX < 0 || destX >= canvasWidth || destY < 0 || destY >= canvasHeight) continue;

      const srcX = mode === "source" ? destX + sourceOffsetX : destX - sourceOffsetX;
      const srcY = mode === "source" ? destY + sourceOffsetY : destY - sourceOffsetY;

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
      interior[ly * regionWidth + lx] = regionMask[ly * regionWidth + lx] === 0 ? 0 : 1;
    }
  }

  solveHealMembrane(interior, regionWidth, regionHeight, offsets, sweepScale);

  for (let ly = 0; ly < regionHeight; ly++) {
    for (let lx = 0; lx < regionWidth; lx++) {
      if (regionMask[ly * regionWidth + lx] === 0) continue;

      const destX = destOriginX + lx;
      const destY = destOriginY + ly;

      const srcX = mode === "source" ? destX + sourceOffsetX : destX - sourceOffsetX;
      const srcY = mode === "source" ? destY + sourceOffsetY : destY - sourceOffsetY;

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
  feather = 0,
  sweepScale = 1
): void {
  if (!selectionMask) return;

  // The membrane is solved over this rectangle, and it needs cells outside the
  // selection to hold its boundary values. A rectangular selection fills its own
  // bounds exactly, leaving none: the solver then has nothing to solve against,
  // returns untouched, and the patch writes the destination back over itself —
  // the tool appears to do nothing at all. Padding guarantees the ring.
  const margin = Math.max(4, Math.ceil(feather) + 4);
  const left = Math.max(0, Math.floor(selectionBounds.x) - margin);
  const top = Math.max(0, Math.floor(selectionBounds.y) - margin);
  const right = Math.min(canvasWidth, Math.ceil(selectionBounds.x + selectionBounds.width) + margin);
  const bottom = Math.min(canvasHeight, Math.ceil(selectionBounds.y + selectionBounds.height) + margin);
  const regionWidth = right - left, regionHeight = bottom - top;
  if (regionWidth <= 0 || regionHeight <= 0) return;

  const localMask = new Uint8ClampedArray(regionWidth * regionHeight);
  for (let y = 0; y < regionHeight; y += 1) for (let x = 0; x < regionWidth; x += 1) {
    const canvasX = left + x, canvasY = top + y;
    if (canvasX >= 0 && canvasX < canvasWidth && canvasY >= 0 && canvasY < canvasHeight) localMask[y * regionWidth + x] = selectionMask[canvasY * canvasWidth + canvasX]!;
  }

  // The same box-blur `createRectangleSelection`/`createEllipseSelection`
  // already feather a plain selection with (selection.ts) — one feather
  // curve app-wide, not a second one that looks and costs differently just
  // because this caller is the patch tool. The patch tool's own hand-rolled
  // nearest-empty-cell search this replaced was O(width×height×radius²): a
  // 300×300 repair at a 40px feather measured ~2 seconds per drag frame,
  // there to be measured because the patch preview re-solves on every
  // pointer move (patch.bench.test.ts) — this scan happens once per frame a
  // real drag renders, not once per gesture.
  let effectiveMask: Uint8ClampedArray<ArrayBufferLike> = localMask;
  if (feather > 0) effectiveMask = boxBlur(localMask, regionWidth, regionHeight, Math.max(0, Math.round(feather)));

  createPatchRegion(
    pixels,
    canvasWidth,
    canvasHeight,
    effectiveMask,
    regionWidth,
    regionHeight,
    left,
    top,
    sourceOffsetX,
    sourceOffsetY,
    opacity,
    mode,
    sweepScale
  );
}
