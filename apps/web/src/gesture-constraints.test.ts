import { describe, expect, it } from "vitest";
import { boxFromDrag } from "./gesture-constraints";

describe("Photoshop-style box drag modifiers", () => {
  it("keeps a box proportional under Shift, following its furthest axis", () => {
    expect(boxFromDrag({ x: 10, y: 20 }, { x: 34, y: 70 }, { shiftKey: true }))
      .toEqual({ x: 10, y: 20, width: 50, height: 50 });
  });

  it("draws from its centre under Alt/Option", () => {
    expect(boxFromDrag({ x: 50, y: 50 }, { x: 70, y: 60 }, { altKey: true }))
      .toEqual({ x: 30, y: 40, width: 40, height: 20 });
  });

  it("combines Shift and Alt/Option into a centred square or circle box", () => {
    expect(boxFromDrag({ x: 50, y: 50 }, { x: 70, y: 60 }, { shiftKey: true, altKey: true }))
      .toEqual({ x: 30, y: 30, width: 40, height: 40 });
  });
});
