import type { BrushPreset } from "../types";

export default {
  id: "soft-round",
  label: { en: "Soft Round", ru: "Мягкая круглая" },
  glyph: "◉",
  order: 20,
  options: { hardness: 0, roundness: 100 },
} satisfies BrushPreset as BrushPreset;
