import { describe, expect, it } from "vitest";
import {
  IDENTITY_MATRIX, applyMatrix, invertMatrix, isIdentityMatrix,
  multiplyMatrix, rotationMatrixAround, scaleMatrix, translationMatrix,
} from "./matrix";

const close = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-9);
const closePoint = (p: { x: number; y: number }, x: number, y: number) => { close(p.x, x); close(p.y, y); };

describe("Matrix", () => {
  it("identity leaves a point untouched", () => {
    closePoint(applyMatrix(IDENTITY_MATRIX, { x: 12, y: -7 }), 12, -7);
    expect(isIdentityMatrix(IDENTITY_MATRIX)).toBe(true);
    expect(isIdentityMatrix(translationMatrix(1, 0))).toBe(false);
  });

  it("translation moves a point by (dx, dy)", () => {
    closePoint(applyMatrix(translationMatrix(10, -5), { x: 3, y: 3 }), 13, -2);
  });

  it("scale multiplies coordinates independently on each axis", () => {
    closePoint(applyMatrix(scaleMatrix(2, 3), { x: 4, y: 5 }), 8, 15);
  });

  it("rotating 90° around the origin sends (1,0) to (0,1)", () => {
    closePoint(applyMatrix(rotationMatrixAround(90, 0, 0), { x: 1, y: 0 }), 0, 1);
  });

  it("rotating 180° around a pivot maps the pivot to itself and reflects everything else through it", () => {
    const m = rotationMatrixAround(180, 100, 100);
    closePoint(applyMatrix(m, { x: 100, y: 100 }), 100, 100);
    closePoint(applyMatrix(m, { x: 110, y: 100 }), 90, 100);
  });

  it("composes parent-then-child in the order a shape's world transform is built: applying the compose equals applying child then parent", () => {
    const parent = rotationMatrixAround(90, 0, 0);
    const child = translationMatrix(5, 0);
    const composed = multiplyMatrix(parent, child);
    const point = { x: 2, y: 0 };

    const viaCompose = applyMatrix(composed, point);
    const viaSequence = applyMatrix(parent, applyMatrix(child, point));

    close(viaCompose.x, viaSequence.x);
    close(viaCompose.y, viaSequence.y);
  });

  it("multiplying by identity on either side is a no-op", () => {
    const m = rotationMatrixAround(37, 4, -9);
    expect(multiplyMatrix(m, IDENTITY_MATRIX)).toEqual(m);
    expect(multiplyMatrix(IDENTITY_MATRIX, m)).toEqual(m);
  });

  it("inverting and re-applying returns the original point — the operation hit-testing depends on to map a click back into a shape's local space", () => {
    const m = multiplyMatrix(rotationMatrixAround(37, 10, 20), scaleMatrix(2, 0.5));
    const inverse = invertMatrix(m)!;
    const point = { x: 15, y: -8 };
    const roundTripped = applyMatrix(inverse, applyMatrix(m, point));
    close(roundTripped.x, point.x);
    close(roundTripped.y, point.y);
  });

  it("a singular matrix (zero scale) has no inverse", () => {
    expect(invertMatrix(scaleMatrix(0, 1))).toBeNull();
  });
});
