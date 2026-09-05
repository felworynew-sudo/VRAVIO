import type { PixelEdit, RasterRule } from "../types";

/**
 * Lock Transparency: an edit may not put colour where the layer had none.
 *
 * The soft half of this lives in `paintMask`, which folds the layer's own
 * alpha into the mask the tools paint through, so a stroke fades out across a
 * semi-transparent edge exactly as it should. This is the hard half: whatever
 * a tool does, a pixel the layer was fully transparent at stays transparent.
 *
 * Deliberately a floor and not a repeat of `paintMask`. Re-applying the same
 * coverage the tool already honoured squares it — a pixel at alpha 128 gets
 * painted at half strength by the tool and then blended half of the way back
 * here, ending at a quarter — so a rule written as "confine to the layer's
 * alpha" would visibly thin every stroke along a soft edge. Restoring only
 * where the alpha was a hard zero costs an honest tool nothing (it painted
 * nothing there) and still refuses a dishonest one.
 */
const lockTransparentPixels: RasterRule = {
  id: "lock-transparent-pixels",
  order: 40,
  applies: (edit, context) => edit.target === "pixels" && context.layer?.lockTransparent === true,
  transform: (edit) => {
    const { before, after } = edit;
    let result: Uint8ClampedArray | null = null;
    for (let index = 0; index < before.length; index += 4) {
      if (before[index + 3] !== 0) continue;
      if (after[index] === before[index] && after[index + 1] === before[index + 1]
        && after[index + 2] === before[index + 2] && after[index + 3] === before[index + 3]) continue;
      // Only allocate once something actually has to be put back: for every
      // tool that honours `paintMask` this loop finds nothing and the edit is
      // handed on untouched.
      result ??= after.slice();
      result[index] = before[index]!; result[index + 1] = before[index + 1]!;
      result[index + 2] = before[index + 2]!; result[index + 3] = before[index + 3]!;
    }
    return result ? ({ ...edit, after: result } satisfies PixelEdit) : edit;
  },
};

export default lockTransparentPixels;
