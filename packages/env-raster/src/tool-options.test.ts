import { describe, expect, it } from "vitest";
import {
  blurStrokeSegment, cloneStrokeSegment, createRectangleSelection, dodgeBurnStrokeSegment,
  drawQuadraticStrokeSegment, drawShape, floodFill, sampleAverage, smudgeStrokeSegment,
} from "./index";
import type { Point, RgbaColor } from "./types";

const W = 128, H = 128;
const from: Point = { x: 32, y: 64 }, mid: Point = { x: 64, y: 64 }, to: Point = { x: 96, y: 64 };
const red: RgbaColor = { r: 255, g: 0, b: 0, a: 255 };
const white: RgbaColor = { r: 255, g: 255, b: 255, a: 255 };

const blank = () => new Uint8ClampedArray(W * H * 4);
const filled = () => {
  const pixels = new Uint8ClampedArray(W * H * 4);
  for (let index = 0; index < pixels.length; index += 4) {
    pixels[index] = 180; pixels[index + 1] = 90; pixels[index + 2] = 200; pixels[index + 3] = 255;
  }
  return pixels;
};
const textured = () => {
  const pixels = new Uint8ClampedArray(W * H * 4);
  for (let index = 0; index < pixels.length; index += 4) {
    pixels[index] = (index * 7) % 256; pixels[index + 1] = (index * 13) % 256;
    pixels[index + 2] = (index * 29) % 256; pixels[index + 3] = 255;
  }
  return pixels;
};

const digest = (pixels: Uint8ClampedArray) => {
  let hash = 2166136261;
  for (const value of pixels) { hash ^= value; hash = Math.imul(hash, 16777619); }
  return hash >>> 0;
};

/**
 * Runs an operation twice with one setting changed, and insists the result
 * differs.
 *
 * The clone stamp shipped with six controls in its options bar and only one
 * that did anything: spacing was read from the options, passed nowhere, and
 * silently replaced by a constant inside the tool. Nothing failed, nothing
 * warned, and the control looked exactly like the ones that worked. A control
 * that cannot change the output is worse than an absent one, because it costs
 * the time it takes to discover that.
 */
const changesOutput = (base: () => Uint8ClampedArray, run: (pixels: Uint8ClampedArray, high: boolean) => void): boolean => {
  const low = base(), high = base();
  run(low, false);
  run(high, true);
  return digest(low) !== digest(high);
};

describe("every brush option reaches the brush", () => {
  const stroke = (pixels: Uint8ClampedArray, size: number, opacity: number, hardness: number, spacing: number, roundness: number, angle: number, erase = false) =>
    drawQuadraticStrokeSegment(pixels, W, H, from, mid, to, size, erase ? white : red, opacity, erase, undefined, hardness, spacing, roundness, angle);

  it("size", () => expect(changesOutput(blank, (p, high) => stroke(p, high ? 40 : 8, 1, 0.82, 0.12, 1, 0))).toBe(true));
  it("opacity", () => expect(changesOutput(blank, (p, high) => stroke(p, 30, high ? 0.2 : 1, 0.82, 0.12, 1, 0))).toBe(true));
  it("hardness", () => expect(changesOutput(blank, (p, high) => stroke(p, 30, 1, high ? 0.1 : 1, 0.12, 1, 0))).toBe(true));
  it("spacing", () => expect(changesOutput(blank, (p, high) => stroke(p, 30, 0.4, 0.82, high ? 0.9 : 0.02, 1, 0))).toBe(true));
  it("roundness", () => expect(changesOutput(blank, (p, high) => stroke(p, 30, 1, 0.82, 0.12, high ? 0.2 : 1, 0))).toBe(true));
  it("angle", () => expect(changesOutput(blank, (p, high) => stroke(p, 30, 1, 0.82, 0.12, 0.3, high ? 90 : 0))).toBe(true));
  it("erasing", () => expect(changesOutput(filled, (p, high) => stroke(p, 30, 1, 0.82, 0.12, 1, 0, high))).toBe(true));
});

