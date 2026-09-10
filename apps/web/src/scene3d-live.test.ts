import { describe, expect, it } from "vitest";
import { trackOffsetFromValue, valueFromTrackOffset } from "./scene3d-live";

describe("valueFromTrackOffset", () => {
  it("maps the left end of the track to the range's minimum", () => {
    expect(valueFromTrackOffset(0, 200, -180, 180)).toBe(-180);
  });

  it("maps the right end of the track to the range's maximum", () => {
    expect(valueFromTrackOffset(200, 200, -180, 180)).toBe(180);
  });

  it("maps the middle of the track to the range's midpoint", () => {
    expect(valueFromTrackOffset(100, 200, -180, 180)).toBe(0);
  });

  it("clamps an offset past either end of the track instead of extrapolating", () => {
    expect(valueFromTrackOffset(-50, 200, -180, 180)).toBe(-180);
    expect(valueFromTrackOffset(400, 200, -180, 180)).toBe(180);
  });

  it("guards a degenerate (zero or negative) track length rather than dividing by zero", () => {
    expect(valueFromTrackOffset(50, 0, -180, 180)).toBe(-180);
    expect(valueFromTrackOffset(50, -10, -180, 180)).toBe(-180);
  });

  it("works for an arbitrary positive range, not just a signed one — the ground plane's own tilt/distance sliders", () => {
    expect(valueFromTrackOffset(0, 100, 0, 90)).toBe(0);
    expect(valueFromTrackOffset(100, 100, 0, 90)).toBe(90);
    expect(valueFromTrackOffset(50, 100, 0, 90)).toBe(45);
  });
});

describe("trackOffsetFromValue", () => {
  it("places the knob at the track's own two ends for the range's extremes", () => {
    expect(trackOffsetFromValue(-180, 200, -180, 180)).toBe(0);
    expect(trackOffsetFromValue(180, 200, -180, 180)).toBe(200);
  });

  it("places the knob at the middle for the range's midpoint", () => {
    expect(trackOffsetFromValue(0, 200, -180, 180)).toBe(100);
  });

  it("clamps a value outside the slider's own range instead of pushing the knob off the track", () => {
    expect(trackOffsetFromValue(-270, 200, -180, 180)).toBe(0);
    expect(trackOffsetFromValue(270, 200, -180, 180)).toBe(200);
  });

  it("guards a degenerate (zero-width or inverted) range rather than dividing by zero", () => {
    expect(trackOffsetFromValue(5, 200, 10, 10)).toBe(0);
  });
});

describe("valueFromTrackOffset / trackOffsetFromValue round-trip", () => {
  it("recovers the same knob position it started from", () => {
    const trackLength = 240;
    for (const value of [-180, -90, -45, 0, 30, 90, 180]) {
      const offset = trackOffsetFromValue(value, trackLength, -180, 180);
      const recovered = valueFromTrackOffset(offset, trackLength, -180, 180);
      expect(recovered).toBeCloseTo(value, 5);
    }
  });

  it("round-trips on the ground plane's own tilt range too", () => {
    const trackLength = 160;
    for (const value of [0, 22.5, 45, 65, 90]) {
      const offset = trackOffsetFromValue(value, trackLength, 0, 90);
      const recovered = valueFromTrackOffset(offset, trackLength, 0, 90);
      expect(recovered).toBeCloseTo(value, 5);
    }
  });
});
