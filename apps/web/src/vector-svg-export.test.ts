import { describe, expect, it } from "vitest";
import { appendShapeAt, createShape, createVectorDocument, createVectorGroup, emptyVectorStyle, solidFill, solidStroke } from "@vravio/env-vector";
import { srgb } from "@vravio/kernel";
import { exportVectorDocumentToSvg } from "./vector-svg-export";

describe("exportVectorDocumentToSvg", () => {
  it("writes a root <svg> at the document's own size", () => {
    const state = createVectorDocument(400, 300);
    const svg = exportVectorDocumentToSvg(state);
    expect(svg).toContain('width="400"');
    expect(svg).toContain('height="300"');
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
});
