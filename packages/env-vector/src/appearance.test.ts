import { describe, expect, it } from "vitest";
import { srgb } from "@vravio/kernel";
import { defaultVectorStyle, emptyVectorStyle, resolveAppearance, solidFill, solidStroke } from "./appearance";

describe("resolveAppearance", () => {
  it("a plain colour fill resolves to a CSS colour string, no gradient defs", () => {
    const style = { ...emptyVectorStyle(), fills: [solidFill(srgb(10, 20, 30))] };
    const resolved = resolveAppearance(style, "shape-1");
    expect(resolved.fills[0]!.css).toBe("rgba(10, 20, 30, 1)");
    expect(resolved.gradientDefs).toEqual([]);
  });

  it("a gradient fill resolves to a url() reference and a matching def", () => {
    const gradient = { kind: "linear" as const, stops: [{ offset: 0, color: srgb(0, 0, 0) }, { offset: 1, color: srgb(255, 255, 255) }], from: { x: 0, y: 0 }, to: { x: 1, y: 0 } };
    const style = { ...emptyVectorStyle(), fills: [{ id: "f1", paint: { kind: "gradient" as const, gradient }, opacity: 1, visible: true, blendMode: "normal" as const }] };
    const resolved = resolveAppearance(style, "shape-1");
    expect(resolved.fills[0]!.css).toMatch(/^url\(#shape-1-fill-0\)$/);
    expect(resolved.gradientDefs).toHaveLength(1);
    expect(resolved.gradientDefs[0]!.id).toBe("shape-1-fill-0");
    expect(resolved.gradientDefs[0]!.gradient).toBe(gradient);
  });

  it("multiple fills each get their own gradient id, not a shared or colliding one", () => {
    const gradA = { kind: "linear" as const, stops: [], from: { x: 0, y: 0 }, to: { x: 1, y: 0 } };
    const gradB = { kind: "radial" as const, stops: [], from: { x: .5, y: .5 }, to: { x: 1, y: .5 } };
    const style = {
      ...emptyVectorStyle(),
      fills: [
        { id: "f1", paint: { kind: "gradient" as const, gradient: gradA }, opacity: 1, visible: true, blendMode: "normal" as const },
        { id: "f2", paint: { kind: "gradient" as const, gradient: gradB }, opacity: 1, visible: true, blendMode: "normal" as const },
      ],
    };
    const resolved = resolveAppearance(style, "shape-9");
    const ids = resolved.gradientDefs.map((def) => def.id);
    expect(new Set(ids).size).toBe(2);
    expect(resolved.fills[0]!.css).toContain(ids[0]);
    expect(resolved.fills[1]!.css).toContain(ids[1]);
  });

  it("fill and stroke gradient ids are namespaced separately, so a fill and a stroke gradient at the same index never collide", () => {
    const grad = { kind: "linear" as const, stops: [], from: { x: 0, y: 0 }, to: { x: 1, y: 1 } };
    const style = {
      ...emptyVectorStyle(),
      fills: [{ id: "f1", paint: { kind: "gradient" as const, gradient: grad }, opacity: 1, visible: true, blendMode: "normal" as const }],
      strokes: [solidStroke(srgb(0, 0, 0)), { ...solidStroke(srgb(0, 0, 0)), paint: { kind: "gradient" as const, gradient: grad } }],
    };
    const resolved = resolveAppearance(style, "shape-5");
    const fillId = resolved.gradientDefs.find((def) => def.id.includes("fill"))!.id;
    const strokeId = resolved.gradientDefs.find((def) => def.id.includes("stroke"))!.id;
    expect(fillId).not.toBe(strokeId);
  });

  it("an empty style resolves to no fills, no strokes, no gradient defs", () => {
    const resolved = resolveAppearance(emptyVectorStyle(), "shape-1");
    expect(resolved).toEqual({ fills: [], strokes: [], gradientDefs: [] });
  });
});

describe("defaultVectorStyle", () => {
  it("is a single solid fill, no stroke — the same visible look every shape had before this stage", () => {
    const style = defaultVectorStyle();
    expect(style.fills).toHaveLength(1);
    expect(style.fills[0]!.paint.kind).toBe("color");
    expect(style.strokes).toHaveLength(0);
    expect(style.opacity).toBe(1);
    expect(style.blendMode).toBe("normal");
  });
});
