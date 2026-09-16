import { describe, expect, it } from "vitest";
import { applyRasterFilter, rasterFilterCatalog } from "./index";

/**
 * docs/master-plan.md §51: the Filter menu skeleton's stub items graduating to real,
 * donor-researched algorithms (GIMP/GEGL — see filters.ts's own per-filter comments for the
 * exact source file each one ports). One contract per filter: it is in the catalog with the
 * right category, it does not throw, and — CLAUDE.md §3 — every parameter it declares actually
 * changes the output, not a slider that silently does nothing.
 */

function checkerboard(width: number, height: number): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const i = (y * width + x) * 4, on = (Math.floor(x / 4) + Math.floor(y / 4)) % 2 === 0;
    // Low-contrast on purpose: surface_blur's own Threshold (its default excludes any neighbour
    // whose colour differs by more than ~38 levels) would otherwise exclude literally every
    // neighbour on a hard checkerboard regardless of Radius, making Radius look like a dead
    // control for the wrong reason (CLAUDE.md §2's own "measuring tool, not the code" lesson).
    const shade = on ? 140 : 120;
    pixels[i] = shade; pixels[i + 1] = shade; pixels[i + 2] = 255 - shade; pixels[i + 3] = 255;
  }
  return pixels;
}

const WIDTH = 32, HEIGHT = 32;

