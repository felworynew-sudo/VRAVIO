import { describe, expect, it } from "vitest";
import { importedShapesFromJson, worldTransform } from "@vravio/env-vector";
import { importSvgToJson } from "./vector-svg-wasm";

/**
 * Stage 10 of docs/vector-plan.md: importing a foreign SVG via the real
 * compiled `usvg` (`crates/vector-svg`). `@vravio/env-vector`'s own
 * `importedShapesFromJson` has its own unit tests against hand-built JSON;
 * these exercise the full pipeline — real SVG text in, real `.wasm`
 * parsing, real `VectorShape`s out.
 */

describe("SVG import — real usvg", () => {
  it("imports a simple rectangle path with a solid fill", async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect x="10" y="10" width="80" height="60" fill="#3366cc"/></svg>`;
    const json = await importSvgToJson(svg);
    const shapes = importedShapesFromJson(json);
    expect(shapes).toHaveLength(1);
    expect(shapes[0]!.kind).toBe("path");
    if (shapes[0]!.kind === "path") {
      expect(shapes[0]!.style.fills).toHaveLength(1);
      expect(shapes[0]!.style.fills[0]!.paint.kind).toBe("color");
    }
  });

  it("imports a linear gradient fill as a Paint gradient, normalized to the shape's own bounds", async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
      <defs><linearGradient id="g" x1="0" y1="0" x2="100" y2="0"><stop offset="0" stop-color="#000000"/><stop offset="1" stop-color="#ffffff"/></linearGradient></defs>
      <rect x="0" y="0" width="100" height="100" fill="url(#g)"/>
    </svg>`;
    const json = await importSvgToJson(svg);
    const shapes = importedShapesFromJson(json);
    expect(shapes).toHaveLength(1);
    if (shapes[0]!.kind === "path") {
      const paint = shapes[0]!.style.fills[0]!.paint;
      expect(paint.kind).toBe("gradient");
      if (paint.kind === "gradient") expect(paint.gradient.stops).toHaveLength(2);
    }
  });

  it("a stroked, unfilled shape imports with an empty fill stack and a populated stroke stack", async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect x="10" y="10" width="50" height="50" fill="none" stroke="#ff0000" stroke-width="4"/></svg>`;
    const json = await importSvgToJson(svg);
    const shapes = importedShapesFromJson(json);
    expect(shapes).toHaveLength(1);
    if (shapes[0]!.kind === "path") {
      expect(shapes[0]!.style.fills).toHaveLength(0);
      expect(shapes[0]!.style.strokes).toHaveLength(1);
      expect(shapes[0]!.style.strokes[0]!.width).toBeCloseTo(4, 1);
    }
  });

  it("multiple shapes in one SVG import as multiple VectorShapes", async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
      <rect x="0" y="0" width="20" height="20" fill="#111111"/>
      <circle cx="60" cy="60" r="15" fill="#222222"/>
    </svg>`;
    const json = await importSvgToJson(svg);
    const shapes = importedShapesFromJson(json);
    expect(shapes.length).toBeGreaterThanOrEqual(2);
  });

  it("a group's own nesting survives the round trip — a real VectorShape group, the rect parented under it, not flattened", async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
      <g transform="translate(50,0)"><rect x="0" y="0" width="10" height="10" fill="#000000"/></g>
    </svg>`;
    const json = await importSvgToJson(svg);
    const shapes = importedShapesFromJson(json);
    expect(shapes).toHaveLength(2);
    const group = shapes.find((shape) => shape.kind === "group")!;
    const rect = shapes.find((shape) => shape.kind === "path")!;
    expect(group).toBeDefined();
    expect(rect.parentId).toBe(group.id);
    // The group carries the translate(50,0) on its own transform, not baked
    // into the child's — composing them back up via worldTransform (the
    // same function VectorWorkspace.tsx's own renderer already uses)
    // reproduces the same absolute (50, 0) origin the flattened pass used
    // to bake into the child directly.
    expect(group.transform.e).toBeCloseTo(50, 0);
    const absolute = worldTransform(rect, shapes);
    expect(absolute.e).toBeCloseTo(50, 0);
  });

  it("a path sitting alongside a sibling group keeps its true paint-order position, not sorted after every group", async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
      <rect x="0" y="0" width="5" height="5" fill="#111111"/>
      <g transform="translate(20,0)"><rect x="0" y="0" width="5" height="5" fill="#222222"/></g>
      <rect x="40" y="0" width="5" height="5" fill="#333333"/>
    </svg>`;
    const json = await importSvgToJson(svg);
    const shapes = importedShapesFromJson(json);
    const topLevel = shapes.filter((shape) => shape.parentId === null);
    expect(topLevel.map((shape) => shape.kind)).toEqual(["path", "group", "path"]);
    expect(topLevel.map((shape) => shape.orderKey).every((key, index, all) => index === 0 || key > all[index - 1]!)).toBe(true);
  });

  it("an invalid SVG string rejects rather than silently returning nothing", async () => {
    await expect(importSvgToJson("not an svg at all { }")).rejects.toBeTruthy();
  });
});
