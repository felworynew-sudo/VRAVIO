import type { ModifierDefinition, OffsetModifier } from "../types";

/** Delegates straight to Stage 8's `VectorCurvePort.offsetPath` — see that
 * port's own doc comment (`@vravio/kernel`) for why this is a lazily-loaded
 * WASM call rather than TS: Kurbo is this codebase's one implementation for
 * offset, not a reference one among several. */
export const offset: ModifierDefinition<OffsetModifier> = {
  kind: "offset",
  apply(d, modifier, context) {
    if (!context.curvePort) throw new Error("offset modifier requires a VectorCurvePort — none was provided in ModifierContext");
    return context.curvePort.offsetPath(d, modifier.amount, modifier.join, 0.1);
  },
};

export default offset;
