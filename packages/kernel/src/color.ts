import type { AssetId } from "./asset-store";

/**
 * A colour that can be more than three sRGB bytes.
 *
 * The vector environment used to store colour as a plain `"#rrggbb"` string,
 * which is exactly one thing: an opaque sRGB triple. A user who asked for
 * CMYK support (docs/vector-plan.md §7.3) cannot get it from a string — there
 * is nowhere to put "this is 40% cyan" or "this came from a Pantone swatch
 * with this ICC profile" inside six hex digits. So colour becomes a small
 * structure instead, and it lives here in the kernel rather than in the
 * vector package, because the raster environment needs the exact same
 * upgrade (`docs/requirements.md`'s RASTER-COLOR-002) and a second,
 * incompatible colour type on that side would mean a permanent translation
 * layer between two environments that are supposed to share one document
 * model's worth of concepts.
 *
 * What this file does NOT do is colour management. Converting `cmyk` or
 * `lab` into something a screen can show correctly — with an ICC profile,
 * rendering intent, the works — is docs/vector-plan.md's stage 14, a real
 * project of its own. `colorToCss` below does the honest, naive conversion
 * so nothing crashes or renders as black in the meantime, and says so.
 */
export type ColorSpace = "srgb" | "cmyk" | "gray" | "lab" | "spot";

export interface Color {
  readonly space: ColorSpace;
  /**
   * Channel values, meaning fixed by `space`:
   * srgb → [r, g, b] each 0..255; gray → [k] 0..255 (not 0..1 — sharing the
   * 0..255 convention with srgb means a `gray` swatch converts to `srgb` by
   * repeating one number three times, not by scaling); cmyk → [c, m, y, k]
   * each 0..1; lab → [l, a, b] as CIE L*a*b*; spot → [] (the swatch has no
   * components of its own — `profile` names an asset holding what it means).
   */
  readonly components: readonly number[];
  /** An ICC profile or spot-colour definition sitting in the asset store —
   * never the profile bytes themselves, the same "reference, not a copy"
   * shape asset-backed image shapes already use. */
  readonly profile?: AssetId;
  readonly alpha: number;
}

export const srgb = (r: number, g: number, b: number, alpha = 1): Color => ({ space: "srgb", components: [r, g, b], alpha });

/** sRGB byte for a naive CMYK conversion — accurate for nothing in particular, honest about it. */
const cmykToSrgbByte = (channel: number, k: number): number => Math.round(255 * (1 - Math.min(1, channel)) * (1 - Math.min(1, k)));

/**
 * A colour as a CSS colour string, for feeding straight to a `fill`/`stroke`
 * SVG attribute or a canvas 2D context's `fillStyle`/`strokeStyle`.
 *
 * `srgb` and `gray` round-trip exactly — they are already display colour.
 * `cmyk` uses the textbook `(1-c)(1-k)` formula, which is what "CMYK" means
 * to a viewer with no ICC profile in the loop; it is not what a print shop's
 * profile would produce; stage 14 replaces this branch, not the function's
 * signature. `lab` and `spot` fall back to mid-grey rather than guessing —
 * silently rendering the wrong colour is worse than visibly rendering none.
 */
export function colorToCss(color: Color): string {
  const a = color.alpha;
  if (color.space === "srgb") {
    const [r = 0, g = 0, b = 0] = color.components;
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }
  if (color.space === "gray") {
    const [k = 0] = color.components;
    return `rgba(${k}, ${k}, ${k}, ${a})`;
  }
  if (color.space === "cmyk") {
    const [c = 0, m = 0, y = 0, k = 0] = color.components;
    return `rgba(${cmykToSrgbByte(c, k)}, ${cmykToSrgbByte(m, k)}, ${cmykToSrgbByte(y, k)}, ${a})`;
  }
  // lab, spot: no honest sRGB answer without a profile (stage 14). Mid-grey
  // marks "a colour is here and this project cannot show it yet" rather than
  // quietly rendering black, which would look like a bug in the shape itself.
  return `rgba(128, 128, 128, ${a})`;
}

/** Parses a CSS colour string back into an sRGB `Color` — the other half of
 * the bridge to `<input type="color">`, which only speaks `#rrggbb`, and to
 * every colour string a v2 document has stored before this migration. */
export function cssToColor(css: string): Color {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(css.trim());
  if (hex) {
    const value = hex[1]!;
    const full = value.length === 3 ? [...value].map((ch) => ch + ch).join("") : value;
    const r = Number.parseInt(full.slice(0, 2), 16), g = Number.parseInt(full.slice(2, 4), 16), b = Number.parseInt(full.slice(4, 6), 16);
    return srgb(r, g, b);
  }
  const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(css.trim());
  if (rgb) return srgb(Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] !== undefined ? Number(rgb[4]) : 1);
  // An unrecognised string (a named colour like "red", or garbage) becomes
  // opaque black rather than throwing — the same "never let a cosmetic
  // failure block the document" posture as the rest of this codebase's
  // migrations, and it is visibly wrong rather than invisibly wrong.
  return srgb(0, 0, 0);
}

/** For `<input type="color">`, which accepts and returns only `#rrggbb` —
 * never alpha, never another colour space. Non-srgb colours are converted
 * through `colorToCss`'s same naive path so the swatch shown while editing
 * matches what the shape actually renders. */
export function colorToHex(color: Color): string {
  if (color.space === "srgb") {
    const [r = 0, g = 0, b = 0] = color.components;
    return `#${[r, g, b].map((channel) => Math.round(Math.max(0, Math.min(255, channel))).toString(16).padStart(2, "0")).join("")}`;
  }
  const css = colorToCss(color);
  const rgb = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/.exec(css)!;
  return colorToHex(srgb(Number(rgb[1]), Number(rgb[2]), Number(rgb[3])));
}
