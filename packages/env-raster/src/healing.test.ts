import { describe, expect, it } from "vitest";
import { cloneDab, cloneStrokeSegment, createPatchRegion, solveHealMembrane, spotHealApply, spotHealSourceMap } from "./index";

const W = 64, H = 64;

/** A smooth field with real low-frequency variation, so a sample taken from
 *  elsewhere in the image does not already match its destination. */
const field = (x: number, y: number) => 30 + ((x - 8) ** 2 + (y - 8) ** 2) / 26;

function canvas(): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) {
    const index = (y * W + x) * 4, value = field(x, y);
    pixels[index] = value; pixels[index + 1] = value; pixels[index + 2] = value; pixels[index + 3] = 255;
  }
  return pixels;
}

function addBlemish(pixels: Uint8ClampedArray, centerX: number, centerY: number, radius: number): void {
  for (let y = centerY - radius; y <= centerY + radius; y += 1) for (let x = centerX - radius; x <= centerX + radius; x += 1) {
    if (Math.hypot(x - centerX, y - centerY) > radius) continue;
    const index = (y * W + x) * 4;
    pixels[index] = 250; pixels[index + 1] = 10; pixels[index + 2] = 10;
  }
}

const roundMask = (width: number, height: number, originX: number, originY: number, centerX: number, centerY: number, radius: number) => {
  const mask = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    mask[y * width + x] = Math.hypot(originX + x - centerX, originY + y - centerY) <= radius ? 255 : 0;
  }
  return mask;
};

/** Largest distance from the underlying smooth field, over pixels within `radius` of the centre. */
function worstError(pixels: Uint8ClampedArray, centerX: number, centerY: number, from: number, to: number): number {
  let worst = 0;
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) {
    const distance = Math.hypot(x - centerX, y - centerY);
    if (distance < from || distance > to) continue;
    worst = Math.max(worst, Math.abs(pixels[(y * W + x) * 4]! - field(x, y)));
  }
  return worst;
}

describe("heal membrane solver", () => {
  const S = 32;

  /** A frame of boundary cells around an interior square. */
  const membrane = (boundary: (x: number, y: number) => number) => {
    const interior = new Uint8Array(S * S), offsets = new Int16Array(S * S * 3);
    for (let y = 0; y < S; y += 1) for (let x = 0; x < S; x += 1) {
      const index = y * S + x, inside = x > 3 && x < S - 4 && y > 3 && y < S - 4;
      interior[index] = inside ? 1 : 0;
      if (!inside) { const value = boundary(x, y); offsets[index * 3] = value; offsets[index * 3 + 1] = value; offsets[index * 3 + 2] = value; }
    }
    return { interior, offsets };
  };

  const interiorValues = (interior: Uint8Array, offsets: Int16Array) => {
    const values: number[] = [];
    for (let index = 0; index < S * S; index += 1) if (interior[index]) values.push(offsets[index * 3]!);
    return values;
  };

  it("carries a constant boundary through the whole interior", () => {
    // A harmonic function with a constant boundary is that constant. This is
    // also the regression for the fixed-point overflow: the relaxation used to
    // scale its correction with `>>`, which coerces to Int32 and wrapped for
    // any residual past 0.3 of an offset unit, so this returned roughly zero.
    const { interior, offsets } = membrane(() => 100);

    solveHealMembrane(interior, S, S, offsets);

    expect(Math.min(...interiorValues(interior, offsets))).toBe(100);
    expect(Math.max(...interiorValues(interior, offsets))).toBe(100);
  });

  it("interpolates a linear boundary exactly", () => {
    const { interior, offsets } = membrane((x) => x * 4);

    solveHealMembrane(interior, S, S, offsets);

    for (let y = 0; y < S; y += 1) for (let x = 0; x < S; x += 1) {
      if (interior[y * S + x]) expect(offsets[(y * S + x) * 3]).toBe(x * 4);
    }
  });

  it("keeps the interior inside the range of the boundary", () => {
    const { interior, offsets } = membrane((x, y) => ((x * 7 + y * 13) % 200) - 100);

    solveHealMembrane(interior, S, S, offsets);

    // The maximum principle. Violating it means the heal invents colours that
    // appear nowhere around the area being repaired.
    const values = interiorValues(interior, offsets);
    expect(Math.min(...values)).toBeGreaterThanOrEqual(-100);
    expect(Math.max(...values)).toBeLessThanOrEqual(99);
  });

  it("converges to a harmonic field", () => {
    const { interior, offsets } = membrane((x, y) => ((x * 7 + y * 13) % 200) - 100);

    solveHealMembrane(interior, S, S, offsets);

    let residual = 0;
    for (let y = 1; y < S - 1; y += 1) for (let x = 1; x < S - 1; x += 1) {
      const index = y * S + x;
      if (!interior[index]) continue;
      const average = (offsets[(index - 1) * 3]! + offsets[(index + 1) * 3]! + offsets[(index - S) * 3]! + offsets[(index + S) * 3]!) / 4;
      residual = Math.max(residual, Math.abs(offsets[index * 3]! - average));
    }
    // Each interior value is the average of its neighbours, to within rounding.
    expect(residual).toBeLessThanOrEqual(1);
  });

  it("leaves the field alone when it is all interior or all boundary", () => {
    for (const fill of [1, 0]) {
      const interior = new Uint8Array(S * S).fill(fill), offsets = new Int16Array(S * S * 3).fill(55);

      // Neither case defines a solvable problem; the field must survive intact
      // rather than being zeroed.
      solveHealMembrane(interior, S, S, offsets);
      expect([...offsets].every((value) => value === 55)).toBe(true);
    }
  });

  it("does nothing on an empty field", () => {
    expect(() => solveHealMembrane(new Uint8Array(0), 0, 0, new Int16Array(0))).not.toThrow();
  });
});

