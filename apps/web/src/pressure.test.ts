import { describe, expect, it } from "vitest";
import { strokePressure } from "./raster-coordinates";

describe("stroke pressure", () => {
  it("paints a mouse at full width", () => {
    expect(strokePressure({ pointerType: "mouse", pressure: 0, buttons: 1 })).toBe(1);
  });

  it("uses the reported pressure of a pen that reports one", () => {
    expect(strokePressure({ pointerType: "pen", pressure: 0.62, buttons: 1 })).toBeCloseTo(0.62);
  });

  it("treats a zero during a stroke as no sensor, not as no pressure", () => {
    // Safari reports a hard zero throughout a stroke for pens and touches it has
    // no pressure for. Taken literally it scales a 24-pixel brush to 0.6 of a
    // pixel: the stroke is committed and saved, and cannot be seen.
    for (const pointerType of ["pen", "touch"]) {
      expect(strokePressure({ pointerType, pressure: 0, buttons: 1 })).toBe(0.5);
    }
  });

  it("keeps a hovering pen faint rather than full", () => {
    expect(strokePressure({ pointerType: "pen", pressure: 0, buttons: 0 })).toBe(0.05);
  });

  it("never scales a brush away entirely", () => {
    expect(strokePressure({ pointerType: "pen", pressure: 0.0001, buttons: 1 })).toBe(0.05);
  });
});
