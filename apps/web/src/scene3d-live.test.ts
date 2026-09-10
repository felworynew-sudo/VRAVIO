import { describe, expect, it } from "vitest";
import { rotationFromTrackOffset, trackOffsetFromRotation } from "./scene3d-live";

describe("rotationFromTrackOffset", () => {
  it("maps the left end of the track to -180°", () => {
    expect(rotationFromTrackOffset(0, 200)).toBe(-180);
  });

  it("maps the right end of the track to 180°", () => {
    expect(rotationFromTrackOffset(200, 200)).toBe(180);
  });

  it("maps the middle of the track to 0°", () => {
    expect(rotationFromTrackOffset(100, 200)).toBe(0);
  });

  it("clamps an offset past either end of the track instead of extrapolating", () => {
    expect(rotationFromTrackOffset(-50, 200)).toBe(-180);
    expect(rotationFromTrackOffset(400, 200)).toBe(180);
  });

  it("guards a degenerate (zero or negative) track length rather than dividing by zero", () => {
    expect(rotationFromTrackOffset(50, 0)).toBe(0);
    expect(rotationFromTrackOffset(50, -10)).toBe(0);
  });
});

describe("trackOffsetFromRotation", () => {
  it("places the knob at the track's own two ends for the range's extremes", () => {
    expect(trackOffsetFromRotation(-180, 200)).toBe(0);
    expect(trackOffsetFromRotation(180, 200)).toBe(200);
  });

  it("places the knob at the middle for 0°", () => {
    expect(trackOffsetFromRotation(0, 200)).toBe(100);
  });

  it("clamps a rotation outside the slider's own range instead of pushing the knob off the track", () => {
    expect(trackOffsetFromRotation(-270, 200)).toBe(0);
    expect(trackOffsetFromRotation(270, 200)).toBe(200);
  });
});

describe("rotationFromTrackOffset / trackOffsetFromRotation round-trip", () => {
  it("recovers the same knob position it started from, for values on the whole-degree grid the rounding lands on", () => {
    const trackLength = 240;
    for (const rotation of [-180, -90, -45, 0, 30, 90, 180]) {
      const offset = trackOffsetFromRotation(rotation, trackLength);
      const recovered = rotationFromTrackOffset(offset, trackLength);
      expect(recovered).toBe(rotation);
    }
  });
});