describe("spot healing brush", () => {
  const originX = 22, originY = 22, maskSize = 20;
  const mask = () => roundMask(maskSize, maskSize, originX, originY, 32, 32, 7);

  it("replaces a blemish with the surrounding gradient rather than with the sampled patch", () => {
    const pixels = canvas();
    addBlemish(pixels, 32, 32, 5);

    spotHealApply(pixels, W, H, mask(), originX, originY, maskSize, maskSize, 1);

    let red = 0;
    for (let index = 0; index < pixels.length; index += 4) if (pixels[index]! > 150 && pixels[index + 1]! < 60) red += 1;
    expect(red).toBe(0);
    // The sample comes from elsewhere in a field that varies, so landing on the
    // right value here is the membrane doing its job, not the copy.
    expect(worstError(pixels, 32, 32, 0, 5)).toBeLessThanOrEqual(4);
  });

  it("leaves no step at the seam", () => {
    const pixels = canvas();
    addBlemish(pixels, 32, 32, 5);

    spotHealApply(pixels, W, H, mask(), originX, originY, maskSize, maskSize, 1);

    // Just outside the healed disc the pixels were never touched. A membrane
    // solved with the wrong boundary meets them with a visible edge.
    expect(worstError(pixels, 32, 32, 6.5, 8)).toBeLessThanOrEqual(2);
  });

  it("blends toward the original at partial opacity", () => {
    const full = canvas(), half = canvas();
    addBlemish(full, 32, 32, 5);
    addBlemish(half, 32, 32, 5);

    spotHealApply(full, W, H, mask(), originX, originY, maskSize, maskSize, 1);
    spotHealApply(half, W, H, mask(), originX, originY, maskSize, maskSize, 0.5);

    const center = (32 * W + 32) * 4;
    expect(half[center]!).toBeGreaterThan(full[center]!);
    expect(half[center + 1]!).toBeLessThan(250);
  });

  it("reports an empty mask as unusable instead of sampling from nowhere", () => {
    const empty = new Uint8ClampedArray(maskSize * maskSize);
    const pixels = canvas();
    const before = pixels.slice();

    expect(spotHealSourceMap(empty, maskSize, maskSize, W, H, originX, originY).valid).toBe(false);
    spotHealApply(pixels, W, H, empty, originX, originY, maskSize, maskSize, 1);
    expect([...pixels]).toEqual([...before]);
  });
});

