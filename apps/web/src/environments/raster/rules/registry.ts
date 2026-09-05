import { applyRules, type RuleOutcome } from "../../../rules/engine";
import type { PixelEdit, RasterRule, RasterRuleContext, RasterRuleModule } from "./types";

/**
 * Every rule file under `definitions/`, collected without a hand-kept list —
 * the same `import.meta.glob` mechanism the tool and adjustment catalogues
 * already use. A new rule is a new file, and nothing else.
 */
const modules = import.meta.glob<RasterRuleModule>("./definitions/*.ts", { eager: true });

export const rasterRules: readonly RasterRule[] = Object.values(modules).map((module) => module.default);

/** Runs every raster rule over one edit. The single call site is `commitPixels`. */
export function applyRasterRules(edit: PixelEdit, context: RasterRuleContext): RuleOutcome<PixelEdit> {
  return applyRules(rasterRules, edit, context);
}
