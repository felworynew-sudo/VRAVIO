import { describe, expect, it } from "vitest";
import { createShape, createVectorDocument, emptyVectorStyle, solidFill, solidStroke } from "@vravio/env-vector";
import { srgb } from "@vravio/kernel";
import { exportVectorDocumentToSvg } from "./vector-svg-export";
import { renderSvgToRgba } from "./vector-svg-wasm";

/**
 * Stage 10 of docs/vector-plan.md's own required check: "our export,
 * rendered by resvg, matches what the editor shows."
 *
 * This file's automated half checks resvg's actual pixel output against
 * pixel values worked out analytically from the document itself — a solid
 * fill's colour has to show up at its own center, a stroke's colour at its
 * own edge — rather than against a second in-process rasterizer: this repo
 * has no `window`/`HTMLCanvasElement` under Vitest's Node environment (no
 * jsdom, no `node-canvas`), so `vector-environment.ts`'s own canvas export
 * path can't run here to render a comparison bitmap. `vector-environment
 * .test.ts` (Stage 7) hits the same wall and works around it with a
 * *recording* fake context — fine for asserting "did fillStyle get set,"
 * useless for "what colour actually landed on pixel (50,50)," which is
 * what this check needs.
 *
 * The literal "resvg vs. the live editor" comparison — two real
 * rasterizers, same document — was run once, live, in an actual browser
 * (which has a real Canvas 2D) instead; the measured numbers from that run
 * are recorded in vector-plan.md's Stage 10 write-up, the same treatment
 * Stage 9 gave `useModifierResults`' cache-by-revision behavior for the
 * same underlying reason (no component/browser-API test harness here).
 */
function pixelAt(rgba: Uint8Array, width: number, x: number, y: number): [number, number, number, number] {
  const i = (y * width + x) * 4;
  return [rgba[i]!, rgba[i + 1]!, rgba[i + 2]!, rgba[i + 3]!];
}

describe("SVG export cross-checked against resvg", () => {
  it("a solid rectangle's own fill colour lands exactly where the rectangle is", async () => {
    const state = createVectorDocument(100, 100);
    const rect = createShape("rectangle", 10, 10, { ...emptyVectorStyle(), fills: [solidFill(srgb(200, 50, 50))] });
    Object.assign(rect, { width: 60, height: 60 });
    state.shapes.push(rect);

    const svg = exportVectorDocumentToSvg(state);
    const pixels = await renderSvgToRgba(svg, 100, 100);

    const [r, g, b, a] = pixelAt(pixels, 100, 40, 40); // center of the rectangle
    expect(r).toBeCloseTo(200, -1);
    expect(g).toBeCloseTo(50, -1);
    expect(b).toBeCloseTo(50, -1);
    expect(a).toBe(255);

    // Outside the rectangle: transparent (no background shape drawn).
    const [, , , outsideAlpha] = pixelAt(pixels, 100, 5, 5);
    expect(outsideAlpha).toBe(0);
  });

  it("a stroke's own colour lands on the rectangle's edge, not its (unfilled) interior", async () => {
    const state = createVectorDocument(100, 100);
    const rect = createShape("rectangle", 10, 10, { ...emptyVectorStyle(), strokes: [solidStroke(srgb(20, 20, 200), 6)] });
    Object.assign(rect, { width: 60, height: 60 });
    state.shapes.push(rect);

    const svg = exportVectorDocumentToSvg(state);
    const pixels = await renderSvgToRgba(svg, 100, 100);

    const [, , edgeBlue, edgeAlpha] = pixelAt(pixels, 100, 10, 40); // left edge, stroke width 6 centered on it
    expect(edgeBlue).toBeGreaterThan(150);
    expect(edgeAlpha).toBeGreaterThan(0);

    const [, , , interiorAlpha] = pixelAt(pixels, 100, 40, 40); // well inside, no fill
    expect(interiorAlpha).toBe(0);
  });

  it("is non-vacuous: a shape moved outside the canvas produces no pixels at its old location", async () => {
    const state = createVectorDocument(100, 100);
    const rect = createShape("rectangle", 10, 10, { ...emptyVectorStyle(), fills: [solidFill(srgb(200, 50, 50))] });
    Object.assign(rect, { width: 60, height: 60, x: 500 });
    state.shapes.push(rect);

    const svg = exportVectorDocumentToSvg(state);
    const pixels = await renderSvgToRgba(svg, 100, 100);
    const [, , , alpha] = pixelAt(pixels, 100, 40, 40);
    expect(alpha).toBe(0);
  });
});
