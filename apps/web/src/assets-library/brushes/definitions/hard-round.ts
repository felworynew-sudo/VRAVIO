import type { BrushPreset } from "../types";

export default {
  id: "hard-round",
  label: { en: "Hard Round", ru: "Жёсткая круглая" },
  glyph: "●",
  order: 10,
  options: { hardness: 100, roundness: 100 },
} satisfies BrushPreset as BrushPreset;
