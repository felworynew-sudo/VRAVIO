import type { BrushPreset } from "../types";

/** An angled flat tip: the roundness and angle together are what make it
 * calligraphic, which is why a preset is a set of options and not one. */
export default {
  id: "calligraphy",
  label: { en: "Calligraphy", ru: "Каллиграфия" },
  glyph: "▬",
  order: 30,
  options: { hardness: 100, roundness: 22, angle: -25 },
} satisfies BrushPreset as BrushPreset;
