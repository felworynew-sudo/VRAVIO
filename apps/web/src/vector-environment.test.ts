import { describe, expect, it } from "vitest";
import { srgb } from "@vravio/kernel";
import { createShape, emptyVectorStyle, solidFill, solidStroke, type VectorShape } from "@vravio/env-vector";
import { paintShape } from "./vector-environment";

// jsdom has no canvas backing, so window.Path2D doesn't exist — paintShape's
// own pathFor() constructs one for every non-line/text shape. A no-op stand-in
// is enough: nothing in these tests inspects the path's contents, only
// whether fill()/stroke() (recorded by fakeContext below) get called on it.
class FakePath2D {
  rect() {}
  roundRect() {}
  ellipse() {}
}
(globalThis as { Path2D?: unknown }).Path2D = FakePath2D;

/**
 * Dead-checkbox rule (CLAUDE.md §3), applied to the canvas export path: every
 * appearance option `AppearancePanel.tsx` exposes has to actually change what
 * `paintShape` draws. A real `CanvasRenderingContext2D` isn't available under
 * vitest's jsdom environment, so this fakes just enough of it to record the
 * calls `paintShape` makes and assert on them — proven non-vacuous below by
 * flipping each option and checking the recording changes.
 */
function fakeContext() {
  const calls: string[] = [];
  const gradientStops: Array<{ offset: number; color: string }> = [];
  const gradient = {
    addColorStop(offset: number, color: string) { gradientStops.push({ offset, color }); },
  };
  let font = "", textAlign = "", textBaseline = "";
  const context = {
    calls,
    gradientStops,
    save() { calls.push("save"); },
    restore() { calls.push("restore"); },
    transform() { calls.push("transform"); },
    fill() { calls.push("fill"); },
    stroke() { calls.push("stroke"); },
    fillText() { calls.push("fillText"); },
    strokeText() { calls.push("strokeText"); },
    beginPath() { calls.push("beginPath"); },
    moveTo() { calls.push("moveTo"); },
    lineTo() { calls.push("lineTo"); },
    setLineDash(dash: number[]) { calls.push(`dash:${dash.join(",")}`); },
    createLinearGradient() { calls.push("linearGradient"); return gradient; },
    createRadialGradient() { calls.push("radialGradient"); return gradient; },
    set globalAlpha(value: number) { calls.push(`alpha:${value}`); },
    set globalCompositeOperation(value: string) { calls.push(`blend:${value}`); },
    set fillStyle(value: unknown) { calls.push(`fillStyle:${value}`); },
    set strokeStyle(value: unknown) { calls.push(`strokeStyle:${value}`); },
    set lineWidth(value: number) { calls.push(`lineWidth:${value}`); },
    set lineCap(value: string) { calls.push(`lineCap:${value}`); },
    set lineJoin(value: string) { calls.push(`lineJoin:${value}`); },
    get font() { return font; },
    set font(value: string) { font = value; },
    get textAlign() { return textAlign; },
    set textAlign(value: string) { textAlign = value; },
    get textBaseline() { return textBaseline; },
    set textBaseline(value: string) { textBaseline = value; },
  } as unknown as CanvasRenderingContext2D & { calls: string[]; gradientStops: Array<{ offset: number; color: string }> };
  return context;
}

function rect(style = { ...emptyVectorStyle(), fills: [solidFill(srgb(255, 0, 0))] }): VectorShape {
  return createShape("rectangle", 0, 0, style);
}

