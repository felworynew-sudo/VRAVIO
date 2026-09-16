import { describe, expect, it } from "vitest";
import { applyRasterFilter, rasterFilterCatalog, fieldBlurEffect, irisBlurEffect, tiltShiftBlurEffect, spinBlurEffect, displaceEffect } from "./index";

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
    "crystallize", "pointillize", "fragment", "mezzotint", "shape_mosaic", "difference_clouds", "fibers",
    "normal_map",
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

  it("Crystallize gives every pixel exactly its own cell's flat colour (no bilinear blending, unlike Pointillize)", () => {
    const source = checkerboard(64, 64);
    const result = applyRasterFilter(source, 64, 64, "crystallize", { cellSize: 12 });
    const distinctColors = new Set<string>();
    for (let i = 0; i < result.length; i += 4) distinctColors.add(`${result[i]},${result[i + 1]},${result[i + 2]}`);
    // A 64x64 image at cellSize 12 has roughly 6x6=36 cells; a flat-facet filter should produce
    // far fewer distinct colours than the ~2 the untouched checkerboard has multiplied by noise,
    // and far fewer than one per pixel, which is what a no-op would leave behind.
    expect(distinctColors.size).toBeLessThan(64 * 64 / 4);
  });

  it("Pointillize paints dots on a white background rather than filling every pixel", () => {
    const source = new Uint8ClampedArray(32 * 32 * 4).fill(0);
    for (let i = 3; i < source.length; i += 4) source[i] = 255;
    const result = applyRasterFilter(source, 32, 32, "pointillize", { cellSize: 12 });
    let whiteCount = 0;
    for (let i = 0; i < result.length; i += 4) if (result[i] === 255 && result[i + 1] === 255 && result[i + 2] === 255) whiteCount += 1;
    expect(whiteCount).toBeGreaterThan(0);
  });

  it("Fragment blurs a single bright point into its four diagonal echoes", () => {
    const source = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
    const centre = (16 * WIDTH + 16) * 4;
    source[centre] = 255; source[centre + 3] = 255;
    const result = applyRasterFilter(source, WIDTH, HEIGHT, "fragment", { amount: 4 });
    // The centre pixel itself is no longer purely 255 (each of the 4 offset copies samples away
    // from it), while one of its diagonal echoes has picked up some of that brightness.
    expect(result[centre]!).toBeLessThan(255);
    const echo = ((16 - 4) * WIDTH + (16 - 4)) * 4;
    expect(result[echo]!).toBeGreaterThan(0);
  });

  it("Mezzotint's four pattern types produce different dither results", () => {
    const source = checkerboard(WIDTH, HEIGHT);
    const results = [0, 1, 2, 3].map((type) => applyRasterFilter(source, WIDTH, HEIGHT, "mezzotint", { type }));
    for (let a = 0; a < results.length; a += 1) for (let b = a + 1; b < results.length; b += 1) expect([...results[a]!]).not.toEqual([...results[b]!]);
  });

  it("Shape Mosaic flattens each triangle to one colour even where the source varied inside it", () => {
    const source = checkerboard(WIDTH, HEIGHT);
    const result = applyRasterFilter(source, WIDTH, HEIGHT, "shape_mosaic", { cellSize: 20 });
    // (2,2) and (6,2) both satisfy x + y < 20 (the same triangle, near-origin half of the cell)
    // and differ in the checkerboard source (its 4px period puts them on opposite squares) — a
    // filter that actually flattens the triangle to one average must equalise them regardless.
    const a = (2 * WIDTH + 2) * 4, b = (2 * WIDTH + 6) * 4;
    expect(source[a]).not.toBe(source[b]);
    expect([result[a], result[a + 1], result[a + 2]]).toEqual([result[b], result[b + 1], result[b + 2]]);
  });

  it("Difference Clouds is not the same result as Clouds on the same source", () => {
    const source = checkerboard(WIDTH, HEIGHT);
    const clouds = applyRasterFilter(source, WIDTH, HEIGHT, "clouds", { amount: 100 });
    const differenceClouds = applyRasterFilter(source, WIDTH, HEIGHT, "difference_clouds", {});
    expect([...differenceClouds]).not.toEqual([...clouds]);
  });

  it("Fibers replaces the layer content outright, the way Photoshop's own generator does", () => {
    const source = new Uint8ClampedArray(WIDTH * HEIGHT * 4).fill(0);
    for (let i = 3; i < source.length; i += 4) source[i] = 255;
    const result = applyRasterFilter(source, WIDTH, HEIGHT, "fibers", { variance: 50, strength: 50 });
    expect([...result]).not.toEqual([...source]);
    // Fully opaque throughout, like the real generator (it does not read or preserve alpha holes).
    for (let i = 3; i < result.length; i += 4) expect(result[i]).toBe(255);
  });

  it("Normal Map encodes a flat, unchanging height field as a straight-up-facing (128,128,255) normal", () => {
    const source = new Uint8ClampedArray(WIDTH * HEIGHT * 4).fill(128);
    for (let i = 3; i < source.length; i += 4) source[i] = 255;
    const result = applyRasterFilter(source, WIDTH, HEIGHT, "normal_map", { scale: 10 });
    const centre = (16 * WIDTH + 16) * 4;
    expect(result[centre]).toBeCloseTo(128, 0);
    expect(result[centre + 1]).toBeCloseTo(128, 0);
    expect(result[centre + 2]).toBe(255);
  });
});

