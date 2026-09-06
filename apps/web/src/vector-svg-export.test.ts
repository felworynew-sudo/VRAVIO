import { describe, expect, it } from "vitest";
import { addShape, appendShapeAt, createShape, createSymbolFromShapes, createVectorDocument, createVectorGroup, emptyVectorStyle, placeSymbolInstance, solidFill, solidStroke } from "@vravio/env-vector";
import { srgb } from "@vravio/kernel";
import { exportVectorDocumentToSvg } from "./vector-svg-export";

describe("exportVectorDocumentToSvg", () => {
  it("writes a root <svg> at the document's own size", () => {
    const state = createVectorDocument(400, 300);
    const svg = exportVectorDocumentToSvg(state);
    expect(svg).toContain('width="400"');
    expect(svg).toContain('height="300"');
  });

  it("stage 15: a crop exports one artboard's own rectangle, viewBox origin included", () => {
    const state = createVectorDocument(400, 300);
    const rect = createShape("rectangle", 700, 700, { ...emptyVectorStyle(), fills: [solidFill(srgb(10, 20, 30))] });
    const outside = createShape("rectangle", 5000, 5000, { ...emptyVectorStyle(), fills: [solidFill(srgb(200, 0, 0))] });
    state.shapes.push(rect, outside);

    const svg = exportVectorDocumentToSvg(state, { x: 600, y: 600, width: 200, height: 200 });

    expect(svg).toContain('width="200"');
    expect(svg).toContain('height="200"');
    expect(svg).toContain('viewBox="600 600 200 200"');
    // The shape sitting inside the crop is still written (real document
    // coordinates, not re-based to the crop's own origin) — SVG's own
    // viewBox does the clipping, this function does not filter shapes out.
    expect(svg).toContain("rgba(10, 20, 30, 1)");
    expect(svg).toContain("rgba(200, 0, 0, 1)");
  });

  it("a filled rectangle becomes a <rect> with the resolved fill colour", () => {
    const state = createVectorDocument(200, 200);
    const rect = createShape("rectangle", 10, 10, { ...emptyVectorStyle(), fills: [solidFill(srgb(255, 0, 0))] });
    state.shapes.push(rect);
    const svg = exportVectorDocumentToSvg(state);
    expect(svg).toContain("<rect");
    expect(svg).toContain("rgba(255, 0, 0, 1)");
  });

  it("an invisible shape is not written at all", () => {
    const state = createVectorDocument(200, 200);
    const rect = createShape("rectangle", 10, 10, { ...emptyVectorStyle(), fills: [solidFill(srgb(0, 255, 0))] });
    rect.visible = false;
    state.shapes.push(rect);
    const svg = exportVectorDocumentToSvg(state);
    expect(svg).not.toContain("rgba(0, 255, 0, 1)");
  });

  it("a stroke's dash/cap/join make it into the markup", () => {
    const state = createVectorDocument(200, 200);
    const rect = createShape("rectangle", 10, 10, { ...emptyVectorStyle(), strokes: [{ ...solidStroke(srgb(0, 0, 0)), dash: [4, 4], cap: "round", join: "round" }] });
    state.shapes.push(rect);
    const svg = exportVectorDocumentToSvg(state);
    expect(svg).toContain('stroke-dasharray="4 4"');
    expect(svg).toContain('stroke-linecap="round"');
  });

  it("a gradient fill gets a <linearGradient> in <defs> and a url() fill reference", () => {
    const state = createVectorDocument(200, 200);
    const gradient = { kind: "linear" as const, stops: [{ offset: 0, color: srgb(0, 0, 0) }, { offset: 1, color: srgb(255, 255, 255) }], from: { x: 0, y: 0 }, to: { x: 1, y: 0 } };
    const rect = createShape("rectangle", 0, 0, { ...emptyVectorStyle(), fills: [{ ...solidFill(srgb(0, 0, 0)), paint: { kind: "gradient", gradient } }] });
    state.shapes.push(rect);
    const svg = exportVectorDocumentToSvg(state);
    expect(svg).toContain("<linearGradient");
    expect(svg).toMatch(/fill="url\(#[^)]+\)"/);
  });

  it("a group's children are nested inside a <g>", () => {
    const state = createVectorDocument(200, 200);
    const group = appendShapeAt(state, createVectorGroup());
    const rect = createShape("rectangle", 5, 5, { ...emptyVectorStyle(), fills: [solidFill(srgb(0, 0, 255))] });
    appendShapeAt(state, rect, group.id);
    const svg = exportVectorDocumentToSvg(state);
    expect(svg).toMatch(/<g[^>]*><g[^>]*>.*rgba\(0, 0, 255, 1\)/s);
  });

  it("a symbol becomes a real <symbol>, each instance a <use> referencing it once, not a copy per instance", () => {
    const state = createVectorDocument(400, 400);
    const rect = createShape("rectangle", 0, 0, { ...emptyVectorStyle(), fills: [solidFill(srgb(255, 128, 0))] });
    addShape(state, rect);
    const symbolId = (createSymbolFromShapes(state, [rect.id])! as unknown as { symbolId: string }).symbolId;
    placeSymbolInstance(state, symbolId, 100, 100);
    placeSymbolInstance(state, symbolId, 200, 200);

    const svg = exportVectorDocumentToSvg(state);
    // The definition's own markup (the orange fill) is written exactly
    // once, inside a <symbol> — not once per instance, which is the same
    // "shared, not copied" property symbol-ops.test.ts already checks for
    // the in-app document, now checked for what actually leaves the app.
    expect(svg.match(/rgba\(255, 128, 0, 1\)/g)).toHaveLength(1);
    expect(svg).toMatch(new RegExp(`<symbol id="${symbolId}">`));
    expect(svg.match(/<use href="#/g)).toHaveLength(3); // the instance createSymbolFromShapes itself placed, plus the two above
  });
});
