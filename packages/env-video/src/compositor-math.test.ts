import { describe, expect, it } from "vitest";
import { destRectFor, sourceRectFor } from "./compositor-math";

describe("sourceRectFor", () => {
  it("is the whole source frame with no crop", () => {
    const rect = sourceRectFor({ sourceWidth: 1920, sourceHeight: 1080, cropLeft: 0, cropTop: 0, cropRight: 0, cropBottom: 0 });
    expect(rect).toEqual({ sx: 0, sy: 0, sw: 1920, sh: 1080 });
  });

  it("crops a fraction off each edge", () => {
    const rect = sourceRectFor({ sourceWidth: 1000, sourceHeight: 1000, cropLeft: 0.1, cropTop: 0.2, cropRight: 0.1, cropBottom: 0 });
    expect(rect.sx).toBe(100);
    expect(rect.sy).toBe(200);
    expect(rect.sw).toBe(800);
    expect(rect.sh).toBe(800);
  });

  it("never collapses to a zero-size rect even at a degenerate crop", () => {
    const rect = sourceRectFor({ sourceWidth: 100, sourceHeight: 100, cropLeft: 0.5, cropTop: 0.5, cropRight: 0.5, cropBottom: 0.5 });
    expect(rect.sw).toBeGreaterThanOrEqual(1);
    expect(rect.sh).toBeGreaterThanOrEqual(1);
  });
});

describe("destRectFor", () => {
  it("fits a same-aspect-ratio source exactly, centered, at scale 1", () => {
    const source = sourceRectFor({ sourceWidth: 1920, sourceHeight: 1080, cropLeft: 0, cropTop: 0, cropRight: 0, cropBottom: 0 });
    const dest = destRectFor({ x: 0, y: 0, scale: 1 }, source, 1920, 1080);
    expect(dest).toEqual({ dx: 0, dy: 0, dw: 1920, dh: 1080 });
  });

  it("letterboxes a narrower source, centered on both axes", () => {
    // 4:3 source into a 16:9 document — fit by height, pillarboxed left/right.
    const source = sourceRectFor({ sourceWidth: 1200, sourceHeight: 900, cropLeft: 0, cropTop: 0, cropRight: 0, cropBottom: 0 });
    const dest = destRectFor({ x: 0, y: 0, scale: 1 }, source, 1920, 1080);
    expect(dest.dh).toBe(1080);
    expect(dest.dw).toBeCloseTo(1440, 5); // 1200 * (1080/900)
    expect(dest.dx).toBeCloseTo((1920 - 1440) / 2, 5);
    expect(dest.dy).toBe(0);
  });

  it("scales around the fitted rect's own center, not the document corner", () => {
    const source = sourceRectFor({ sourceWidth: 1920, sourceHeight: 1080, cropLeft: 0, cropTop: 0, cropRight: 0, cropBottom: 0 });
    const dest = destRectFor({ x: 0, y: 0, scale: 2 }, source, 1920, 1080);
    expect(dest.dw).toBe(3840);
    expect(dest.dh).toBe(2160);
    // Center must stay at the document's own center (960, 540).
    expect(dest.dx + dest.dw / 2).toBeCloseTo(960, 5);
    expect(dest.dy + dest.dh / 2).toBeCloseTo(540, 5);
  });

  it("offsets by x/y from the centered fit position", () => {
    const source = sourceRectFor({ sourceWidth: 1920, sourceHeight: 1080, cropLeft: 0, cropTop: 0, cropRight: 0, cropBottom: 0 });
    const dest = destRectFor({ x: 50, y: -30, scale: 1 }, source, 1920, 1080);
    expect(dest.dx).toBe(50);
    expect(dest.dy).toBe(-30);
  });
});
