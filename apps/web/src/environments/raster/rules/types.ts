import type { RasterDocumentState, RasterLayer, RasterRect } from "@vravio/env-raster";
import type { Rule } from "../../../rules/engine";

/**
 * What a raster rule gets to inspect and rewrite (stage 6 of
 * docs/migration-plan.md).
 *
 * This is exactly what `commitPixels` already received as arguments, named:
 * an edit is a before/after pair for one buffer, plus where it goes and what
 * to call it in history. Making it a value rather than six parameters is what
 * lets a rule return a changed one.
 */
export interface PixelEdit {
  /** The buffer as it was, canvas-sized. */
  readonly before: Uint8ClampedArray;
  /** The buffer as the tool would like it to be, canvas-sized. */
  readonly after: Uint8ClampedArray;
  readonly label: string;
  /** Whether this writes the layer's own pixels or the mask it is editing. */
  readonly target: "pixels" | "mask";
  readonly layerId: string;
  /** What actually changed, for the tile cache. `null` means "unbounded". */
  readonly bounds: RasterRect | null;
}

export interface RasterRuleContext {
  readonly document: RasterDocumentState;
  /**
   * The layer the edit is aimed at, resolved once by the engine's caller
   * rather than by each rule — four of the first five rules need it, and
   * looking it up per rule is four scans of the layer list per commit.
   */
  readonly layer: RasterLayer | null;
}

export type RasterRule = Rule<PixelEdit, RasterRuleContext>;

export interface RasterRuleModule {
  readonly default: RasterRule;
}
