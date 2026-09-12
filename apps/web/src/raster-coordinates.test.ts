import { describe, expect, it } from "vitest";
import { RULER_CORNER_SIZE, rulerLocalPosition, visibleRasterDocumentRect } from "./raster-coordinates";

describe("rulerLocalPosition", () => {
  it("keeps the document's workspace zero aligned with the first drawable ruler pixel", () => {
    expect(rulerLocalPosition(RULER_CORNER_SIZE)).toBe(0);
  });

  it("does not change the document coordinate when zoom or pan changes its workspace position", () => {
    expect(rulerLocalPosition(418)).toBe(400);
    expect(rulerLocalPosition(818)).toBe(800);
  });
});

const workspace = { width: 800, height: 600 };

describe("visible raster document rectangle", () => {
  it("maps an unrotated, centred workspace to document coordinates", () => {
    expect(visibleRasterDocumentRect(workspace, { zoom: 2, panX: 0, panY: 0, rotation: 0, mode: "custom" }, 2000, 1200))
      .toEqual({ x: 800, y: 450, width: 400, height: 300 });
  });

  it("accounts for pan and conservatively covers rotation", () => {
    const rect = visibleRasterDocumentRect(workspace, { zoom: 1, panX: 100, panY: -50, rotation: 90, mode: "custom" }, 2000, 1200);
    expect(rect).toEqual({ x: 750, y: 300, width: 600, height: 800 });
  });

  it("does not request tiles before the workspace has a measured size", () => {
    expect(visibleRasterDocumentRect({ width: 0, height: 600 }, { zoom: 1, panX: 0, panY: 0, rotation: 0, mode: "fit" }, 2000, 1200))
      .toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});