describe("every clone stamp option reaches the stamp", () => {
  const stamp = (pixels: Uint8ClampedArray, size: number, opacity: number, hardness: number, roundness: number, angle: number, spacing: number) =>
    cloneStrokeSegment(pixels, W, H, from, to, -20, -20, size, opacity, undefined, hardness, roundness, angle, true, false, textured(), spacing);

  it("size", () => expect(changesOutput(blank, (p, high) => stamp(p, high ? 40 : 8, 1, 0.82, 1, 0, 0.12))).toBe(true));
  it("opacity", () => expect(changesOutput(blank, (p, high) => stamp(p, 30, high ? 0.2 : 1, 0.82, 1, 0, 0.12))).toBe(true));
  it("hardness", () => expect(changesOutput(blank, (p, high) => stamp(p, 30, 1, high ? 0.1 : 1, 1, 0, 0.12))).toBe(true));
  it("roundness", () => expect(changesOutput(blank, (p, high) => stamp(p, 30, 1, 0.82, high ? 0.2 : 1, 0, 0.12))).toBe(true));
  it("angle", () => expect(changesOutput(blank, (p, high) => stamp(p, 30, 1, 0.82, 0.3, high ? 90 : 0, 0.12))).toBe(true));

  it("spacing", () => {
    // The one that was decoration: read from the options bar and dropped on the
    // way to the tool, which used a constant instead.
    expect(changesOutput(blank, (p, high) => stamp(p, 30, 0.4, 0.82, 1, 0, high ? 0.9 : 0.02))).toBe(true);
  });
});

describe("every retouch option reaches its tool", () => {
  it("blur size", () => expect(changesOutput(textured, (p, high) => blurStrokeSegment(p, textured(), W, H, from, to, high ? 40 : 8, 0.8))).toBe(true));
  it("blur strength", () => expect(changesOutput(textured, (p, high) => blurStrokeSegment(p, textured(), W, H, from, to, 30, high ? 0.1 : 1))).toBe(true));
  it("blur roundness", () => expect(changesOutput(textured, (p, high) => blurStrokeSegment(p, textured(), W, H, from, to, 30, 0.8, undefined, high ? 0.2 : 1, 0))).toBe(true));
  it("blur angle", () => expect(changesOutput(textured, (p, high) => blurStrokeSegment(p, textured(), W, H, from, to, 30, 0.8, undefined, 0.3, high ? 90 : 0))).toBe(true));
  it("smudge strength", () => expect(changesOutput(textured, (p, high) => smudgeStrokeSegment(p, textured(), W, H, from, to, 30, high ? 0.15 : 0.9))).toBe(true));
  it("dodge strength", () => expect(changesOutput(filled, (p, high) => dodgeBurnStrokeSegment(p, W, H, from, to, 30, high ? 0.1 : 0.9, "dodge", "midtones"))).toBe(true));
  it("dodge range", () => expect(changesOutput(filled, (p, high) => dodgeBurnStrokeSegment(p, W, H, from, to, 30, 0.7, "dodge", high ? "shadows" : "highlights"))).toBe(true));
  it("dodge against burn", () => expect(changesOutput(filled, (p, high) => dodgeBurnStrokeSegment(p, W, H, from, to, 30, 0.7, high ? "burn" : "dodge", "midtones"))).toBe(true));
});

describe("every shape and fill option reaches its tool", () => {
  const rect = { x: 24, y: 24, width: 64, height: 48 };

  it("fill tolerance", () => expect(changesOutput(textured, (p, high) => floodFill(p, W, H, 64, 64, { r: 0, g: 255, b: 0, a: 255 }, high ? 200 : 2))).toBe(true));
  it("stroke width", () => expect(changesOutput(blank, (p, high) => drawShape(p, W, H, { kind: "rectangle", rect, cornerRadius: 16, sides: 5, strokeWidth: high ? 18 : 2, fill: null, stroke: white }))).toBe(true));
  it("corner radius", () => expect(changesOutput(blank, (p, high) => drawShape(p, W, H, { kind: "roundedRectangle", rect, cornerRadius: high ? 40 : 2, sides: 5, strokeWidth: 4, fill: red, stroke: null }))).toBe(true));
  it("polygon sides", () => expect(changesOutput(blank, (p, high) => drawShape(p, W, H, { kind: "polygon", rect, cornerRadius: 16, sides: high ? 9 : 3, strokeWidth: 4, fill: red, stroke: null }))).toBe(true));
});

describe("selection and sampling options reach their tools", () => {
  it("feather", () => {
    const hard = createRectangleSelection(W, H, 32, 32, 96, 96, 0);
    const soft = createRectangleSelection(W, H, 32, 32, 96, 96, 12);

    expect(digest(hard.mask)).not.toBe(digest(soft.mask));
  });

  it("eyedropper sample size", () => {
    const pixels = textured();

    expect(sampleAverage(pixels, W, H, 64, 64, 1)).not.toEqual(sampleAverage(pixels, W, H, 64, 64, 11));
  });
});