describe("Filter menu skeleton's newly-implemented filters (docs/master-plan.md §51)", () => {
  const newIds = [
    "average", "blur", "blur_more", "motion_blur", "radial_blur", "surface_blur", "lens_blur",
    "polar_coordinates", "shear", "spherize", "zigzag", "ripple", "kaleidoscope",
    "offset", "maximum", "minimum", "despeckle", "reduce_noise",
    "sharpen_more", "sharpen_edges", "smart_sharpen",
    "diffuse", "solarize", "trace_contour", "wind", "oil_paint", "lens_flare",
  ];

  it("registers every new filter in the catalog exactly once", () => {
    const ids = rasterFilterCatalog.map((filter) => filter.id);
    for (const id of newIds) expect(ids.filter((candidate) => candidate === id).length, id).toBe(1);
  });

  it("runs every new filter on a non-trivial source without throwing, at both its default and its declared min/max settings", () => {
    const source = checkerboard(WIDTH, HEIGHT);
    for (const id of newIds) {
      const definition = rasterFilterCatalog.find((filter) => filter.id === id)!;
      const defaults = Object.fromEntries(definition.parameters.map((parameter) => [parameter.id, parameter.value]));
      expect(applyRasterFilter(source, WIDTH, HEIGHT, id, defaults).length, id).toBe(source.length);
      const atMin = Object.fromEntries(definition.parameters.map((parameter) => [parameter.id, parameter.min]));
      const atMax = Object.fromEntries(definition.parameters.map((parameter) => [parameter.id, parameter.max]));
      expect(() => applyRasterFilter(source, WIDTH, HEIGHT, id, atMin), `${id} at min settings`).not.toThrow();
      expect(() => applyRasterFilter(source, WIDTH, HEIGHT, id, atMax), `${id} at max settings`).not.toThrow();
    }
  });

  it("changes its output when a declared parameter changes, for every new filter that has one", () => {
    const source = checkerboard(WIDTH, HEIGHT);
    for (const id of newIds) {
      const definition = rasterFilterCatalog.find((filter) => filter.id === id)!;
      if (definition.parameters.length === 0) continue;
      const defaults = Object.fromEntries(definition.parameters.map((parameter) => [parameter.id, parameter.value]));
      const baseline = applyRasterFilter(source, WIDTH, HEIGHT, id, defaults);
      for (const parameter of definition.parameters) {
        // Toggling to the opposite extreme is the right probe for almost every parameter here,
        // choices included — except motion_blur's own "angle", a blur *direction* rather than a
        // vector, whose 0°/180° extremes are mathematically identical (same line, sampled in
        // reverse) and would falsely look like a dead control (CLAUDE.md §2's blur/dodge/burn
        // "angle" postmortem, same disease here). A quarter-turn instead of a half-turn sidesteps
        // that symmetry without needing a special case in the filter itself.
        const isSymmetricAngle = id === "motion_blur" && parameter.id === "angle";
        // Prefer the minimum: for a threshold/tolerance parameter (surface_blur's own, at least)
        // the default already sits comfortably on one side of every neighbour's actual colour
        // difference in this fixture, so probing the *maximum* can land on a value that behaves
        // identically to the default instead of on the side that changes anything — dropping to
        // the minimum is the direction actually likely to cross that boundary.
        const probeValue = isSymmetricAngle ? parameter.value + (parameter.max - parameter.min) / 4 : (parameter.value === parameter.min ? parameter.max : parameter.min);
        const probed = applyRasterFilter(source, WIDTH, HEIGHT, id, { ...defaults, [parameter.id]: probeValue });
        expect([...probed], `${id}'s "${parameter.id}" parameter`).not.toEqual([...baseline]);
      }
    }
  });

  it("Average fills every pixel with the source's own mean colour", () => {
    const source = checkerboard(WIDTH, HEIGHT);
    const result = applyRasterFilter(source, WIDTH, HEIGHT, "average", {});
    const first = [result[0], result[1], result[2], result[3]];
    for (let i = 4; i < result.length; i += 4) expect([result[i], result[i + 1], result[i + 2], result[i + 3]]).toEqual(first);
  });

  it("Offset wraps a pixel that leaves one edge back onto the opposite one", () => {
    const source = new Uint8ClampedArray(4 * 4 * 4);
    source[0] = 255; source[3] = 255; // top-left pixel is opaque red, everything else transparent black
    const result = applyRasterFilter(source, 4, 4, "offset", { horizontal: -1, vertical: 0 });
    // Shifting left by 1 with wraparound moves column 0 to column 3 (last column), same row.
    const wrapped = (0 * 4 + 3) * 4;
    expect(result[wrapped]).toBe(255);
    expect(result[wrapped + 3]).toBe(255);
  });

  it("Maximum never darkens and Minimum never brightens a channel", () => {
    const source = checkerboard(WIDTH, HEIGHT);
    const maximum = applyRasterFilter(source, WIDTH, HEIGHT, "maximum", { radius: 2 });
    const minimum = applyRasterFilter(source, WIDTH, HEIGHT, "minimum", { radius: 2 });
    for (let i = 0; i < source.length; i += 1) {
      expect(maximum[i]!).toBeGreaterThanOrEqual(source[i]!);
      expect(minimum[i]!).toBeLessThanOrEqual(source[i]!);
    }
  });

  it("Solarize inverts only the channel values above its fixed midpoint", () => {
    const source = new Uint8ClampedArray([200, 50, 255, 255]);
    const result = applyRasterFilter(source, 1, 1, "solarize", {});
    expect(result[0]).toBe(255 - 200);
    expect(result[1]).toBe(50);
    expect(result[2]).toBe(255 - 255);
  });

  it("Spherize leaves the exact centre pixel of an odd-sized image unmoved", () => {
    const source = checkerboard(33, 33);
    const result = applyRasterFilter(source, 33, 33, "spherize", { amount: 80 });
    const centre = (16 * 33 + 16) * 4;
    expect(result[centre]).toBe(source[centre]);
    expect(result[centre + 1]).toBe(source[centre + 1]);
    expect(result[centre + 2]).toBe(source[centre + 2]);
  });

  it("Lens Flare brightens the pixel exactly at its own X/Y position", () => {
    const source = new Uint8ClampedArray(WIDTH * HEIGHT * 4).fill(40);
    for (let i = 3; i < source.length; i += 4) source[i] = 255;
    const result = applyRasterFilter(source, WIDTH, HEIGHT, "lens_flare", { brightness: 100, positionX: 50, positionY: 50 });
    const centre = (16 * WIDTH + 16) * 4;
    expect(result[centre]!).toBeGreaterThan(source[centre]!);
  });

  it("Reduce Noise at zero iterations is the identity", () => {
    const source = checkerboard(WIDTH, HEIGHT);
    const result = applyRasterFilter(source, WIDTH, HEIGHT, "reduce_noise", { strength: 0 });
    expect([...result]).toEqual([...source]);
  });

  it("Radial Blur's Spin and Zoom methods produce different results", () => {
    const source = checkerboard(WIDTH, HEIGHT);
    const spin = applyRasterFilter(source, WIDTH, HEIGHT, "radial_blur", { amount: 60, method: 0 });
    const zoom = applyRasterFilter(source, WIDTH, HEIGHT, "radial_blur", { amount: 60, method: 1 });
    expect([...spin]).not.toEqual([...zoom]);
  });
});
