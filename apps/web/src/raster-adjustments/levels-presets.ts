import type { RasterAdjustment } from "@vravio/env-raster";

export interface LevelsPreset {
  readonly id: string;
  readonly name: { readonly en: string; readonly ru: string };
  /** `null` for "По умолчанию" (identity — the dialog's own opening state)
   *  and "Заказная" (not a real preset, shown when nothing else matches). */
  readonly points: Omit<RasterAdjustment & { kind: "levels" }, "kind" | "channels"> | null;
}

/**
 * Photoshop's own preset names, in the Набор dropdown's own order (screenshot
 * 3). The numeric points behind each one are not Adobe's exact shipped .alv
 * values — those aren't published anywhere this session could verify, and
 * guessing at four-decimal precision and presenting it as Adobe's own data
 * would be worse than admitting it is an approximation. Each preset still
 * does something real and distinct when selected (rule: no control that sits
 * there doing nothing) — a consistent, disclosed family of stretch/gamma
 * shifts named the way Photoshop names them, not a byte-for-byte replica.
 */
export const levelsPresets: readonly LevelsPreset[] = [
  { id: "default", name: { en: "Default", ru: "По умолчанию" }, points: null },
  { id: "darker", name: { en: "Darker", ru: "Темнее" }, points: { blackInput: 0, gamma: 1, whiteInput: 255, blackOutput: 0, whiteOutput: 200 } },
  { id: "increaseContrast1", name: { en: "Increase Contrast 1", ru: "Увеличение контрастности 1" }, points: { blackInput: 15, gamma: 1, whiteInput: 240, blackOutput: 0, whiteOutput: 255 } },
  { id: "increaseContrast2", name: { en: "Increase Contrast 2", ru: "Увеличение контрастности 2" }, points: { blackInput: 30, gamma: 1, whiteInput: 225, blackOutput: 0, whiteOutput: 255 } },
  { id: "increaseContrast3", name: { en: "Increase Contrast 3", ru: "Увеличение контрастности 3" }, points: { blackInput: 45, gamma: 1, whiteInput: 210, blackOutput: 0, whiteOutput: 255 } },
  { id: "highlightShadows", name: { en: "Highlight Shadows", ru: "Подсветка теней" }, points: { blackInput: 0, gamma: 1, whiteInput: 255, blackOutput: 40, whiteOutput: 255 } },
  { id: "lighter", name: { en: "Lighter", ru: "Светлее" }, points: { blackInput: 0, gamma: 1.3, whiteInput: 255, blackOutput: 0, whiteOutput: 255 } },
  { id: "brighterMidtones", name: { en: "Brighter Midtones", ru: "Более яркие средние тона" }, points: { blackInput: 0, gamma: 1.4, whiteInput: 255, blackOutput: 0, whiteOutput: 255 } },
  { id: "darkerMidtones", name: { en: "Darker Midtones", ru: "Более темные средние тона" }, points: { blackInput: 0, gamma: 0.7, whiteInput: 255, blackOutput: 0, whiteOutput: 255 } },
];

const IDENTITY: Omit<RasterAdjustment & { kind: "levels" }, "kind" | "channels"> = { blackInput: 0, gamma: 1, whiteInput: 255, blackOutput: 0, whiteOutput: 255 };

/** Which preset (if any) `value`'s own master points currently match exactly — "Заказная" (Custom) when none does, matching Photoshop's own dropdown behaviour of falling back to Custom the moment a slider moves off a preset's values. */
export function matchingLevelsPreset(value: RasterAdjustment & { kind: "levels" }): string {
  if (value.channels) return "custom";
  for (const preset of levelsPresets) {
    const points = preset.points ?? IDENTITY;
    if (points.blackInput === value.blackInput && points.gamma === value.gamma && points.whiteInput === value.whiteInput && points.blackOutput === value.blackOutput && points.whiteOutput === value.whiteOutput) return preset.id;
  }
  return "custom";
}

export function applyLevelsPreset(id: string): (RasterAdjustment & { kind: "levels" }) | null {
  const preset = levelsPresets.find((entry) => entry.id === id);
  if (!preset) return null;
  return { kind: "levels", ...(preset.points ?? IDENTITY) };
}
