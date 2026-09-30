import { describe, expect, it } from "vitest";
import { puppetMeshFromAlpha } from "./puppet-mesh";
import { forEachMeshPixel } from "./puppet";

/** §65.15 — Puppet Warp's mesh follows the layer's own outline, as Photoshop's does. */
const W = 200, H = 160;
const paint = (filled: (x: number, y: number) => boolean) => {
  const pixels = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) if (filled(x, y)) pixels.set([200, 100, 50, 255], (y * W + x) * 4);
  return pixels;
};
const circle = (x: number, y: number) => (x - 100) ** 2 + (y - 80) ** 2 < 60 ** 2;
const coverage = (mesh: NonNullable<ReturnType<typeof puppetMeshFromAlpha>>) => {
  const covered = new Uint8Array(W * H);
  forEachMeshPixel(mesh.vertices, mesh.triangles, W, H, (index) => { covered[index] = 1; });
  return covered;
};

describe("puppetMeshFromAlpha", () => {
  it("covers every opaque pixel, so none can vanish in the warp", () => {
    const pixels = paint(circle);
    for (const density of ["fewer", "normal", "more"] as const) {
      const mesh = puppetMeshFromAlpha(pixels, W, H, 0, 0, density, 2)!;
      const covered = coverage(mesh);
      let missing = 0;
      for (let i = 0; i < W * H; i += 1) if (pixels[i * 4 + 3] && !covered[i]) missing += 1;
      expect(missing, density).toBe(0);
    }
  });

  it("hugs the outline instead of overhanging it like a grid of squares", () => {
    const mesh = puppetMeshFromAlpha(paint(circle), W, H, 0, 0, "normal", 2)!;
    // No point further out than the expansion (plus the pixel-corner half step).
    for (const p of mesh.vertices) expect(Math.hypot(p.x - 100, p.y - 80), `${p.x},${p.y}`).toBeLessThan(60 + 2 + 1.5);
    // And the covered area is the circle's, not its bounding square's.
    const covered = coverage(mesh);
    expect(covered[5 * W + 45]).toBe(0);
    expect(covered[20 * W + 45]).toBe(0);
  });

  it("leaves holes and gaps between separate parts empty", () => {
    const ring = (x: number, y: number) => circle(x, y) && (x - 100) ** 2 + (y - 80) ** 2 > 25 ** 2;
    const holed = coverage(puppetMeshFromAlpha(paint(ring), W, H, 0, 0, "normal", 2)!);
    expect(holed[80 * W + 100]).toBe(0);
    const parts = (x: number, y: number) => y > 40 && y < 120 && ((x > 10 && x < 80) || (x > 120 && x < 190));
    const split = coverage(puppetMeshFromAlpha(paint(parts), W, H, 0, 0, "normal", 2)!);
    expect(split[80 * W + 100]).toBe(0);
    expect(split[80 * W + 40]).toBe(1);
    expect(split[80 * W + 160]).toBe(1);
  });

  it("makes Density and Expansion change the mesh", () => {
    const pixels = paint(circle);
    const count = (density: "fewer" | "normal" | "more") => puppetMeshFromAlpha(pixels, W, H, 0, 0, density, 2)!.vertices.length;
    expect(count("fewer")).toBeLessThan(count("normal"));
    expect(count("normal")).toBeLessThan(count("more"));
    const tight = puppetMeshFromAlpha(pixels, W, H, 0, 0, "normal", 2)!.bounds;
    const loose = puppetMeshFromAlpha(pixels, W, H, 0, 0, "normal", 12)!.bounds;
    expect(loose.width).toBeGreaterThan(tight.width + 15);
  });

  it("places the mesh in document space from the layer's own origin, off-canvas included", () => {
    const mesh = puppetMeshFromAlpha(paint(circle), W, H, -300, 40, "fewer", 2)!;
    expect(mesh.bounds.x).toBeLessThan(-300 + 40 + 1);
    expect(mesh.bounds.x).toBeGreaterThan(-300 + 37 - 1);
    expect(mesh.bounds.y).toBeGreaterThan(40 + 17 - 1);
  });

  it("returns nothing for an empty layer", () => {
    expect(puppetMeshFromAlpha(new Uint8ClampedArray(W * H * 4), W, H, 0, 0)).toBeNull();
  });
});
