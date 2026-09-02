import { describe, expect, it } from "vitest";
import { identityTextTransform, multiplyTextTransform, textBoundsTransform } from "./textRender";

const apply = (matrix: ReturnType<typeof identityTextTransform>, x: number, y: number) => ({ x: matrix.a * x + matrix.c * y + matrix.e, y: matrix.b * x + matrix.d * y + matrix.f });

describe("non-destructive text transforms", () => {
  it("maps the original text bounds to moved and scaled target bounds", () => {
    const matrix = textBoundsTransform({ x: 10, y: 20, width: 100, height: 40 }, { x: 40, y: 60, width: 200, height: 80 }, 0);
    expect(apply(matrix, 10, 20)).toEqual({ x: 40, y: 60 });
    expect(apply(matrix, 110, 60)).toEqual({ x: 240, y: 140 });
  });

  it("composes repeated transformations without baking pixels", () => {
    const moved = textBoundsTransform({ x: 0, y: 0, width: 100, height: 50 }, { x: 20, y: 30, width: 100, height: 50 }, 0);
    const scaled = textBoundsTransform({ x: 20, y: 30, width: 100, height: 50 }, { x: 20, y: 30, width: 200, height: 100 }, 0);
    expect(apply(multiplyTextTransform(scaled, moved), 0, 0)).toEqual({ x: 20, y: 30 });
    expect(apply(multiplyTextTransform(scaled, moved), 100, 50)).toEqual({ x: 220, y: 130 });
  });
});
