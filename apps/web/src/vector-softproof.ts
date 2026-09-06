import { useEffect, useState } from "react";
import { colorToCss, type AssetId } from "@vravio/kernel";
import { collectSolidPaintColors, type VectorDocumentState } from "@vravio/env-vector";
import { kernel } from "./kernel";
import { cmykToSrgb, srgbToCmyk } from "./vector-color-wasm";

/**
 * Stage 14 of docs/vector-plan.md: on-screen CMYK softproof — "show what
 * this sRGB colour would look like through a real ICC profile," not a
 * change to the document's own colours. Mirrors `vector-modifiers.ts`'s
 * `useModifierResults` on purpose (same cache-by-revision shape, same
 * "recompute once per edit, not once per frame, never block on it, fall
 * back to the real value until ready" contract) — that hook exists for the
 * exact same reason this one needs it: `srgbToCmyk`/`cmykToSrgb` are WASM
 * calls with no synchronous path, so a plain `useMemo` cannot serve them.
 *
 * Keyed by the exact CSS string `colorToCss` produces for the original
 * colour (`rgba(r, g, b, a)`) — `VectorWorkspace.tsx`'s `renderShape`
 * already has that string on hand for every resolved fill/stroke, so a
 * proofed replacement is one `Map.get` away, no second colour encoding to
 * keep in step with `collectSolidPaintColors`'s own key.
 */
export function useCmykSoftproof(state: VectorDocumentState, revision: number): ReadonlyMap<string, string> {
  const [proofed, setProofed] = useState<ReadonlyMap<string, string>>(new Map());

  useEffect(() => {
    if (!state.softproof || !state.cmykProfileAssetId) {
      setProofed(new Map());
      return;
    }
    let cancelled = false;
    void (async () => {
      const profileBytes = await kernel.assets.read(state.cmykProfileAssetId as AssetId);
      if (cancelled || !profileBytes) return;
      const colors = collectSolidPaintColors(state);
      const entries = await Promise.all(colors.map(async (color) => {
        const [r = 0, g = 0, b = 0] = color.components;
        const cmyk = await srgbToCmyk(r, g, b, profileBytes);
        if (!cmyk) return null;
        const proofedRgb = await cmykToSrgb(cmyk[0], cmyk[1], cmyk[2], cmyk[3], profileBytes);
        if (!proofedRgb) return null;
        const entry: readonly [string, string] = [colorToCss(color), `rgba(${proofedRgb[0]}, ${proofedRgb[1]}, ${proofedRgb[2]}, ${color.alpha})`];
        return entry;
      }));
      if (cancelled) return;
      setProofed(new Map(entries.filter((entry): entry is readonly [string, string] => entry !== null)));
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on revision exactly like useModifierResults, not on `state` itself
  }, [revision, state.softproof, state.cmykProfileAssetId]);

  return proofed;
}
