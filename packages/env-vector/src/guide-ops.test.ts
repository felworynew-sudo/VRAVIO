import { describe, expect, it } from "vitest";
import { addGuide, clearGuides, removeGuide, setRulerMode, setRulerOrigin, visibleGuides } from "./guide-ops";
import { createVectorDocument } from "./document";

describe("guide-ops (stages 5/15 of docs/vector-plan.md)", () => {
  it("addGuide appends a guide with the given orientation, position and scope", () => {
    const state = createVectorDocument();
    addGuide(state, "vertical", 120);
    addGuide(state, "horizontal", 40, "artboard-1");
    expect(state.guides).toEqual([
      { orientation: "vertical", position: 120, scope: null },
      { orientation: "horizontal", position: 40, scope: "artboard-1" },
    ]);
  });

  it("removeGuide removes only the matching (orientation, position) pair", () => {
    const state = createVectorDocument();
    addGuide(state, "vertical", 100);
    addGuide(state, "vertical", 200);
    removeGuide(state, "vertical", 100);
    expect(state.guides).toEqual([{ orientation: "vertical", position: 200, scope: null }]);
  });

  it("clearGuides with no scope argument removes every guide regardless of scope", () => {
    const state = createVectorDocument();
    addGuide(state, "vertical", 10);
    addGuide(state, "horizontal", 20, "artboard-1");
    clearGuides(state);
    expect(state.guides).toHaveLength(0);
  });

  it("clearGuides(scope) removes only guides with that exact scope, global guides included when scope is null", () => {
    const state = createVectorDocument();
    addGuide(state, "vertical", 10); // global
    addGuide(state, "horizontal", 20, "artboard-1");
    addGuide(state, "horizontal", 30, "artboard-2");
    clearGuides(state, "artboard-1");
    expect(state.guides.map((g) => g.position)).toEqual([10, 30]);
  });

  it("visibleGuides includes every global guide plus only the active artboard's own scoped ones", () => {
    const state = createVectorDocument();
    addGuide(state, "vertical", 1); // global
    addGuide(state, "vertical", 2, "artboard-1");
    addGuide(state, "vertical", 3, "artboard-2");

    expect(visibleGuides(state, "artboard-1").map((g) => g.position)).toEqual([1, 2]);
    expect(visibleGuides(state, "artboard-2").map((g) => g.position)).toEqual([1, 3]);
    expect(visibleGuides(state, null).map((g) => g.position)).toEqual([1]);
  });

  it("a guide scoped to a since-deleted artboard is simply excluded, not an error", () => {
    const state = createVectorDocument();
    addGuide(state, "vertical", 5, "gone");
    expect(visibleGuides(state, "still-here")).toEqual([]);
    expect(state.guides).toHaveLength(1); // orphaned, not destroyed
  });

  it("setRulerOrigin and setRulerMode write the document's own fields directly", () => {
    const state = createVectorDocument();
    setRulerOrigin(state, { x: 50, y: 75 });
    expect(state.rulerOrigin).toEqual({ x: 50, y: 75 });
    setRulerOrigin(state, null);
    expect(state.rulerOrigin).toBeNull();
    setRulerMode(state, "artboard");
    expect(state.rulerMode).toBe("artboard");
  });
});
