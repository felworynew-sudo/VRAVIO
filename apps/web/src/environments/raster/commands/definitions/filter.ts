import { CATEGORY_EDIT, CATEGORY_FILTER } from "../../../../commands/categories";
import { dispatch, isRasterActive } from "../../../../commands/shared";
import type { CommandDefinition } from "../../../../commands/types";

/**
 * Filters, and Free Transform beside them.
 *
 * Free Transform is filed under Edit, where Photoshop puts it, but it belongs
 * to the raster environment rather than the shell: it starts `raster.move`'s
 * pending transform, which no other environment has.
 */
const commands: readonly CommandDefinition[] = [
  {
    id: "filter.liquify",
    label: { en: "Liquify…", ru: "Пластика…" },
    category: CATEGORY_FILTER,
    shortcut: "Mod+Shift+X",
    surfaces: ["menu", "palette"],
    isEnabled: isRasterActive,
    execute: () => dispatch("vravio-liquify-open"),
  },
  {
    id: "edit.freeTransform",
    label: { en: "Free Transform", ru: "Свободная трансформация" },
    category: CATEGORY_EDIT,
    shortcut: "Mod+T",
    surfaces: ["menu", "palette", "canvas-context"],
    isEnabled: isRasterActive,
    execute: () => dispatch("vravio-transform-start"),
  },
];

export default commands;
