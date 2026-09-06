import { describe, expect, it } from "vitest";
import { layoutText } from "./vector-text-wasm";

/**
 * Stage 11 of docs/vector-plan.md: "text stops being a string with a made-
 * up width" — real shaping/layout via Parley/HarfRust (`crates/vector-text`)
 * against the real compiled `.wasm`, not a mocked-out stand-in. See that
 * crate's own doc comment for this pass's honest scope: real shaping,
 * line-breaking, bidi, and one complex script proven working — not the
 * full stage (text-in-frame/on-path UI wiring, interactive cursor/
 * selection, and text-to-curves are none of them built on top of this yet).
 */
describe("layoutText — real shaping via Parley/HarfRust", () => {
  it("measures a real, non-trivial width and height for plain Latin text", async () => {
    const result = await layoutText("AVAV Test", 24, 0, "latin");
    expect(result.width).toBeGreaterThan(50);
    expect(result.height).toBeGreaterThan(10);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]!.glyphs).toHaveLength(9); // one per character, including the space
  });

  it("kerning changes the measured width — it isn't a per-character sum", async () => {
    // Same character count, same font size: "AV" pairs kern tighter than "AA" pairs in any real
    // font with kerning tables. A naive "width = charCount * someConstant" measurer would give
    // these two the exact same width; real shaping does not.
    const avRun = await layoutText("AVAVAVAVAV", 40, 0, "latin");
    const aaRun = await layoutText("AAAAAAAAAA", 40, 0, "latin");
    expect(avRun.width).not.toBeCloseTo(aaRun.width, 0);
  });

  it("wraps a long line into multiple lines that each fit within maxWidth", async () => {
    const result = await layoutText("The quick brown fox jumps over the lazy dog", 20, 100, "latin");
    expect(result.lines.length).toBeGreaterThan(1);
    for (const line of result.lines) expect(line.width).toBeLessThanOrEqual(100.5); // .5 slack for floating-point rounding, not a real overflow allowance
  });

  it("maxWidth 0 means unbounded — one line regardless of length", async () => {
    const result = await layoutText("The quick brown fox jumps over the lazy dog", 20, 0, "latin");
    expect(result.lines).toHaveLength(1);
  });

  it("is non-vacuous: a tighter maxWidth produces more lines than a looser one for the same text", async () => {
    const loose = await layoutText("The quick brown fox jumps over the lazy dog", 20, 300, "latin");
    const tight = await layoutText("The quick brown fox jumps over the lazy dog", 20, 60, "latin");
    expect(tight.lines.length).toBeGreaterThan(loose.lines.length);
  });

  it("shapes Arabic text — real glyph positions, not an empty or single-glyph fallback", async () => {
    const result = await layoutText("مرحبا بالعالم", 24, 0, "arabic");
    expect(result.lines[0]!.glyphs.length).toBeGreaterThan(5);
    expect(result.width).toBeGreaterThan(30);
    // Every glyph has a distinct x — proof this actually shaped positions
    // rather than stacking every glyph at the origin.
    const xs = new Set(result.lines[0]!.glyphs.map((glyph) => glyph.x));
    expect(xs.size).toBe(result.lines[0]!.glyphs.length);
  });

  it("shapes Devanagari text without crashing, with a real measured width", async () => {
    const result = await layoutText("नमस्ते दुनिया", 24, 0, "devanagari");
    expect(result.lines[0]!.glyphs.length).toBeGreaterThan(3);
    expect(result.width).toBeGreaterThan(30);
  });

  it("line text ranges partition the original string's byte offsets without gaps or overlaps", async () => {
    const text = "one two three four five six seven";
    const result = await layoutText(text, 16, 60, "latin");
    expect(result.lines.length).toBeGreaterThan(1);
    expect(result.lines[0]!.textStart).toBe(0);
    for (let i = 1; i < result.lines.length; i += 1) expect(result.lines[i]!.textStart).toBe(result.lines[i - 1]!.textEnd);
    expect(result.lines[result.lines.length - 1]!.textEnd).toBe(text.length);
  });
});