describe("paintShape — dead-checkbox coverage", () => {
  it("a fill layer with visible:false paints nothing", () => {
    const shape = rect({ ...emptyVectorStyle(), fills: [{ ...solidFill(srgb(255, 0, 0)), visible: false }] });
    const context = fakeContext();
    paintShape(context, shape);
    expect(context.calls).not.toContain("fill");
  });

  it("turning a fill layer visible again makes it paint — same style otherwise", () => {
    const on = fakeContext();
    paintShape(on, rect({ ...emptyVectorStyle(), fills: [solidFill(srgb(255, 0, 0))] }));
    expect(on.calls).toContain("fill");
  });

  it("a stroke layer with visible:false paints nothing", () => {
    const shape = rect({ ...emptyVectorStyle(), strokes: [{ ...solidStroke(srgb(0, 0, 0)), visible: false }] });
    const context = fakeContext();
    paintShape(context, shape);
    expect(context.calls).not.toContain("stroke");
  });

  it("a gradient paint calls createLinearGradient/createRadialGradient instead of setting a plain colour string", () => {
    const gradient = { kind: "linear" as const, stops: [{ offset: 0, color: srgb(0, 0, 0) }, { offset: 1, color: srgb(255, 255, 255) }], from: { x: 0, y: 0 }, to: { x: 1, y: 0 } };
    const shape = rect({ ...emptyVectorStyle(), fills: [{ ...solidFill(srgb(0, 0, 0)), paint: { kind: "gradient", gradient } }] });
    const context = fakeContext();
    paintShape(context, shape);
    expect(context.calls).toContain("linearGradient");
    expect(context.gradientStops).toHaveLength(2);
  });

  it("switching gradient kind from linear to radial changes which canvas gradient constructor runs", () => {
    const gradient = { kind: "radial" as const, stops: [], from: { x: .5, y: .5 }, to: { x: 1, y: .5 } };
    const shape = rect({ ...emptyVectorStyle(), fills: [{ ...solidFill(srgb(0, 0, 0)), paint: { kind: "gradient", gradient } }] });
    const context = fakeContext();
    paintShape(context, shape);
    expect(context.calls).toContain("radialGradient");
    expect(context.calls).not.toContain("linearGradient");
  });

  it("a dash pattern reaches setLineDash; solid (empty dash) clears it", () => {
    const dashed = rect({ ...emptyVectorStyle(), strokes: [{ ...solidStroke(srgb(0, 0, 0)), dash: [4, 4] }] });
    const solid = rect({ ...emptyVectorStyle(), strokes: [solidStroke(srgb(0, 0, 0))] });
    const dashedContext = fakeContext();
    const solidContext = fakeContext();
    paintShape(dashedContext, dashed);
    paintShape(solidContext, solid);
    expect(dashedContext.calls).toContain("dash:4,4");
    expect(solidContext.calls).toContain("dash:");
  });

  it("cap and join options each reach the canvas context", () => {
    const shape = rect({ ...emptyVectorStyle(), strokes: [{ ...solidStroke(srgb(0, 0, 0)), cap: "round", join: "bevel" }] });
    const context = fakeContext();
    paintShape(context, shape);
    expect(context.calls).toContain("lineCap:round");
    expect(context.calls).toContain("lineJoin:bevel");
  });

  it("a wider stroke sets a different lineWidth than a narrower one", () => {
    const thin = fakeContext();
    const thick = fakeContext();
    paintShape(thin, rect({ ...emptyVectorStyle(), strokes: [solidStroke(srgb(0, 0, 0), 1)] }));
    paintShape(thick, rect({ ...emptyVectorStyle(), strokes: [solidStroke(srgb(0, 0, 0), 20)] }));
    expect(thin.calls).toContain("lineWidth:1");
    expect(thick.calls).toContain("lineWidth:20");
  });

  it("per-layer opacity multiplies into globalAlpha differently from full opacity", () => {
    const full = fakeContext();
    const half = fakeContext();
    paintShape(full, rect({ ...emptyVectorStyle(), fills: [solidFill(srgb(255, 0, 0))] }));
    paintShape(half, rect({ ...emptyVectorStyle(), fills: [{ ...solidFill(srgb(255, 0, 0)), opacity: 0.5 }] }));
    expect(full.calls).toContain("alpha:1");
    expect(half.calls).toContain("alpha:0.5");
  });

  it("object-level opacity multiplies with layer opacity, not replaces it", () => {
    const context = fakeContext();
    paintShape(context, rect({ ...emptyVectorStyle(), fills: [{ ...solidFill(srgb(255, 0, 0)), opacity: 0.5 }], opacity: 0.5 }));
    expect(context.calls).toContain("alpha:0.25");
  });

  it("object-level blend mode reaches globalCompositeOperation; normal maps to source-over", () => {
    const normalContext = fakeContext();
    const multiplyContext = fakeContext();
    paintShape(normalContext, rect({ ...emptyVectorStyle(), fills: [solidFill(srgb(0, 0, 0))], blendMode: "normal" }));
    paintShape(multiplyContext, rect({ ...emptyVectorStyle(), fills: [solidFill(srgb(0, 0, 0))], blendMode: "multiply" }));
    expect(normalContext.calls).toContain("blend:source-over");
    expect(multiplyContext.calls).toContain("blend:multiply");
  });

  it("a shape with no fills and no strokes paints nothing at all", () => {
    const context = fakeContext();
    paintShape(context, rect(emptyVectorStyle()));
    expect(context.calls.filter((call) => call === "fill" || call === "stroke")).toHaveLength(0);
  });
});