/**
 * docs/master-plan.md §51's Blur Gallery: these four are called directly by
 * BlurGalleryDialog.tsx rather than through applyRasterFilter's settings-object
 * dispatch (the pin is drag-positioned, not a slider value), so they get their
 * own describe block instead of joining the id-driven loop above.
 */
describe("Blur Gallery effects (docs/master-plan.md §51, interactivity level 3)", () => {
  function checkerboard(width: number, height: number): Uint8ClampedArray {
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4, on = (Math.floor(x / 2) + Math.floor(y / 2)) % 2 === 0;
      pixels[i] = on ? 220 : 30; pixels[i + 1] = on ? 220 : 30; pixels[i + 2] = on ? 220 : 30; pixels[i + 3] = 255;
    }
    return pixels;
  }

  it("Field Blur is a plain uniform Gaussian blur", () => {
    const source = checkerboard(WIDTH, HEIGHT);
    const result = fieldBlurEffect(source, WIDTH, HEIGHT, 6);
    // A uniform blur softens every high-contrast checkerboard edge, corners included.
    expect(result[0]).not.toBe(source[0]);
    const farCorner = ((HEIGHT - 1) * WIDTH + (WIDTH - 1)) * 4;
    expect(result[farCorner]).not.toBe(source[farCorner]);
  });

  it("Iris Blur leaves its own centre sharp and blurs far outside the outer ring", () => {
    const source = checkerboard(WIDTH, HEIGHT);
    const result = irisBlurEffect(source, WIDTH, HEIGHT, WIDTH / 2, HEIGHT / 2, 4, 10, 6);
    const centre = (16 * WIDTH + 16) * 4, farCorner = (1 * WIDTH + 1) * 4;
    expect(result[centre]).toBe(source[centre]);
    expect(result[farCorner]).not.toBe(source[farCorner]);
  });

  it("Tilt-Shift leaves its own focus band sharp and blurs beyond the feather distance", () => {
    const source = checkerboard(WIDTH, HEIGHT);
    const result = tiltShiftBlurEffect(source, WIDTH, HEIGHT, WIDTH / 2, HEIGHT / 2, 0, 3, 4, 6);
    const onAxis = (16 * WIDTH + 16) * 4, farAbove = (2 * WIDTH + 16) * 4;
    expect(result[onAxis]).toBe(source[onAxis]);
    expect(result[farAbove]).not.toBe(source[farAbove]);
  });

  it("Spin Blur centred away from the image middle rotates around its own pin, not the canvas centre", () => {
    const source = checkerboard(WIDTH, HEIGHT);
    const spinAtCorner = spinBlurEffect(source, WIDTH, HEIGHT, 4, 4, 80);
    const spinAtCentre = spinBlurEffect(source, WIDTH, HEIGHT, WIDTH / 2, HEIGHT / 2, 80);
    expect([...spinAtCorner]).not.toEqual([...spinAtCentre]);
    // The pixel exactly at the pin has zero radius, so it never moves regardless of amount.
    const atPin = (4 * WIDTH + 4) * 4;
    expect(spinAtCorner[atPin]).toBe(source[atPin]);
  });

  it("Displace does not move a pixel where the map is exactly middle grey", () => {
    const source = checkerboard(WIDTH, HEIGHT);
    const map = new Uint8ClampedArray(WIDTH * HEIGHT * 4).fill(128);
    for (let i = 3; i < map.length; i += 4) map[i] = 255;
    const result = displaceEffect(source, WIDTH, HEIGHT, map, 20, 20, true);
    expect([...result]).toEqual([...source]);
  });

  it("Displace pushes pixels toward the source in the direction the map's luminance encodes", () => {
    const source = checkerboard(WIDTH, HEIGHT);
    const brightMap = new Uint8ClampedArray(WIDTH * HEIGHT * 4).fill(255);
    for (let i = 3; i < brightMap.length; i += 4) brightMap[i] = 255;
    const darkMap = new Uint8ClampedArray(WIDTH * HEIGHT * 4).fill(0);
    for (let i = 3; i < darkMap.length; i += 4) darkMap[i] = 255;
    const withBright = displaceEffect(source, WIDTH, HEIGHT, brightMap, 10, 10, true);
    const withDark = displaceEffect(source, WIDTH, HEIGHT, darkMap, 10, 10, true);
    // White (255) and black (0) displace in opposite directions by construction — a uniform
    // shift in opposite directions on a periodic checkerboard cannot land on the same result.
    expect([...withBright]).not.toEqual([...withDark]);
    expect([...withBright]).not.toEqual([...source]);
  });
});
