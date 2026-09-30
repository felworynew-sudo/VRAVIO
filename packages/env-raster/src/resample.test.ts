import { describe, expect, it } from "vitest";
import { transformLayerPixels } from "./transform";
import type { Interpolation } from "./resample";

/**
 * §65.12 — "масштабирование плохо работает в плане сжатия и расжатия фото". What a transform
 * commit's one resample has to get right, on the public path a Free Transform takes.
 */
const W = 64, H = 64;
const blank = () => new Uint8ClampedArray(W * H * 4);
const at = (pixels: Uint8ClampedArray, x: number, y: number) => Array.from(pixels.subarray((y * W + x) * 4, (y * W + x) * 4 + 4));
const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

describe("transform resampling", () => {
  it("shrinks a one-pixel checkerboard to even grey instead of aliasing (filtered, not point-sampled)", () => {
    const pixels = blank();
    for (let y = 0; y < 32; y += 1) for (let x = 0; x < 32; x += 1) pixels.set((x + y) % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255], (y * W + x) * 4);
    for (const interpolation of ["bilinear", "bicubic", "mitchell", "lanczos3"] as const) {
      const out = transformLayerPixels(pixels, W, H, rect(0, 0, 32, 32), rect(0, 0, 8, 8), 0, null, interpolation);
      for (let y = 1; y < 7; y += 1) for (let x = 1; x < 7; x += 1) {
        const [r, , , a] = at(out, x, y);
        expect(a, `${interpolation} ${x},${y}`).toBe(255);
        expect(Math.abs(r! - 128), `${interpolation} ${x},${y} = ${r}`).toBeLessThan(12);
      }
    }
    // Nearest neighbour keeps hard pixels by definition — the choice the menu offers for pixel art.
    const nearest = transformLayerPixels(pixels, W, H, rect(0, 0, 32, 32), rect(0, 0, 8, 8), 0, null, "nearest");
    expect([0, 255]).toContain(at(nearest, 3, 3)[0]);
  });

  it("leaves an image untouched through an identity transform, whatever the filter", () => {
    const pixels = blank();
    for (let i = 0; i < W * H; i += 1) pixels.set([(i * 37) & 255, (i * 11) & 255, (i * 5) & 255, 255], i * 4);
    for (const interpolation of ["nearest", "bilinear", "bicubic", "lanczos3"] as Interpolation[]) {
      const out = transformLayerPixels(pixels, W, H, rect(0, 0, W, H), rect(0, 0, W, H), 0, null, interpolation);
      expect(Array.from(out), interpolation).toEqual(Array.from(pixels));
    }
  });

  it("keeps a scaled layer's edges crisp when they land on pixel boundaries — no halo, no translucent rim", () => {
    const pixels = blank();
    for (let y = 10; y < 20; y += 1) for (let x = 10; x < 20; x += 1) pixels.set([200, 40, 40, 255], (y * W + x) * 4);
    const out = transformLayerPixels(pixels, W, H, rect(10, 10, 10, 10), rect(20, 20, 30, 30), 0, null, "bicubic");
    for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) {
      const inside = x >= 20 && x < 50 && y >= 20 && y < 50;
      expect(at(out, x, y)[3], `${x},${y}`).toBe(inside ? 255 : 0);
    }
  });

  it("does not darken colour next to transparency (filtered premultiplied)", () => {
    const pixels = blank();
    for (let y = 0; y < 32; y += 1) for (let x = 0; x < 32; x += 1) if ((x >> 2) % 2 === 0) pixels.set([255, 0, 0, 255], (y * W + x) * 4);
    const out = transformLayerPixels(pixels, W, H, rect(0, 0, 32, 32), rect(0, 0, 13, 13), 0, null, "lanczos3");
    for (let i = 0; i < W * H; i += 1) {
      const [r, g, b, a] = at(out, i % W, Math.floor(i / W));
      if (a! < 8) continue;
      expect(r, `pixel ${i}`).toBeGreaterThan(245);
      expect(Math.max(g!, b!), `pixel ${i}`).toBeLessThan(10);
    }
  });

  it("turns by exact quarter turns without resampling, and antialiases the edges of any other angle", () => {
    const pixels = blank();
    for (let y = 16; y < 48; y += 1) for (let x = 16; x < 48; x += 1) pixels.set([x * 4, y * 4, 90, 255], (y * W + x) * 4);
    const quarter = transformLayerPixels(pixels, W, H, rect(16, 16, 32, 32), rect(16, 16, 32, 32), 90, null, "bicubic");
    // Clockwise in y-down space: the source's top-left corner goes to the top-right.
    expect(at(quarter, 47, 16)).toEqual(at(pixels, 16, 16));
    expect(at(quarter, 16, 16)).toEqual(at(pixels, 16, 47));
    const turned = transformLayerPixels(pixels, W, H, rect(16, 16, 32, 32), rect(16, 16, 32, 32), 30, null, "bicubic");
    let partial = 0;
    for (let i = 0; i < W * H; i += 1) { const a = turned[i * 4 + 3]!; if (a > 0 && a < 255) partial += 1; }
    expect(partial).toBeGreaterThan(40);
  });
});
