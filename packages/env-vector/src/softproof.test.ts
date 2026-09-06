import { describe, expect, it } from "vitest";
import { srgb } from "@vravio/kernel";
import { collectSolidPaintColors } from "./softproof";
import { createShape, createVectorDocument } from "./document";
import { addShape } from "./shape-ops";
import { emptyVectorStyle, solidFill, solidStroke } from "./appearance";

describe("collectSolidPaintColors (stage 14 of docs/vector-plan.md)", () => {
  it("collects a fill and a stroke colour from one shape", () => {
    const state = createVectorDocument();
    const shape = createShape("rectangle", 0, 0, { ...emptyVectorStyle(), fills: [solidFill(srgb(200, 50, 50))], strokes: [solidStroke(srgb(10, 20, 30))] });
    addShape(state, shape);
    const colors = collectSolidPaintColors(state);
    expect(colors).toHaveLength(2);
    expect(colors.map((c) => c.components)).toEqual(expect.arrayContaining([[200, 50, 50], [10, 20, 30]]));
  });

  it("deduplicates the exact same colour reused across shapes", () => {
    const state = createVectorDocument();
    addShape(state, createShape("rectangle", 0, 0, { ...emptyVectorStyle(), fills: [solidFill(srgb(1, 2, 3))] }));
    addShape(state, createShape("ellipse", 0, 0, { ...emptyVectorStyle(), fills: [solidFill(srgb(1, 2, 3))] }));
    expect(collectSolidPaintColors(state)).toHaveLength(1);
  });

  it("skips gradient paints and non-srgb colour spaces", () => {
    const state = createVectorDocument();
    const withGradient = createShape("rectangle", 0, 0, { ...emptyVectorStyle(), fills: [{ id: "f1", opacity: 1, visible: true, blendMode: "normal", paint: { kind: "gradient", gradient: { kind: "linear", stops: [{ offset: 0, color: srgb(0, 0, 0) }, { offset: 1, color: srgb(255, 255, 255) }], from: { x: 0, y: 0 }, to: { x: 1, y: 0 } } } }] });
    const withCmyk = createShape("ellipse", 0, 0, { ...emptyVectorStyle(), fills: [{ id: "f2", opacity: 1, visible: true, blendMode: "normal", paint: { kind: "color", color: { space: "cmyk", components: [0.1, 0.2, 0.3, 0.4], alpha: 1 } } }] });
    addShape(state, withGradient);
    addShape(state, withCmyk);
    expect(collectSolidPaintColors(state)).toHaveLength(0);
  });

  it("is empty for a document with no shapes", () => {
    expect(collectSolidPaintColors(createVectorDocument())).toEqual([]);
  });
});
