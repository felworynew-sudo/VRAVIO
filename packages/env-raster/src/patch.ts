import { solveHealMembrane } from "./heal_membrane";
import { boxBlur } from "./selection";

export interface PatchRegion {
  mask: Uint8ClampedArray;
  width: number;
  height: number;
  originX: number;
  originY: number;
}

/**
 * Everything `createPatchRegion` needs *around* the membrane solve — gathered once, synchronously
 * (cheap: one pass over the region), so the solve itself (the expensive part,
 * `patch.bench.test.ts`'s own ~100ms+ figure) can be swapped out for whoever calls
 * `solveHealMembrane` on `interior`/`offsets`: the main thread directly (as `createPatchRegion`
 * still does below, for the one-shot commit-on-release case), or a Worker (`patch.tsx`'s own live
 * drag preview, through `@vravio/kernel`'s `WorkerPool` — this is the engine layer, so it stays a
 * plain function returning plain typed arrays rather than knowing workers exist at all).
 */
export interface PreparedPatchRegion {
  readonly interior: Uint8Array;
  readonly offsets: Int16Array;
  readonly regionMask: Uint8ClampedArray;
  readonly regionWidth: number;
  readonly regionHeight: number;
  readonly sourcePixels: Uint8ClampedArray;
  readonly destOriginX: number;
  readonly destOriginY: number;
  readonly dx: number;
  readonly dy: number;
  readonly mode: "source" | "destination";
  readonly opacity: number;
}

export function preparePatchRegion(
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
): PreparedPatchRegion {
  const sourcePixels = pixels.slice();
  const interior = new Uint8Array(regionWidth * regionHeight);
  const offsets = new Int16Array(regionWidth * regionHeight * 3);

  // The drag offset arrives as document-space float coordinates (the pointer's
  // own sub-pixel position, scaled back out of the zoom) — every caller in
  // this codebase passes one straight through. `destX + sourceOffsetX` below
  // is a *pixel index*, and a fractional index into a typed array is not a
  // rounding no-op the way it would be on a plain array: `Uint8ClampedArray`
  // has no property at a non-integer key, so `sourcePixels[fractionalIndex]`
  // silently reads `undefined`, every arithmetic use of that turns into NaN,
  // and NaN assigned back into a `Uint8ClampedArray` clamps to 0 — a patch
  // that only ever painted solid black, reported live by the owner ("просто
  // заливает свое выделение черным цветом"). Every existing test drove this
  // with whole-number offsets, which is exactly why none of them caught it.
  const dx = Math.round(sourceOffsetX), dy = Math.round(sourceOffsetY);

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
  const destOriginX = mode === "source" ? regionOriginX : regionOriginX + dx;
  const destOriginY = mode === "source" ? regionOriginY : regionOriginY + dy;

  for (let ly = 0; ly < regionHeight; ly++) {
    // Offsets are gathered across the whole region rectangle: the cells the
    // selection leaves out carry the Dirichlet data that makes the patch meet
    // its surroundings without a seam. Gathering them only inside the selection
    // left the boundary at zero, and a membrane with zero boundary is zero.
    for (let lx = 0; lx < regionWidth; lx++) {
      const destX = destOriginX + lx;
      const destY = destOriginY + ly;
      if (destX < 0 || destX >= canvasWidth || destY < 0 || destY >= canvasHeight) continue;

      const srcX = mode === "source" ? destX + dx : destX - dx;
      const srcY = mode === "source" ? destY + dy : destY - dy;

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

  return { interior, offsets, regionMask, regionWidth, regionHeight, sourcePixels, destOriginX, destOriginY, dx, dy, mode, opacity };
}

/** Writes an already-solved `PreparedPatchRegion` (its `offsets` mutated in place by
 *  `solveHealMembrane`, wherever that ran) back into `pixels` — the cheap phase on either side of
 *  the expensive solve, same as the gather phase `preparePatchRegion` already is. */
export function applyPreparedPatchRegion(pixels: Uint8ClampedArray, canvasWidth: number, canvasHeight: number, prepared: PreparedPatchRegion): void {
  const { offsets, regionMask, regionWidth, regionHeight, sourcePixels, destOriginX, destOriginY, dx, dy, mode, opacity } = prepared;
  for (let ly = 0; ly < regionHeight; ly++) {
    for (let lx = 0; lx < regionWidth; lx++) {
      if (regionMask[ly * regionWidth + lx] === 0) continue;

      const destX = destOriginX + lx;
      const destY = destOriginY + ly;

      const srcX = mode === "source" ? destX + dx : destX - dx;
      const srcY = mode === "source" ? destY + dy : destY - dy;

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

/** The original all-in-one shape, unchanged: prepare, solve on the main thread, apply — every
 *  existing caller (the one-shot commit-on-release, `patch.bench.test.ts`) keeps working exactly
 *  as before. `patch.tsx`'s own live-drag preview is the one caller that skips this and calls
 *  `preparePatchRegion`/`applyPreparedPatchRegion` itself, with the solve routed through a Worker
 *  in between. */
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
  const prepared = preparePatchRegion(pixels, canvasWidth, canvasHeight, regionMask, regionWidth, regionHeight, regionOriginX, regionOriginY, sourceOffsetX, sourceOffsetY, opacity, mode);
  solveHealMembrane(prepared.interior, prepared.regionWidth, prepared.regionHeight, prepared.offsets, sweepScale);
  applyPreparedPatchRegion(pixels, canvasWidth, canvasHeight, prepared);
}

/**
 * Everything `patchFromSelection` needs before the membrane solve — the padded region rectangle,
 * the feathered local mask, and `preparePatchRegion`'s own gathered `interior`/`offsets` — split
 * out for the same reason `preparePatchRegion` itself is (see its own doc comment): so the live
 * drag preview can await a Worker's solve in between this and `applyPreparedPatchRegion`, instead
 * of calling the all-in-one `patchFromSelection` below and blocking the main thread for the
 * ~100ms+ `patch.bench.test.ts` already measures.
 */
export function preparePatchFromSelection(
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
): PreparedPatchRegion | null {
  if (!selectionMask) return null;

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
  if (regionWidth <= 0 || regionHeight <= 0) return null;

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

  return preparePatchRegion(pixels, canvasWidth, canvasHeight, effectiveMask, regionWidth, regionHeight, left, top, sourceOffsetX, sourceOffsetY, opacity, mode);
}

/** The original all-in-one shape, unchanged — every existing caller (the one-shot
 *  commit-on-release, `patch.bench.test.ts`) keeps working exactly as before. `patch.tsx`'s own
 *  live-drag preview calls `preparePatchFromSelection`/`applyPreparedPatchRegion` itself instead,
 *  with the solve routed through a Worker in between — see `preparePatchRegion`'s own comment. */
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
  const prepared = preparePatchFromSelection(pixels, canvasWidth, canvasHeight, selectionMask, selectionBounds, sourceOffsetX, sourceOffsetY, opacity, mode, feather);
  if (!prepared) return;
  solveHealMembrane(prepared.interior, prepared.regionWidth, prepared.regionHeight, prepared.offsets, sweepScale);
  applyPreparedPatchRegion(pixels, canvasWidth, canvasHeight, prepared);
}
