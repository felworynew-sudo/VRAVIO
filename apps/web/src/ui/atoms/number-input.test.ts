import { describe, expect, it } from "vitest";
import { applyDrag, applyStep, clampToSpec, formatNumber, parseNumericInput, stepFor } from "./number-input";

const pixels = { min: 1, max: 1000, step: 1, unit: "px", pixelsPerInch: 72 } as const;
const percent = { min: 0, max: 100, step: 1, unit: "%" } as const;
const angle = { min: -180, max: 180, step: 1, unit: "°" } as const;

describe("typing into a number field", () => {
  it("reads a plain number", () => {
    expect(parseNumericInput("42", pixels)).toBe(42);
    expect(parseNumericInput("  42  ", pixels)).toBe(42);
  });

  it("reads a decimal written with either separator", () => {
    // A Russian keyboard layout puts a comma where the decimal point is, and
    // typing one should not silently truncate the value.
    expect(parseNumericInput("1.5", { step: 0.1 })).toBe(1.5);
    expect(parseNumericInput("1,5", { step: 0.1 })).toBe(1.5);
  });

  it("reads a negative number", () => {
    expect(parseNumericInput("-90", angle)).toBe(-90);
  });

  it("keeps the old value rather than falling to zero on nonsense", () => {
    // Returning 0 here would quietly destroy whatever the field held the
    // moment a keystroke lands wrong.
    for (const raw of ["", "   ", "abc", "px", "--5"]) {
      expect(parseNumericInput(raw, pixels)).toBeNull();
    }
  });

  it("converts a typed length into pixels against the document resolution", () => {
    // 2cm at 72ppi = 2/2.54 inches * 72 = 56.69…, rounded to the step.
    expect(parseNumericInput("2cm", pixels)).toBe(57);
    expect(parseNumericInput("2 см", pixels)).toBe(57);
    expect(parseNumericInput("1in", pixels)).toBe(72);
    expect(parseNumericInput("1 дюйм", pixels)).toBe(72);
    expect(parseNumericInput("25.4mm", pixels)).toBe(72);
    expect(parseNumericInput("72pt", pixels)).toBe(72);
  });

  it("takes a pixel suffix as the number it already is", () => {
    expect(parseNumericInput("30px", pixels)).toBe(30);
    expect(parseNumericInput("30 пикс", pixels)).toBe(30);
  });

  it("converts against the resolution it is given, not a fixed one", () => {
    expect(parseNumericInput("1in", { ...pixels, max: 10000, pixelsPerInch: 300 })).toBe(300);
  });

  it("ignores a length suffix on a field that is not in pixels", () => {
    // Centimetres of an angle is not a quantity; taking the number and
    // dropping the suffix is the only reading that is not invented.
    expect(parseNumericInput("45cm", angle)).toBe(45);
    expect(parseNumericInput("50cm", percent)).toBe(50);
  });

  it("ignores a suffix when there is no resolution to convert against", () => {
    expect(parseNumericInput("2cm", { min: 0, max: 1000, step: 1, unit: "px" })).toBe(2);
  });

  it("clamps what was typed to the field's range", () => {
    expect(parseNumericInput("9999", pixels)).toBe(1000);
    expect(parseNumericInput("0", pixels)).toBe(1);
    expect(parseNumericInput("-500", angle)).toBe(-180);
  });
});

describe("stepping with arrows, the wheel and modifiers", () => {
  it("moves by one step either way", () => {
    expect(applyStep(50, 1, pixels)).toBe(51);
    expect(applyStep(50, -1, pixels)).toBe(49);
  });

  it("moves ten times as far with Shift, a tenth with Alt", () => {
    // Photoshop's convention, and the reason both live in stepFor rather
    // than in each event handler: a wheel notch and an arrow press must not
    // drift apart on what one step means.
    expect(stepFor(pixels)).toBe(1);
    expect(stepFor(pixels, { shiftKey: true })).toBe(10);
    expect(stepFor(pixels, { altKey: true })).toBe(0.1);
    expect(applyStep(50, 1, pixels, { shiftKey: true })).toBe(60);
    expect(applyStep(50, -1, pixels, { altKey: true })).toBe(49.9);
  });

  it("respects a field's own step", () => {
    expect(applyStep(2, 1, { step: 0.25 })).toBe(2.25);
    expect(applyStep(2, 1, { step: 0.25 }, { shiftKey: true })).toBe(4.5);
  });

  it("stops at the ends of the range instead of running past them", () => {
    expect(applyStep(1000, 1, pixels)).toBe(1000);
    expect(applyStep(1, -1, pixels)).toBe(1);
  });

  it("does not accumulate float dust over repeated fine steps", () => {
    // Ten Alt-steps of 0.1 has to land on exactly 51, not 50.99999999999999.
    let value = 50;
    for (let index = 0; index < 10; index += 1) value = applyStep(value, 1, pixels, { altKey: true });
    expect(value).toBe(51);
  });
});

describe("scrubbing by dragging", () => {
  it("increases upward and decreases downward", () => {
    // Screen Y grows downward, so dragging up is a negative delta.
    expect(applyDrag(50, -10, pixels)).toBe(60);
    expect(applyDrag(50, 10, pixels)).toBe(40);
  });

  it("scales with the same modifiers as the arrows", () => {
    expect(applyDrag(50, -10, pixels, { shiftKey: true })).toBe(150);
    expect(applyDrag(50, -10, pixels, { altKey: true })).toBe(51);
  });

  it("measures from where the drag started, not from the previous frame", () => {
    // Frame-by-frame accumulation lets rounding drift until the number no
    // longer matches where the pointer is; measuring from the start means a
    // drag out and back returns to exactly the value it began on.
    const start = 50;
    expect(applyDrag(start, -30, pixels)).toBe(80);
    expect(applyDrag(start, 0, pixels)).toBe(50);
  });

  it("clamps to the range while dragging", () => {
    expect(applyDrag(990, -100, pixels)).toBe(1000);
    expect(applyDrag(10, 100, pixels)).toBe(1);
  });
});

describe("clamping and formatting", () => {
  it("leaves a value inside the range alone", () => {
    expect(clampToSpec(50, pixels)).toBe(50);
  });

  it("treats a missing bound as no bound", () => {
    expect(clampToSpec(-9999, { max: 10 })).toBe(-9999);
    expect(clampToSpec(9999, { min: 0 })).toBe(9999);
  });

  it("shows a value at the precision its step implies", () => {
    expect(formatNumber(50, pixels)).toBe("50");
    expect(formatNumber(50.04, pixels)).toBe("50");
    expect(formatNumber(2.25, { step: 0.25 })).toBe("2.25");
  });
});
