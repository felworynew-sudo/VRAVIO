import { describe, expect, it } from "vitest";
import { importedShapesFromJson } from "@vravio/env-vector";
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

  it("a group's transform is baked into each child's own absolute transform (groups are flattened — a documented gap)", async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
      <g transform="translate(50,0)"><rect x="0" y="0" width="10" height="10" fill="#000000"/></g>
    </svg>`;
    const json = await importSvgToJson(svg);
    const shapes = importedShapesFromJson(json);
    expect(shapes).toHaveLength(1);
    // The rect's own points are still local (0,0)-(10,10); the group's translate(50,0) has to
    // show up in the shape's transform.e, not in the point coordinates, for the picture to still
    // land in the right place after group nesting was flattened away.
    expect(shapes[0]!.transform.e).toBeCloseTo(50, 0);
  });

  it("an invalid SVG string rejects rather than silently returning nothing", async () => {
    await expect(importSvgToJson("not an svg at all { }")).rejects.toBeTruthy();
  });
});