describe("patch tool", () => {
  it("moves a clean area over a blemish and matches the destination lighting", () => {
    const pixels = canvas();
    addBlemish(pixels, 32, 32, 5);
    const size = 20, originX = 22, originY = 22;

    createPatchRegion(pixels, W, H, roundMask(size, size, originX, originY, 32, 32, 7), size, size, originX, originY, 14, 0, 1);

    let red = 0;
    for (let index = 0; index < pixels.length; index += 4) if (pixels[index]! > 150 && pixels[index + 1]! < 60) red += 1;
    expect(red).toBe(0);
    // The source is fourteen pixels to the right, where the field is brighter.
    // Without the membrane the patch drops that brighter tone in as a disc.
    expect(worstError(pixels, 32, 32, 0, 5)).toBeLessThanOrEqual(4);
    expect(worstError(pixels, 32, 32, 6.5, 8)).toBeLessThanOrEqual(2);
  });

  it("ignores a source that falls outside the canvas", () => {
    const pixels = canvas();
    const before = pixels.slice();
    const size = 8;

    createPatchRegion(pixels, W, H, new Uint8ClampedArray(size * size).fill(255), size, size, 2, 2, -40, 0, 1);

    expect([...pixels]).toEqual([...before]);
  });
});

describe("clone stamp", () => {
  const flat = (): Uint8ClampedArray => {
    const pixels = new Uint8ClampedArray(W * H * 4);
    for (let index = 0; index < pixels.length; index += 4) { pixels[index + 3] = 255; }
    return pixels;
  };

  const markSquare = (pixels: Uint8ClampedArray, x0: number, y0: number, size: number) => {
    for (let y = y0; y < y0 + size; y += 1) for (let x = x0; x < x0 + size; x += 1) {
      const index = (y * W + x) * 4;
      pixels[index] = 200; pixels[index + 1] = 100; pixels[index + 2] = 50; pixels[index + 3] = 255;
    }
  };

  it("stamps the colour found at the source offset", () => {
    const pixels = flat();
    markSquare(pixels, 8, 8, 12);

    cloneDab(pixels, W, H, 14, 14, 40, 40, 8, 1, 1);

    const index = (40 * W + 40) * 4;
    expect([pixels[index], pixels[index + 1], pixels[index + 2]]).toEqual([200, 100, 50]);
  });

  it("does not paint where the selection excludes it", () => {
    const pixels = flat();
    markSquare(pixels, 8, 8, 12);
    const selection = new Uint8ClampedArray(W * H);
    for (let y = 0; y < H; y += 1) for (let x = 0; x < 40; x += 1) selection[y * W + x] = 255;

    cloneDab(pixels, W, H, 14, 14, 40, 40, 12, 1, 1, selection);

    expect(pixels[(40 * W + 42) * 4]).toBe(0);
    expect(pixels[(40 * W + 38) * 4]).toBe(200);
  });

  it("clips a dab that runs past the edge instead of wrapping to the next row", () => {
    const pixels = flat();
    markSquare(pixels, 8, 8, 12);

    expect(() => cloneDab(pixels, W, H, 14, 14, W - 2, 3, 16, 1, 1)).not.toThrow();
    // Wrapping would show up as paint at the start of the following row.
    expect(pixels[(4 * W + 0) * 4]).toBe(0);
  });

  it("samples the buffer it was handed, not the one it is writing into", () => {
    const source = flat();
    markSquare(source, 0, 0, W);
    const separate = flat(), inPlace = flat();

    // Source and target coincide, so the only thing that decides the outcome is
    // which buffer the dabs read. Reading the destination is what makes a clone
    // stroke smear its own output back over itself.
    cloneStrokeSegment(separate, W, H, { x: 20, y: 40 }, { x: 44, y: 40 }, 0, 0, 6, 1, undefined, 1, 1, 0, true, false, source);
    cloneStrokeSegment(inPlace, W, H, { x: 20, y: 40 }, { x: 44, y: 40 }, 0, 0, 6, 1, undefined, 1, 1, 0, true, false);

    for (const x of [20, 32, 44]) {
      const index = (40 * W + x) * 4;
      expect([separate[index], separate[index + 1], separate[index + 2]]).toEqual([200, 100, 50]);
      expect(inPlace[index]).toBe(0);
    }
  });
});
