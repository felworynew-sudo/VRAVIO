import { describe, expect, it } from "vitest";
import { applyCameraRawFilter, defaultCameraRawFilterSettings } from "./camera-raw-filter";

const settings = () => ({ ...defaultCameraRawFilterSettings, hsl: Object.fromEntries(
  Object.entries(defaultCameraRawFilterSettings.hsl).map(([name, value]) => [name, { ...value }]),
) as typeof defaultCameraRawFilterSettings.hsl });

describe("Camera Raw colour mixer", () => {
  it("keeps neutral HSL controls pixel-identical", () => {
    const source = Uint8ClampedArray.from([40, 120, 200, 255, 220, 80, 30, 128]);
    expect([...applyCameraRawFilter(source, 2, 1, settings())]).toEqual([...source]);
  });

  it("still applies a non-neutral HSL channel", () => {
    const source = Uint8ClampedArray.from([220, 30, 30, 255]);
    const adjusted = settings();
    adjusted.hsl.red.saturation = -100;

    const result = applyCameraRawFilter(source, 1, 1, adjusted);
    expect(result[0]).toBeCloseTo(result[1]!, -1);
    expect(result[1]).toBeCloseTo(result[2]!, -1);
    expect(result[3]).toBe(255);
  });
});
