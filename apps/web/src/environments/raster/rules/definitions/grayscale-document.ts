import type { PixelEdit, RasterRule } from "../types";

/**
 * A Grayscale document stays grayscale: whatever a tool commits, the pixels that land are grey.
 *
 * Without this the mode would be a label — Image ▸ Mode ▸ Grayscale would convert once and the
 * first red brush stroke would put colour back into a document that claims to have one channel.
 * Photoshop solves it at the source (in Grayscale the colour picker itself only offers greys);
 * here the same guarantee is cheaper to make at the single door every pixel edit already passes
 * through (CLAUDE.md §4) than in every tool, swatch and paste path separately.
 *
 * The weights are `applyRasterFilter`'s own (0.30/0.59/0.11, the classic NTSC luma Photoshop's
 * RGB→Grayscale conversion also uses), so a stroke painted after the conversion greys exactly the
 * way the conversion greyed what was already there — two formulas would put two different greys on
 * the same colour depending on when it arrived. Alpha is untouched — it is coverage,
 * not colour. Masks are already single-channel and never reach this rule.
 *
 * Order 60: after the locks and the selection, so it greys only what actually lands.
 */
const grayscaleDocument: RasterRule = {
  id: "grayscale-document",
  order: 60,
  applies: (edit, context) => edit.target === "pixels" && context.document.colorModel === "grayscale",
  transform: (edit) => {
    const { after } = edit;
    let result: Uint8ClampedArray | null = null;
    for (let index = 0; index < after.length; index += 4) {
      const r = after[index]!, g = after[index + 1]!, b = after[index + 2]!;
      if (r === g && g === b) continue;
      // Allocated only once something is actually coloured: an edit that is already grey — every
      // edit in the common case, since the document's own pixels are grey — is handed on as it is.
      result ??= after.slice();
      const luma = Math.round((r * 30 + g * 59 + b * 11) / 100);
      result[index] = luma; result[index + 1] = luma; result[index + 2] = luma;
    }
    return result ? ({ ...edit, after: result } satisfies PixelEdit) : edit;
  },
};

export default grayscaleDocument;
