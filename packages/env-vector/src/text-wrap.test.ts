import { describe, expect, it } from "vitest";
import { wrapText } from "./text-wrap";

/** A fake measurer with a fixed, predictable per-character width, so tests
 * can reason about exact wrap points without a real font/canvas. */
function fixedWidthMeasurer(charWidth: number) {
  return { measure: (value: string) => ({ width: value.length * charWidth, ascent: 10, descent: 3 }) };
}

describe("wrapText (stage 11's text-in-frame)", () => {
  it("does not wrap when everything fits within the frame", () => {
    const lines = wrapText("short line", "Arial", 16, 1000, fixedWidthMeasurer(5));
    expect(lines).toEqual(["short line"]);
  });

  it("wraps onto a new line once the next word would overflow the frame", () => {
    // Each char is 10 units wide. "one two" is 7 chars = 70; "one two three" is 13 chars = 130.
    const lines = wrapText("one two three", "Arial", 16, 80, fixedWidthMeasurer(10));
    expect(lines).toEqual(["one two", "three"]);
  });

  it("never drops a word — every word from the input appears in the output", () => {
    const text = "the quick brown fox jumps over the lazy dog";
    const lines = wrapText(text, "Arial", 16, 50, fixedWidthMeasurer(8));
    expect(lines.join(" ")).toBe(text);
  });

  it("a single word wider than the frame still gets its own line rather than being split mid-word", () => {
    const lines = wrapText("supercalifragilisticexpialidocious short", "Arial", 16, 30, fixedWidthMeasurer(10));
    expect(lines[0]).toBe("supercalifragilisticexpialidocious");
    expect(lines[1]).toBe("short");
  });

  it("respects existing newlines as hard paragraph breaks, wrapping each paragraph independently", () => {
    const lines = wrapText("first paragraph here\nsecond one", "Arial", 16, 1000, fixedWidthMeasurer(5));
    expect(lines).toEqual(["first paragraph here", "second one"]);
  });

  it("a tighter frame produces more lines than a looser one for the same text — non-vacuous", () => {
    const text = "one two three four five six seven eight";
    const tight = wrapText(text, "Arial", 16, 40, fixedWidthMeasurer(10));
    const loose = wrapText(text, "Arial", 16, 200, fixedWidthMeasurer(10));
    expect(tight.length).toBeGreaterThan(loose.length);
  });

  it("an empty string produces one empty line, not zero lines", () => {
    expect(wrapText("", "Arial", 16, 100, fixedWidthMeasurer(10))).toEqual([""]);
  });
});
