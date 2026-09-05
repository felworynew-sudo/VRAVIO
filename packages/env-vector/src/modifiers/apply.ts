import { basePathFor } from "./base-path";
import { modifierRegistry } from "./registry";
import type { GeometryModifier, ModifierContext } from "./types";
import type { VectorShape } from "../types";

/**
 * The whole stack, run in order, starting from the shape's own base
 * outline — this is the one function that turns "a rectangle plus a list
 * of modifiers" into "the path that actually gets drawn." Always async
 * (`Promise<string | null>`) even though some modifiers are sync, since a
 * mixed stack (round corners, then offset) has to await the WASM step
 * partway through regardless of what came before it.
 *
 * Returns `null` for a shape kind `basePathFor` has no outline for
 * (`line`/`text`/`group`/`image`) — a modifier stack on one of those is
 * simply inert, not an error, since nothing in this package's own
 * validation currently stops the UI from adding one.
 */
export async function applyModifierStack(shape: VectorShape, modifiers: readonly GeometryModifier[], context: ModifierContext = {}): Promise<string | null> {
  const base = basePathFor(shape);
  if (base === null) return null;
  let current = base;
  for (const modifier of modifiers) {
    if (!modifier.enabled) continue;
    const definition = modifierRegistry.find((entry) => entry.kind === modifier.kind);
    if (!definition) continue;
    current = await definition.apply(current, modifier, context);
  }
  return current;
}
