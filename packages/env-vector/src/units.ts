/**
 * Length units, and the one thing they all have to agree on: how many pixels
 * an inch is, for this document.
 *
 * Storage stays in pixels (docs/vector-plan.md §7.2) — the same unit the
 * raster environment's buffers use, so an image shape's `pixelAssetId`
 * reference needs no unit translation at the round-trip boundary. What the
 * user sees and types can be anything; `resolution` (pixels per inch) is the
 * one number that lets `10мм` and `500px` both mean something on the same
 * document.
 *
 * A change to a document's own `resolution` changes what every stored pixel
 * coordinate now means in physical terms — the same "Image Size" trade-off
 * the raster environment already has. Nothing in this file makes that
 * decision; it only does the arithmetic once resolution is known, so the UI
 * that lets someone change resolution can ask explicitly (rescale the
 * numbers, or reinterpret them) instead of that choice being made by
 * accident inside a conversion helper.
 */
export type LengthUnit = "px" | "mm" | "cm" | "in" | "pt";

const MM_PER_INCH = 25.4;
const PT_PER_INCH = 72;

export function toPixels(value: number, unit: LengthUnit, ppi: number): number {
  if (unit === "px") return value;
  if (unit === "in") return value * ppi;
  if (unit === "mm") return (value / MM_PER_INCH) * ppi;
  if (unit === "cm") return (value / (MM_PER_INCH / 10)) * ppi;
  return (value / PT_PER_INCH) * ppi; // pt
}

export function fromPixels(px: number, unit: LengthUnit, ppi: number): number {
  if (unit === "px") return px;
  if (unit === "in") return px / ppi;
  if (unit === "mm") return (px / ppi) * MM_PER_INCH;
  if (unit === "cm") return (px / ppi) * (MM_PER_INCH / 10);
  return (px / ppi) * PT_PER_INCH; // pt
}

/** Unit suffixes recognised on input, Cyrillic first because that is what the
 * interface's own language shows the user — see App.tsx's `логотип …svg`
 * strings and the rest of this UI's Russian-first labels. Longer suffixes
 * before shorter ones so "мм" is not swallowed by a hypothetical "м". */
const UNIT_ALIASES: readonly (readonly [string, LengthUnit])[] = [
  ["мм", "mm"], ["см", "cm"], ["дюйм", "in"], ["пт", "pt"],
  ["mm", "mm"], ["cm", "cm"], ["in", "in"], ["pt", "pt"], ["px", "px"],
  ["\"", "in"], ["″", "in"],
];

/**
 * Parses user input like `10мм`, `0.5in`, `12pt`, or a bare `3` (which takes
 * `fallbackUnit` — normally the document's current display unit, so typing
 * "50" into a field showing millimetres means fifty millimetres, not fifty
 * pixels). Returns pixels, ready to store. `null` for input that is not a
 * number at all, so a caller can reject it rather than silently store zero.
 */
export function parseLength(input: string, ppi: number, fallbackUnit: LengthUnit = "px"): number | null {
  const trimmed = input.trim().replace(",", "."); // a comma decimal separator, common in ru locale number entry
  const match = /^(-?\d*\.?\d+)\s*([a-zа-я"″]*)$/i.exec(trimmed);
  if (!match) return null;
  const value = Number.parseFloat(match[1]!);
  if (!Number.isFinite(value)) return null;
  const suffix = match[2]!.toLowerCase();
  if (!suffix) return toPixels(value, fallbackUnit, ppi);
  const alias = UNIT_ALIASES.find(([key]) => key === suffix);
  if (!alias) return null;
  return toPixels(value, alias[1], ppi);
}

/** The inverse of `parseLength` for display: pixels round to whole numbers
 * (sub-pixel document coordinates are not meaningful on screen), physical
 * units keep two decimal places (a millimetre field showing "10" when the
 * true value is 10.3 would silently drift on repeated round-trips). */
export function formatLength(px: number, unit: LengthUnit, ppi: number): string {
  const value = fromPixels(px, unit, ppi);
  return unit === "px" ? `${Math.round(value)}${unit}` : `${value.toFixed(2)}${unit}`;
}
