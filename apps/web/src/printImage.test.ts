import { describe, expect, it } from "vitest";
import type { RasterDocumentState } from "@vravio/env-raster";
import { calculatePrintPlacement, defaultPrintSettings, documentPpi, pageLayoutFor } from "./printImage";

function fixture(overrides: Partial<RasterDocumentState> = {}): RasterDocumentState {
  return {
    kind: "raster", schemaVersion: 2, width: 900, height: 600, colorSpace: "srgb",
    resolution: 300, resolutionUnit: "ppi", bitDepth: 8, pixelAspectRatio: 1, backgroundColor: null,
    layers: [], activeLayerId: "layer-1", selection: null, guides: [],
    ...overrides,
  };
}

describe("print placement", () => {
  it("reads document resolution as ppi, falling back to 300 when unset or invalid", () => {
    expect(documentPpi({ resolution: 150, resolutionUnit: "ppi" })).toBe(150);
    expect(documentPpi({ resolution: 0, resolutionUnit: "ppi" })).toBe(300);
    expect(documentPpi({ resolution: Number.NaN, resolutionUnit: "ppi" })).toBe(300);
  });

  it("converts ppcm to ppi", () => {
    expect(documentPpi({ resolution: 100, resolutionUnit: "ppcm" })).toBeCloseTo(254, 5);
  });

  it("prints at actual size (document pixels / ppi) with no scaling", () => {
    const state = fixture(); // 900×600 px at 300 ppi = 3×2 in
    const page = pageLayoutFor(defaultPrintSettings);
    const placement = calculatePrintPlacement(state, { ...defaultPrintSettings, scaleMode: "actual" }, page);
    expect(placement.targetWidthIn).toBeCloseTo(3, 5);
    expect(placement.targetHeightIn).toBeCloseTo(2, 5);
    expect(placement.effectiveScalePercent).toBeCloseTo(100, 5);
  });

  it("fits a document larger than the printable area to the tighter axis", () => {
    // 3600×2400 px at 300 ppi = 12×8 in onto Letter's 7.5×10 in printable area (0.5in margins):
    // width ratio 7.5/12 = 0.625 is tighter than height ratio 10/8 = 1.25, so width governs.
    const state = fixture({ width: 3600, height: 2400 });
    const page = pageLayoutFor(defaultPrintSettings);
    const placement = calculatePrintPlacement(state, { ...defaultPrintSettings, scaleMode: "fit" }, page);
    expect(placement.effectiveScalePercent).toBeCloseTo(62.5, 5);
    expect(placement.targetWidthIn).toBeCloseTo(7.5, 5);
    expect(placement.targetHeightIn).toBeCloseTo(5, 5);
  });

  it("centers the placed image within the printable area by default", () => {
    const state = fixture(); // 3×2 in on Letter (8.5×11 in, 0.5in margins -> 7.5×10 in printable)
    const page = pageLayoutFor(defaultPrintSettings);
    const placement = calculatePrintPlacement(state, { ...defaultPrintSettings, scaleMode: "actual" }, page);
    expect(placement.targetXIn).toBeCloseTo(0.5 + (7.5 - 3) / 2, 5);
    expect(placement.targetYIn).toBeCloseTo(0.5 + (10 - 2) / 2, 5);
  });

  it("honors an explicit offset when centering is off", () => {
    const state = fixture();
    const page = pageLayoutFor(defaultPrintSettings);
    const placement = calculatePrintPlacement(state, { ...defaultPrintSettings, scaleMode: "actual", center: false, offsetXIn: 1, offsetYIn: 1.5 }, page);
    expect(placement.targetXIn).toBeCloseTo(0.5 + 1, 5);
    expect(placement.targetYIn).toBeCloseTo(0.5 + 1.5, 5);
  });

  it("clamps a custom scale percentage to the documented 1..1000 range", () => {
    const state = fixture();
    const page = pageLayoutFor(defaultPrintSettings);
    const over = calculatePrintPlacement(state, { ...defaultPrintSettings, scaleMode: "custom", scalePercent: 5000 }, page);
    expect(over.effectiveScalePercent).toBe(1000);
    const under = calculatePrintPlacement(state, { ...defaultPrintSettings, scaleMode: "custom", scalePercent: -10 }, page);
    expect(under.effectiveScalePercent).toBe(1);
  });

  it("swaps page width/height for landscape orientation", () => {
    const portrait = pageLayoutFor(defaultPrintSettings);
    const landscape = pageLayoutFor({ ...defaultPrintSettings, orientation: "landscape" });
    expect(landscape.widthIn).toBeCloseTo(portrait.heightIn, 5);
    expect(landscape.heightIn).toBeCloseTo(portrait.widthIn, 5);
  });

  it("prints only the selection bounds when area mode is selection", () => {
    const state = fixture({ selection: { mask: new Uint8ClampedArray(900 * 600), bounds: { x: 100, y: 100, width: 300, height: 300 } } });
    const page = pageLayoutFor(defaultPrintSettings);
    const placement = calculatePrintPlacement(state, { ...defaultPrintSettings, areaMode: "selection", scaleMode: "actual" }, page);
    expect(placement.sourceRect).toEqual({ x: 100, y: 100, width: 300, height: 300 });
    expect(placement.targetWidthIn).toBeCloseTo(1, 5); // 300px / 300ppi
  });

  it("falls back to the full document when area mode is selection but nothing is selected", () => {
    const state = fixture();
    const page = pageLayoutFor(defaultPrintSettings);
    const placement = calculatePrintPlacement(state, { ...defaultPrintSettings, areaMode: "selection" }, page);
    expect(placement.sourceRect).toEqual({ x: 0, y: 0, width: 900, height: 600 });
  });
});
