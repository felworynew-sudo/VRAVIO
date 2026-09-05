import type { ModifierDefinition, SimplifyModifier } from "../types";

/** Delegates to Stage 8's `VectorCurvePort.simplifyPath` — see that port's
 * own doc comment, and its `simplify_path` Rust implementation's, for the
 * honest limits of what "simplify" actually reduces (genuine redundant
 * points, not a many-sided polygon someone drew — or a boolean op
 * flattened — on purpose). */
export const simplify: ModifierDefinition<SimplifyModifier> = {
  kind: "simplify",
  apply(d, modifier, context) {
    if (!context.curvePort) throw new Error("simplify modifier requires a VectorCurvePort — none was provided in ModifierContext");
    return context.curvePort.simplifyPath(d, modifier.accuracy);
  },
};

export default simplify;
