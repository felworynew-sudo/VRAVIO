import type { RgbaColor } from "./types";

export function parseHexColor(hex: string): RgbaColor {
  const value = hex.trim().replace(/^#/, "");
  if (!/^[\da-f]{6}([\da-f]{2})?$/i.test(value)) throw new Error(`Invalid hex color: ${hex}`);
  return { r: Number.parseInt(value.slice(0, 2), 16), g: Number.parseInt(value.slice(2, 4), 16), b: Number.parseInt(value.slice(4, 6), 16), a: value.length === 8 ? Number.parseInt(value.slice(6, 8), 16) : 255 };
}

export function toHexColor(color: RgbaColor): string {
  const hex = (value: number) => Math.round(Math.max(0, Math.min(255, value))).toString(16).padStart(2, "0");
  return `#${hex(color.r)}${hex(color.g)}${hex(color.b)}`;
}
