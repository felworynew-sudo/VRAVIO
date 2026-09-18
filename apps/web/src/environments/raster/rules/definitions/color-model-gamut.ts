import { limitToCmykGamut, nearestPaletteIndex, paletteFromHex } from "@vravio/env-raster";
import type { PixelEdit, RasterRule } from "../types";

/**
 * A CMYK document holds only colours four inks can print; an Indexed one holds only its palette.
 *
 * The same argument as `grayscale-document`, for the other two models that restrict colour: the
 * mode has to be a property of the document rather than a one-off conversion, or the first brush
 * stroke after entering it puts back a colour the mode says cannot exist. Photoshop enforces this
 * at the source (in CMYK the picker only offers printable colours; in Indexed most tools are off
 * entirely); this editor enforces it at the one door every pixel edit already passes through
 * (CLAUDE.md §4).
 *
 * Order 61, right after the grayscale rule: whatever the tool, the locks and the selection have
 * already had their say, so only pixels that are really landing get corrected.
 */
const colorModelGamut: RasterRule = {
  id: "color-model-gamut",
  order: 61,
  applies: (edit, context) => edit.target === "pixels" && (context.document.colorModel === "cmyk" || context.document.colorModel === "indexed"),
  transform: (edit, context) => {
    if (context.document.colorModel === "cmyk") {
      // A buffer already inside the gamut comes back unchanged, so the common case — every edit in
      // a document that is already CMYK — still costs one pass and no second allocation.
      const candidate = edit.after.slice();
      limitToCmykGamut(candidate);
      return changed(edit.after, candidate) ? ({ ...edit, after: candidate } satisfies PixelEdit) : edit;
    }
    const colors = context.document.palette;
    if (!colors || !colors.length) return edit;
    const palette = paletteFromHex(colors);
    let result: Uint8ClampedArray | null = null;
    for (let index = 0; index < edit.after.length; index += 4) {
      if (!edit.after[index + 3]) continue;
      const entry = nearestPaletteIndex(palette, edit.after[index]!, edit.after[index + 1]!, edit.after[index + 2]!);
      const r = palette.colors[entry * 3]!, g = palette.colors[entry * 3 + 1]!, b = palette.colors[entry * 3 + 2]!;
      if (r === edit.after[index] && g === edit.after[index + 1] && b === edit.after[index + 2]) continue;
      result ??= edit.after.slice();
      result[index] = r; result[index + 1] = g; result[index + 2] = b;
    }
    return result ? ({ ...edit, after: result } satisfies PixelEdit) : edit;
  },
};

const changed = (a: Uint8ClampedArray, b: Uint8ClampedArray): boolean => {
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return true;
  return false;
};

export default colorModelGamut;
