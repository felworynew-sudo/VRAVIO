import { describe, expect, it } from "vitest";
import { WARP_GRID, meshLayerPixels, regularMesh, quadLayerPixels } from "./index";

/**
 * master-plan.md §1.1: "деформация визуально не выглядит как искажение —
 * пиксели не интерполируются между соседними точками сетки корректно".
 *
 * Two separate faults sat behind that sentence, and these check both.
 *
 * The mesh warped one cell at a time and fed each cell's *output* into the next
 * cell as its source, so every cell after the first resampled a picture the
 * previous cells had already resampled and partly erased — sixteen chained
 * resamples for a 4x4 grid. And the sampler took the nearest source pixel
 * (`Math.floor`), so even a single cell reproduced its content as blocks rather
 * than interpolating between neighbours.
 */

const WIDTH = 64, HEIGHT = 64;
const BOUNDS = { x: 8, y: 8, width: 48, height: 48 };

/** A smooth horizontal ramp: the one picture where nearest-neighbour sampling
 * and interpolation give visibly different answers. */
function ramp(): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y += 1) for (let x = 0; x < WIDTH; x += 1) {
    const index = (y * WIDTH + x) * 4;
    pixels[index] = Math.round((x / (WIDTH - 1)) * 255);
    pixels[index + 1] = Math.round((y / (HEIGHT - 1)) * 255);
    pixels[index + 2] = 128;
    pixels[index + 3] = 255;
  }
  return pixels;
}

const at = (pixels: Uint8ClampedArray, x: number, y: number) => {
  const index = (y * WIDTH + x) * 4;
  return [pixels[index]!, pixels[index + 1]!, pixels[index + 2]!, pixels[index + 3]!];
};

describe("warp mesh", () => {
  it("leaves the picture alone when no anchor has been moved", () => {
    // The identity case, and the one that catches cell-to-cell smearing on its
    // own: a mesh still sitting on its regular grid describes no deformation at
    // all, so every pixel inside the warped area must come back as it was.
    const source = ramp();
    const output = meshLayerPixels(source, WIDTH, HEIGHT, BOUNDS, regularMesh(BOUNDS, WARP_GRID), null);

    let worst = 0;
    for (let y = BOUNDS.y + 2; y < BOUNDS.y + BOUNDS.height - 2; y += 1) {
      for (let x = BOUNDS.x + 2; x < BOUNDS.x + BOUNDS.width - 2; x += 1) {
        const [r, g, , a] = at(output, x, y);
        const [sr, sg, , sa] = at(source, x, y);
        worst = Math.max(worst, Math.abs(r - sr), Math.abs(g - sg), Math.abs(a - sa));
      }
    }
    // One step of resampling on a ramp costs a unit or two of rounding; a
    // picture that has been through sixteen of them does not stay this close.
    expect(worst).toBeLessThanOrEqual(2);
  });

  it("interpolates between neighbouring pixels instead of stepping between them", () => {
    // Warped by a fractional amount, a ramp sampled by nearest neighbour keeps
    // only the values it already had — the tell of no interpolation is that the
    // set of values does not grow. Bilinear sampling produces the in-between
    // ones.
    const source = ramp();
    const mesh = regularMesh(BOUNDS, WARP_GRID).map((point) => ({ x: point.x + 0.5, y: point.y }));
    const output = meshLayerPixels(source, WIDTH, HEIGHT, BOUNDS, mesh, null);

    const sourceValues = new Set<number>(), outputValues = new Set<number>();
    const row = BOUNDS.y + Math.floor(BOUNDS.height / 2);
    for (let x = BOUNDS.x + 2; x < BOUNDS.x + BOUNDS.width - 2; x += 1) {
      sourceValues.add(at(source, x, row)[0]!);
      outputValues.add(at(output, x, row)[0]!);
    }
    const halfSteps = [...outputValues].filter((value) => !sourceValues.has(value));
    expect(halfSteps.length).toBeGreaterThan(0);
  });

  it("moves content where the anchor was dragged", () => {
    // The whole mesh shifted right by 8: the deformation is a translation, so
    // what was at x is at x + 8. A cell-chained warp cannot do this either —
    // later cells erase what earlier ones wrote.
    const source = ramp();
    const mesh = regularMesh(BOUNDS, WARP_GRID).map((point) => ({ x: point.x + 8, y: point.y }));
    const output = meshLayerPixels(source, WIDTH, HEIGHT, BOUNDS, mesh, null);

    const y = BOUNDS.y + 20;
    for (const x of [BOUNDS.x + 10, BOUNDS.x + 20, BOUNDS.x + 30]) {
      expect(Math.abs(at(output, x + 8, y)[0]! - at(source, x, y)[0]!)).toBeLessThanOrEqual(2);
    }
  });

  it("keeps a dragged corner's cell attached to its neighbours", () => {
    // One anchor pulled: the picture must stay continuous across the cell
    // borders, with no holes where a cell cleared what its neighbour had drawn.
    const source = ramp();
    const mesh = regularMesh(BOUNDS, WARP_GRID).map((point, index) => index === 0 ? { x: point.x - 6, y: point.y - 6 } : point);
    const output = meshLayerPixels(source, WIDTH, HEIGHT, BOUNDS, mesh, null);

    let transparent = 0;
    for (let y = BOUNDS.y + 4; y < BOUNDS.y + BOUNDS.height - 4; y += 1) {
      for (let x = BOUNDS.x + 4; x < BOUNDS.x + BOUNDS.width - 4; x += 1) if (at(output, x, y)[3] === 0) transparent += 1;
    }
    expect(transparent).toBe(0);
  });
});

describe("quad warp sampling", () => {
  it("interpolates as well, so skew and distort are not blocky either", () => {
    const source = ramp();
    const corners = [
      { x: BOUNDS.x + 0.5, y: BOUNDS.y },
      { x: BOUNDS.x + BOUNDS.width + 0.5, y: BOUNDS.y },
      { x: BOUNDS.x + BOUNDS.width + 0.5, y: BOUNDS.y + BOUNDS.height },
      { x: BOUNDS.x + 0.5, y: BOUNDS.y + BOUNDS.height },
    ] as const;
    const output = quadLayerPixels(source, WIDTH, HEIGHT, BOUNDS, corners, null);

    const sourceValues = new Set<number>(), outputValues = new Set<number>();
    const row = BOUNDS.y + 20;
    for (let x = BOUNDS.x + 2; x < BOUNDS.x + BOUNDS.width - 2; x += 1) {
      sourceValues.add(at(source, x, row)[0]!);
      outputValues.add(at(output, x, row)[0]!);
    }
    expect([...outputValues].filter((value) => !sourceValues.has(value)).length).toBeGreaterThan(0);
  });
});
