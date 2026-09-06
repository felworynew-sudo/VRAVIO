import type { TextMeasurer } from "./shape-ops";

/**
 * Stage 11's "text in a frame" — plain greedy word-wrap against real font
 * metrics, not `crates/vector-text`'s Parley engine that stage's own
 * layout work built. That engine only has three embedded fonts (Latin,
 * Arabic, Devanagari — `crates/vector-text`'s own doc comment), while a
 * point-text shape already renders through the browser's own font stack
 * via `shape.fontFamily` (an SVG `<text>` element, substituted by whatever
 * font the browser actually has). Wrapping through Parley would silently
 * switch a framed shape's rendered font away from `fontFamily` to whichever
 * embedded Noto face happened to match its script — a real, visible
 * correctness bug, not a cosmetic one, for the overwhelmingly common case
 * of a document using its own chosen font. Plain measurement against the
 * same `TextMeasurer` `shapeBounds`/`hitTestShape` already accept keeps
 * wrapping and rendering agreeing on the same font, and stays synchronous
 * (no WASM), which matters because `vector-svg-export.ts` needs it too and
 * making that export path async for this one feature would be a much
 * larger change than the feature itself.
 *
 * Honest scope: greedy line-breaking on spaces, one paragraph per existing
 * `\n`. No hyphenation, no bidi-aware reordering, no script-specific break
 * rules (Parley's own real strength) — those remain open, same as this
 * stage's other named gaps.
 */
/** Line spacing as a multiple of `fontSize` — the same 1.2 ratio browsers'
 * own default `line-height: normal` resolves to for most fonts, used
 * consistently by every reader of a framed text shape's multiple lines:
 * `shapeBounds` (this file), `VectorWorkspace.tsx`'s live render, and
 * `vector-svg-export.ts`'s static export — one constant, not three
 * independently-chosen numbers that could quietly drift apart. */
export const TEXT_LINE_HEIGHT = 1.2;

export function wrapText(value: string, fontFamily: string, fontSize: number, frameWidth: number, measurer: TextMeasurer): string[] {
  const lines: string[] = [];
  for (const paragraph of value.split("\n")) {
    const words = paragraph.split(" ");
    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (current && measurer.measure(candidate, fontFamily, fontSize).width > frameWidth) {
        lines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    lines.push(current);
  }
  return lines;
}
