import { colorToCss, type Color } from "@vravio/kernel";
import type { VectorDocumentState } from "./types";

/**
 * Stage 14 of docs/vector-plan.md: on-screen CMYK softproof needs, for each
 * distinct solid colour the document actually paints with, the sRGB
 * roundtrip through a real ICC profile — `apps/web/src/vector-softproof.ts`
 * does that async part (it needs the WASM `srgbToCmyk`/`cmykToSrgb`, which
 * this package cannot depend on without breaking the "movement/geometry
 * plus batch operations" layer boundary docs/migration-plan.md draws). This
 * file is the pure, synchronous half: which colours are even in play.
 *
 * Deliberately narrow — `space === "srgb"` solid paints only. A gradient
 * stop's own colour is not collected (proofing every stop of every
 * gradient is real, separate work this pass does not include — the same
 * honest-gap shape this file's neighbours already have for `lab`/`spot` in
 * `colorToCss`'s own doc comment), and neither is `cmyk`/`gray`/`lab`/
 * `spot` (a CMYK softproof of an already-CMYK colour, or of a colour this
 * codebase already renders as an admitted guess, isn't a meaningful
 * simulation to run). Keyed by the exact CSS string `colorToCss` would
 * already produce for it — `VectorWorkspace.tsx`'s `renderShape` looks a
 * resolved fill/stroke's own `css` up in the softproof map by that same
 * string, no second colour-to-key encoding to keep in step with this one.
 */
export function collectSolidPaintColors(state: VectorDocumentState): Color[] {
  const seen = new Map<string, Color>();
  for (const shape of state.shapes) {
    for (const layer of [...shape.style.fills, ...shape.style.strokes]) {
      if (layer.paint.kind !== "color" || layer.paint.color.space !== "srgb") continue;
      const key = colorToCss(layer.paint.color);
      if (!seen.has(key)) seen.set(key, layer.paint.color);
    }
  }
  return [...seen.values()];
}
