import { describe, expect, it } from "vitest";
import { subpathsToPoints } from "@vravio/env-vector";
import { layoutText, textToCurves } from "./vector-text-wasm";

/**
 * Stage 11 of docs/vector-plan.md: "text stops being a string with a made-
 * up width" — real shaping/layout via Parley/HarfRust (`crates/vector-text`)
 * against the real compiled `.wasm`, not a mocked-out stand-in. See that
 * crate's own doc comment for this pass's honest scope: real shaping,
 * line-breaking, bidi, one complex script, and (added 6 September 2026)
 * "Convert to Outlines" via skrifa are all proven working — text-in-frame/
 * on-path UI wiring and interactive cursor/selection are still not built
 * on top of this.
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

/**
 * "Convert to Outlines" (stage 11's "text to curves") — skrifa's own
 * outline API run per shaped glyph, against the real compiled `.wasm`.
 */
describe("textToCurves — real glyph outlines via skrifa", () => {
  it("returns one non-empty SVG path per glyph, matching layoutText's own glyph count", async () => {
    const shaped = await layoutText("Ha", 40, 0, "latin");
    const outlined = await textToCurves("Ha", 40, 0, "latin");
    expect(outlined.lines).toHaveLength(shaped.lines.length);
    expect(outlined.lines[0]!.glyphs).toHaveLength(shaped.lines[0]!.glyphs.length);
    for (const glyph of outlined.lines[0]!.glyphs) {
      expect(glyph.d.length).toBeGreaterThan(0);
      expect(glyph.d).toMatch(/^M/); // a real SVG path starts with a moveto
      expect(glyph.d).toMatch(/Z/i); // and closes its contour
    }
  });

  it("a space has no visible ink — an empty path, not a crash or a box glyph", async () => {
    const outlined = await textToCurves(" ", 40, 0, "latin");
    expect(outlined.lines[0]!.glyphs[0]!.d).toBe("");
  });

  it("two different letters produce two different outlines, not the same shape twice", async () => {
    const outlined = await textToCurves("IO", 60, 0, "latin");
    const [i, o] = outlined.lines[0]!.glyphs;
    expect(i!.d).not.toBe(o!.d);
  });

  it("a taller font size produces a taller (more spread out) outline for the same letter", async () => {
    // Coarse but real signal that the outline is actually scaled by
    // font_size, not emitted at a fixed em size regardless of the caller's
    // request: parse out every y-coordinate skrifa wrote and compare the
    // total vertical spread.
    const yValues = (d: string) => (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number).filter((_, index) => index % 2 === 1);
    const spread = (d: string) => { const ys = yValues(d); return Math.max(...ys) - Math.min(...ys); };
    const small = await textToCurves("H", 20, 0, "latin");
    const large = await textToCurves("H", 100, 0, "latin");
    expect(spread(large.lines[0]!.glyphs[0]!.d)).toBeGreaterThan(spread(small.lines[0]!.glyphs[0]!.d) * 2);
  });

  it("the outline's own text width matches layoutText's — same underlying layout, just with real curves attached", async () => {
    const shaped = await layoutText("Outline test", 24, 0, "latin");
    const outlined = await textToCurves("Outline test", 24, 0, "latin");
    expect(outlined.width).toBeCloseTo(shaped.width, 3);
  });

  it("a letter with a hole ('o') parses into two real subpaths via subpathsToPoints — the outer ring and the inner counter", () => {
    // The exact conversion `convertActiveTextToOutlines` (vector-commands.ts)
    // runs on every glyph before building a path shape from it — proven
    // here against a real skrifa-produced `d`, not a hand-written fixture.
    return textToCurves("o", 60, 0, "latin").then((outlined) => {
      const subpaths = subpathsToPoints(outlined.lines[0]!.glyphs[0]!.d);
      expect(subpaths.length).toBeGreaterThanOrEqual(2);
      for (const subpath of subpaths) {
        expect(subpath.closed).toBe(true);
        expect(subpath.points.length).toBeGreaterThan(2);
      }
    });
  });
});
