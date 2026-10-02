import type { RasterBlendMode } from "@vravio/env-raster";

/**
 * Photoshop's blend modes, in Photoshop's own menu order and with its own
 * names, plus the neutral colour each one has.
 *
 * The order is not alphabetical and not the engine's: it is the order of the
 * dropdown in Photoshop, where the modes are grouped by what they do (darken,
 * lighten, contrast, comparative, composite) with a separator between groups.
 * The engine's own union in `types.ts` already happens to follow it.
 *
 * `neutral` is the colour that this mode leaves the backdrop untouched when
 * blended over it — white for the darkening modes, black for the lightening
 * ones, 50% grey for the contrast ones, and `null` for the modes that have no
 * such colour at all. It is what Photoshop's New Layer dialog offers to
 * pre-fill a layer with ("Fill with Overlay-neutral color (50% gray)"), so
 * that a dodge-and-burn or sharpening layer starts out invisible and can be
 * painted into. Adobe documents the exclusions, and they match what the
 * arithmetic says: Normal, Dissolve, Hard Mix, Hue, Saturation, Color and
 * Luminosity have no neutral colour.
 *
 * Not a claim taken on trust: `new-layer.test.ts` composites a layer of each
 * declared neutral colour over a real picture through this project's own
 * compositor and fails if the picture changes.
 */
export interface BlendModeEntry {
  readonly id: RasterBlendMode;
  readonly en: string;
  readonly ru: string;
  /** A hex colour this mode blends as a no-op, or null when it has none. */
  readonly neutral: "#ffffff" | "#000000" | "#808080" | null;
  /** True where Photoshop draws a separator line above the entry. */
  readonly groupStart?: true;
}

export const BLEND_MODES: readonly BlendModeEntry[] = [
  { id: "normal", en: "Normal", ru: "Нормальный", neutral: null },
  { id: "dissolve", en: "Dissolve", ru: "Затухание", neutral: null },

  { id: "darken", en: "Darken", ru: "Затемнение", neutral: "#ffffff", groupStart: true },
  { id: "multiply", en: "Multiply", ru: "Умножение", neutral: "#ffffff" },
  { id: "colorBurn", en: "Color Burn", ru: "Затемнение основы", neutral: "#ffffff" },
  { id: "linearBurn", en: "Linear Burn", ru: "Линейный затемнитель", neutral: "#ffffff" },
  { id: "darkerColor", en: "Darker Color", ru: "Темнее", neutral: "#ffffff" },

  { id: "lighten", en: "Lighten", ru: "Замена светлым", neutral: "#000000", groupStart: true },
  { id: "screen", en: "Screen", ru: "Экран", neutral: "#000000" },
  { id: "colorDodge", en: "Color Dodge", ru: "Осветление основы", neutral: "#000000" },
  { id: "linearDodge", en: "Linear Dodge (Add)", ru: "Линейный осветлитель", neutral: "#000000" },
  { id: "lighterColor", en: "Lighter Color", ru: "Светлее", neutral: "#000000" },

  { id: "overlay", en: "Overlay", ru: "Перекрытие", neutral: "#808080", groupStart: true },
  { id: "softLight", en: "Soft Light", ru: "Мягкий свет", neutral: "#808080" },
  { id: "hardLight", en: "Hard Light", ru: "Жёсткий свет", neutral: "#808080" },
  { id: "vividLight", en: "Vivid Light", ru: "Яркий свет", neutral: "#808080" },
  { id: "linearLight", en: "Linear Light", ru: "Линейный свет", neutral: "#808080" },
  { id: "pinLight", en: "Pin Light", ru: "Точечный свет", neutral: "#808080" },
  // Hard Mix pushes every channel to 0 or 255, so nothing is neutral in it —
  // Adobe lists it among the modes the fill is not offered for.
  { id: "hardMix", en: "Hard Mix", ru: "Жёсткое смешение", neutral: null },

  { id: "difference", en: "Difference", ru: "Разница", neutral: "#000000", groupStart: true },
  { id: "exclusion", en: "Exclusion", ru: "Исключение", neutral: "#000000" },
  { id: "subtract", en: "Subtract", ru: "Вычитание", neutral: "#000000" },
  { id: "divide", en: "Divide", ru: "Разделить", neutral: "#ffffff" },

  { id: "hue", en: "Hue", ru: "Цветовой тон", neutral: null, groupStart: true },
  { id: "saturation", en: "Saturation", ru: "Насыщенность", neutral: null },
  { id: "color", en: "Color", ru: "Цветность", neutral: null },
  { id: "luminosity", en: "Luminosity", ru: "Яркость", neutral: null },
];

export const blendModeById = new Map(BLEND_MODES.map((entry) => [entry.id, entry]));

/** What Photoshop writes in the checkbox's own label for a neutral colour. */
export const neutralColorName = (neutral: BlendModeEntry["neutral"]): { en: string; ru: string } =>
  neutral === "#ffffff" ? { en: "white", ru: "белый" }
    : neutral === "#000000" ? { en: "black", ru: "чёрный" }
      : neutral === "#808080" ? { en: "50% gray", ru: "50% серого" }
        : { en: "none", ru: "нет" };
