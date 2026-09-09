import { describe, expect, it } from "vitest";

/**
 * The rule CLAUDE.md §1 states and this repository has broken four times:
 * interface does not scale with the canvas zoom. Ever.
 *
 * A written rule has not been enough — the same bug came back through two
 * different mechanisms (a `vector-effect:non-scaling-stroke` that does not
 * cancel a CSS transform on an ancestor, and later a bare `stroke-width` in the
 * stylesheet quietly overriding an already-correct `1 / zoom` JSX attribute).
 * So it is checked here instead of only described.
 *
 * Both checks read the real stylesheet rather than any abstraction of it,
 * because the stylesheet is where both regressions actually landed.
 */

// Read off disk the same way ui/theme/tokens.test.ts does, and for the reasons
// spelled out there: Vite stubs a CSS import to an empty string under the test
// transform, and pulling in @types/node for one test would change setTimeout's
// return type across the whole browser app.
declare function require(id: "node:fs"): { readFileSync(path: string, encoding: "utf-8"): string };
declare function require(id: "node:url"): { fileURLToPath(url: URL): string };

const styles = require("node:fs").readFileSync(require("node:url").fileURLToPath(new URL("./styles.css", import.meta.url)), "utf-8");

/** Declarations only — the file also *discusses* the technique in comments,
 * and the comments are the point of keeping the history readable. */
function declarationsOf(property: string): string[] {
  const withoutComments = styles.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...withoutComments.matchAll(new RegExp(`([.#][\\w-]+[^{}]*)\\{[^}]*\\b${property}\\s*:[^;}]*`, "g"))].map((match) => match[1]!.trim());
}

describe("interface does not scale with the canvas zoom", () => {
  it("never reaches for vector-effect:non-scaling-stroke", () => {
    // It cancels an SVG's *internal* transform, not a CSS transform on an
    // ancestor — and every overlay in this app is inside one (`.raster-stage`,
    // `.vector-stage`). So it is either useless where it appears or, worse,
    // the reason someone believed a stroke was already handled. Divide the
    // width by the zoom in the JSX attribute instead, or draw the element in a
    // layer that carries no scale at all.
    expect(declarationsOf("vector-effect")).toEqual([]);
  });

  it("leaves stroke width and dash length to the JSX for overlays inside a scaled stage", () => {
    // These classes are all drawn inside a stage that the zoom scales, so their
    // widths are computed as `n / zoom` where they are rendered. A CSS property
    // beats an SVG presentation attribute, so a declaration here would silently
    // win and put the scaling back — which is exactly how this regressed once
    // already (fixed in 5ba9856).
    const scaledOverlayClasses = [
      // The marching ants replaced selection-soft-edge/selection-hard-edge; naming
      // classes that no longer exist would leave this list checking nothing.
      "selection-overlay", "committed-selection", "marching-ants", "marching-ants-dark", "marching-ants-light",
      "shape-draft", "text-frame-draft", "text-path-guide",
      "transform-controls", "transform-quad-outline", "transform-handle",
      "patch-source-path", "crop-outline", "crop-third", "crop-handle",
      // Vector chrome drawn inside .vector-stage, which the zoom scales the same
      // way. Their widths were already divided by the zoom in JSX; their dash
      // lengths were not, and a dash pattern in document units stretches exactly
      // like the line it is on.
      "vector-artboard-outline", "vector-artboard-bleed", "vector-snap-guide", "vector-pen-rubber-band",
    ];
    const offenders: string[] = [];
    for (const property of ["stroke-width", "stroke-dasharray"]) {
      for (const selector of declarationsOf(property)) {
        const matched = scaledOverlayClasses.filter((name) => selector.includes(`.${name}`));
        if (matched.length) offenders.push(`${property} on ${selector}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("chrome that keeps its width in CSS divides by the zoom there", () => {
  it("makes .vector-image-placeholder read --vector-zoom", () => {
    // The one exception to the rule above, and it needs its own guard rather
    // than an exemption. This box is rendered from the vector shape tree,
    // several components below anything holding the viewport, so threading the
    // zoom down to size one dashed placeholder would be a poor trade; instead
    // `.vector-stage` publishes `--vector-zoom` and the rule divides by it.
    // That is still the same rule — a screen measurement divided by the zoom —
    // just expressed where this element can reach it. What must never happen is
    // the width going back to a bare literal.
    const rule = styles.match(/\.vector-image-placeholder\s*\{[^}]*\}/)?.[0];
    expect(rule).toBeTruthy();
    for (const property of ["stroke-width", "stroke-dasharray"]) {
      const declaration = rule!.match(new RegExp(`${property}\s*:[^;}]*`))?.[0];
      expect(declaration, `${property} should be declared`).toBeTruthy();
      expect(declaration, `${property} must divide by --vector-zoom`).toContain("var(--vector-zoom");
    }
  });
});
