import booleanModifier from "./kinds/boolean";
import offset from "./kinds/offset";
import roundCorners from "./kinds/round-corners";
import simplify from "./kinds/simplify";
import zigzag from "./kinds/zigzag";
import type { GeometryModifier, ModifierDefinition } from "./types";

/** Every modifier kind, listed by hand — see `types.ts`'s own doc comment
 * for why (same reason as `snapping/registry.ts`). Adding a new kind is
 * "write the file in `./kinds`, add one line here," not a branch in a
 * switch statement. */
export const modifierRegistry: readonly ModifierDefinition<GeometryModifier>[] = [
  roundCorners as ModifierDefinition<GeometryModifier>,
  offset as ModifierDefinition<GeometryModifier>,
  simplify as ModifierDefinition<GeometryModifier>,
  zigzag as ModifierDefinition<GeometryModifier>,
  booleanModifier as ModifierDefinition<GeometryModifier>,
];
