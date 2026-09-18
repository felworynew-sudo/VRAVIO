import { describe, expect, it } from "vitest";
import { applyAdjustment } from "./adjustments";
import { adjustLayerPixelsDeep, applyAdjustmentDeep } from "./adjustments-deep";
import { createRasterLayer } from "./document";
import { TileStore } from "./tile-store";
import type { RasterAdjustment } from "./types";

/**
 * docs/master-plan.md §59.2a: adjustments computed at the layer's real depth.
 *
 * The point of the whole slice is that a 16-bit document does not go through a 256-entry table, so
 * that is what these measure: the number of distinct output values a gentle curve produces, and
 * that the 8-bit results did not move while the deep path was added.
 */

const curve = (points: Array<{ x: number; y: number }>): RasterAdjustment => ({ kind: "curves", points });

describe("adjustments at depth", () => {
  it("leaves the 8-bit path byte-identical — the deep path is an addition, not a change", () => {
    const eight = new Uint8ClampedArray(256 * 4);
    for (let index = 0; index < 256; index += 1) { eight[index * 4] = index; eight[index * 4 + 1] = index; eight[index * 4 + 2] = index; eight[index * 4 + 3] = 255; }
    const viaOld = eight.slice(), viaDeep = eight.slice();
    applyAdjustment(viaOld, curve([{ x: 0, y: 0 }, { x: 128, y: 160 }, { x: 255, y: 255 }]));
    applyAdjustmentDeep(viaDeep, curve([{ x: 0, y: 0 }, { x: 128, y: 160 }, { x: 255, y: 255 }]));

    expect(Array.from(viaDeep)).toEqual(Array.from(viaOld));
  });

  it("keeps far more distinct levels at 16 bits than the 8-bit table can express", () => {
    // A gentle S-curve over a 1024-step ramp. Through a byte table the ramp collapses onto at most
    // 256 output values — the banding 16-bit exists to avoid.
    const steps = 1024;
    const deep = new Uint16Array(steps * 4);
    for (let index = 0; index < steps; index += 1) {
      const value = Math.round(index * 65535 / (steps - 1));
      deep[index * 4] = value; deep[index * 4 + 1] = value; deep[index * 4 + 2] = value; deep[index * 4 + 3] = 65535;
    }
    applyAdjustmentDeep(deep, curve([{ x: 0, y: 0 }, { x: 64, y: 48 }, { x: 192, y: 208 }, { x: 255, y: 255 }]));

    const levels = new Set<number>();
    for (let index = 0; index < steps; index += 1) levels.add(deep[index * 4]!);
    expect(levels.size).toBeGreaterThan(900);
  });

  it("holds 32-bit highlights above 1 through an exposure adjustment instead of clipping them", () => {
    const float = new Float32Array([0.5, 0.5, 0.5, 1]);
    applyAdjustmentDeep(float, { kind: "exposure", exposure: 2, offset: 0, gamma: 1 });

    // 0.5 with +2 EV is 2.0 — a value 8-bit storage could not hold and 32-bit must not throw away.
    expect(float[0]).toBeCloseTo(2, 3);
  });

  it("matches the 8-bit result when a 16-bit buffer holds the same values", () => {
    const eight = new Uint8ClampedArray([10, 120, 240, 255]);
    const sixteen = new Uint16Array([10 * 257, 120 * 257, 240 * 257, 65535]);
    const adjustment: RasterAdjustment = { kind: "brightnessContrast", brightness: 10, contrast: 25 };
    applyAdjustment(eight, adjustment);
    applyAdjustmentDeep(sixteen, adjustment);

    // Same formula, finer grid: each 16-bit channel lands within one 8-bit step of the 8-bit answer.
    for (let channel = 0; channel < 3; channel += 1) {
      expect(Math.abs(sixteen[channel]! / 257 - eight[channel]!), `channel ${channel}`).toBeLessThanOrEqual(1);
    }
  });
});

describe("adjusting a deep layer in its own frame", () => {
  const layerWith = (depth: 8 | 16 | 32, width: number, height: number) => {
    const layer = createRasterLayer(width, height, "L", depth);
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let index = 0; index < pixels.length; index += 4) { pixels[index] = 100; pixels[index + 1] = 100; pixels[index + 2] = 100; pixels[index + 3] = 255; }
    layer.tiles = TileStore.fromPixels(pixels, width, height, 4, depth);
    return layer;
  };

  it("reads and writes the layer's own format, leaving its bounds alone", () => {
    const layer = layerWith(16, 8, 4);
    const result = adjustLayerPixelsDeep(layer, { kind: "invert" }, null, 8, 4);

    expect(result).not.toBeNull();
    expect(result!.before).toBeInstanceOf(Uint16Array);
    expect(result!.rect).toEqual({ x: 0, y: 0, width: 8, height: 4 });
    // 100 → 25700 at 16 bits, inverted to 65535 − 25700.
    expect(result!.after[0]).toBe(65535 - 25700);
  });

  it("confines the adjustment to the selection at full precision", () => {
    const layer = layerWith(16, 4, 1);
    const mask = new Uint8ClampedArray(4 * 1);
    mask[0] = 255; mask[1] = 128; // fully selected, half selected, then nothing
    const result = adjustLayerPixelsDeep(layer, { kind: "invert" }, { mask }, 4, 1)!;

    expect(result.after[0]).toBe(65535 - 25700);
    // Half coverage blends halfway — and does so in 16-bit steps, not 8-bit ones.
    expect(result.after[4]).toBeCloseTo(25700 + (65535 - 25700 - 25700) * (128 / 255), 0);
    expect(result.after[8]).toBe(25700);
  });
});
