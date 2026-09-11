import { describe, expect, it } from "vitest";
import { RULER_CORNER_SIZE, rulerLocalPosition } from "./raster-coordinates";

describe("rulerLocalPosition", () => {
  it("keeps the document's workspace zero aligned with the first drawable ruler pixel", () => {
    expect(rulerLocalPosition(RULER_CORNER_SIZE)).toBe(0);
  });

  it("does not change the document coordinate when zoom or pan changes its workspace position", () => {
    expect(rulerLocalPosition(418)).toBe(400);
    expect(rulerLocalPosition(818)).toBe(800);
  });
});
