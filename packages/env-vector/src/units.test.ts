import { describe, expect, it } from "vitest";
import { formatLength, fromPixels, parseLength, toPixels } from "./units";

describe("units", () => {
  it("at 72 ppi, an inch is 72 pixels and a point is one pixel — the textbook anchor values", () => {
    expect(toPixels(1, "in", 72)).toBe(72);
    expect(toPixels(1, "pt", 72)).toBe(1);
  });

  it("25.4mm and 1in are the same length", () => {
    expect(toPixels(25.4, "mm", 96)).toBeCloseTo(toPixels(1, "in", 96), 6);
  });

  it("10cm is ten times 1cm", () => {
    expect(toPixels(10, "cm", 300)).toBeCloseTo(toPixels(1, "cm", 300) * 10, 6);
  });

  it("toPixels and fromPixels round-trip for every unit", () => {
    for (const unit of ["px", "mm", "cm", "in", "pt"] as const) {
      const px = 237.5;
      expect(toPixels(fromPixels(px, unit, 150), unit, 150)).toBeCloseTo(px, 6);
    }
  });

  it("parses a Latin unit suffix", () => {
    expect(parseLength("0.5in", 72)).toBeCloseTo(36, 6);
  });

  it("parses the Cyrillic unit suffixes the interface's own language uses", () => {
    expect(parseLength("10мм", 72)).toBeCloseTo(toPixels(10, "mm", 72), 6);
    expect(parseLength("2см", 72)).toBeCloseTo(toPixels(2, "cm", 72), 6);
    expect(parseLength("3дюйм", 72)).toBeCloseTo(toPixels(3, "in", 72), 6);
  });

  it("a bare number without a unit uses the caller's fallback unit, not always px", () => {
    // "50" in a field showing millimetres means fifty millimetres — the bug
    // this guards against is a units-blind field quietly storing 50px instead.
    expect(parseLength("50", 72, "mm")).toBeCloseTo(toPixels(50, "mm", 72), 6);
    expect(parseLength("50", 72, "px")).toBe(50);
  });

  it("accepts a comma decimal separator", () => {
    expect(parseLength("1,5in", 72)).toBeCloseTo(108, 6);
  });

  it("rejects an unrecognised unit and non-numeric input instead of guessing", () => {
    expect(parseLength("10furlongs", 72)).toBeNull();
    expect(parseLength("abc", 72)).toBeNull();
    expect(parseLength("", 72)).toBeNull();
  });

  it("formats px rounded to a whole number and physical units to two decimals", () => {
    expect(formatLength(100.6, "px", 72)).toBe("101px");
    expect(formatLength(toPixels(10, "mm", 72), "mm", 72)).toBe("10.00mm");
  });

  it("parseLength and formatLength agree: formatting a parsed value and re-parsing it returns the same pixel count", () => {
    const px = parseLength("42.5mm", 96)!;
    const formatted = formatLength(px, "mm", 96);
    expect(parseLength(formatted, 96)).toBeCloseTo(px, 3);
  });
});
