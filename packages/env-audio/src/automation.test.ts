import { describe, expect, it } from "vitest";
import { removeAutomationPoint, setAutomationPoint, volumeAt } from "./automation";

describe("volumeAt", () => {
  it("falls back to the static volume when there are no points", () => {
    expect(volumeAt([], 1000, 0.75)).toBe(0.75);
  });

  it("holds at the single point's value regardless of time, with only one point", () => {
    const points = [{ id: "a", time: 500, value: 0.5 }];
    expect(volumeAt(points, 0, 1)).toBe(0.5);
    expect(volumeAt(points, 500, 1)).toBe(0.5);
    expect(volumeAt(points, 10000, 1)).toBe(0.5);
  });

  it("holds at the first point's value before it", () => {
    const points = [{ id: "a", time: 1000, value: 0.2 }, { id: "b", time: 2000, value: 0.8 }];
    expect(volumeAt(points, 0, 1)).toBe(0.2);
    expect(volumeAt(points, 999, 1)).toBe(0.2);
  });

  it("holds at the last point's value after it", () => {
    const points = [{ id: "a", time: 1000, value: 0.2 }, { id: "b", time: 2000, value: 0.8 }];
    expect(volumeAt(points, 2000, 1)).toBe(0.8);
    expect(volumeAt(points, 5000, 1)).toBe(0.8);
  });

  it("linearly interpolates between two points", () => {
    const points = [{ id: "a", time: 1000, value: 0 }, { id: "b", time: 2000, value: 1 }];
    expect(volumeAt(points, 1500, 1)).toBeCloseTo(0.5, 5);
    expect(volumeAt(points, 1250, 1)).toBeCloseTo(0.25, 5);
  });

  it("interpolates across the correct segment with three or more points", () => {
    const points = [
      { id: "a", time: 0, value: 1 },
      { id: "b", time: 1000, value: 0 },
      { id: "c", time: 2000, value: 1 },
    ];
    expect(volumeAt(points, 500, 1)).toBeCloseTo(0.5, 5);
    expect(volumeAt(points, 1500, 1)).toBeCloseTo(0.5, 5);
    expect(volumeAt(points, 1000, 1)).toBeCloseTo(0, 5);
  });
});

describe("setAutomationPoint", () => {
  it("inserts a new point, keeping the array sorted by time", () => {
    const points = setAutomationPoint([{ id: "a", time: 2000, value: 1 }], 1000, 0.5, "b");
    expect(points.map((p) => p.time)).toEqual([1000, 2000]);
  });

  it("replaces an existing point at the exact same time rather than duplicating it", () => {
    const points = setAutomationPoint([{ id: "a", time: 1000, value: 1 }], 1000, 0.3, "new-id");
    expect(points).toHaveLength(1);
    expect(points[0]).toEqual({ id: "new-id", time: 1000, value: 0.3 });
  });

  it("clamps a negative time to 0 and floors a fractional one", () => {
    const points = setAutomationPoint([], -50.7, 1, "a");
    expect(points[0]!.time).toBe(0);
    const points2 = setAutomationPoint([], 100.9, 1, "b");
    expect(points2[0]!.time).toBe(100);
  });
});

describe("removeAutomationPoint", () => {
  it("removes only the point with the matching id", () => {
    const points = [{ id: "a", time: 0, value: 1 }, { id: "b", time: 1000, value: 0.5 }];
    const result = removeAutomationPoint(points, "a");
    expect(result).toEqual([{ id: "b", time: 1000, value: 0.5 }]);
  });

  it("is a no-op when the id isn't found", () => {
    const points = [{ id: "a", time: 0, value: 1 }];
    expect(removeAutomationPoint(points, "missing")).toEqual(points);
  });
});
