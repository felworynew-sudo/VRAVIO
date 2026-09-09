import { describe, expect, it } from "vitest";
import { WARP_PRESETS, evaluateWarpMesh, warpPresetMesh, type WarpPresetId } from "./index";

/**
 * master-plan.md §1.1's second item — Photoshop's warp styles, ported from
 * Patchy's `generate_horizontal_style_mesh`.
 *
 * What is worth testing here is not the shape of any one style (that is the
 * donor's arithmetic, and a test restating it would only restate my typing of
 * it), but the properties every style has to have to be usable at all.
 */

const BOUNDS = { x: 10, y: 20, width: 120, height: 80 };
const ids = WARP_PRESETS.map((preset) => preset.id);

/** Samples the surface on a grid — what actually reaches the pixels. */
function surface(preset: WarpPresetId, bend: number, vertical = false) {
  const mesh = warpPresetMesh(preset, bend, BOUNDS, vertical);
  const points = [];
  for (let row = 0; row <= 8; row += 1) for (let column = 0; column <= 8; column += 1) {
    points.push(evaluateWarpMesh(mesh, column / 8, row / 8));
  }
  return points;
}

describe("warp presets", () => {
  it.each(ids)("leaves the picture alone at bend 0 — %s", (id) => {
    // Every style has to pass through the identity, or the style dropdown would
    // deform the layer the moment it is opened. Elevation is exact for Béziers,
    // so this is a real equality and not a tolerance dodge: the 4x2 or 3x3 mesh
    // raised to 4x4 describes the very same flat rectangle.
    for (const [index, point] of surface(id, 0).entries()) {
      const u = (index % 9) / 8, v = Math.floor(index / 9) / 8;
      expect(point.x).toBeCloseTo(BOUNDS.x + u * BOUNDS.width, 6);
      expect(point.y).toBeCloseTo(BOUNDS.y + v * BOUNDS.height, 6);
    }
  });

  it.each(ids)("actually deforms at full bend — %s", (id) => {
    // The rule from CLAUDE.md §3, applied to twelve settings at once: a style
    // that returns the identity mesh is a menu entry that does nothing.
    const flat = surface(id, 0), bent = surface(id, 60);
    let worst = 0;
    for (let index = 0; index < flat.length; index += 1) {
      worst = Math.max(worst, Math.abs(bent[index]!.x - flat[index]!.x), Math.abs(bent[index]!.y - flat[index]!.y));
    }
    expect(worst).toBeGreaterThan(2);
  });

  it.each(ids)("reverses with the sign of the slider — %s", (id) => {
    // Photoshop's slider is signed, and −45 has to be the +45 shape the other
    // way round, or half the travel is dead. Two senses of "the other way"
    // exist and the donor uses both: most styles just negate the displacement,
    // while Arc gets its negative side from the donor's mirror_mesh_vertically, so its
    // displacement at v is the negation of the one at 1 − v. Either is a real
    // reversal; having neither would not be.
    //
    // Only the *vertical* field flips. The horizontal one is even in the bend by
    // construction — an arc pulls its ends inward whichever way it bows, and the
    // donor computes those control offsets from |bend| — so the check is that
    // |dx| is unchanged, not that it flips. (Demanding both flip is what the
    // first version of this test did, and it failed on geometry that was right.)
    const field = (bend: number) => surface(id, bend).map((point, index) => ({
      dx: point.x - (BOUNDS.x + ((index % 9) / 8) * BOUNDS.width),
      dy: point.y - (BOUNDS.y + (Math.floor(index / 9) / 8) * BOUNDS.height),
    }));
    /** The same field read bottom-up, for the mirrored styles. */
    const flipRows = <T,>(values: T[]) => values.map((_, index) => values[(8 - Math.floor(index / 9)) * 9 + (index % 9)]!);
    const plus = field(45), minus = field(-45);
    const reverses = (reference: typeof plus) => reference.every((point, index) =>
      Math.abs(minus[index]!.dy + point.dy) < 1e-6 && Math.abs(Math.abs(minus[index]!.dx) - Math.abs(point.dx)) < 1e-6);
    expect(plus.some((point) => Math.abs(point.dy) > 0.5)).toBe(true);
    expect(reverses(plus) || reverses(flipRows(plus))).toBe(true);
  });
  it("bends further the further the slider goes", () => {
    // Monotonic, because a slider whose middle is stronger than its end is a
    // slider nobody can aim.
    let previous = 0;
    for (const bend of [10, 25, 50, 80, 100]) {
      const flat = surface("arc", 0), bent = surface("arc", bend);
      let worst = 0;
      for (let index = 0; index < flat.length; index += 1) worst = Math.max(worst, Math.abs(bent[index]!.y - flat[index]!.y));
      expect(worst).toBeGreaterThan(previous);
      previous = worst;
    }
  });

  it("turns a horizontal style on its side for the vertical variant", () => {
    // The donor gets every vertical style by swapping the axes rather than
    // writing a second construction, so the vertical Arc over a rotated
    // rectangle must be the horizontal Arc reflected in the diagonal.
    const square = { x: 0, y: 0, width: 100, height: 100 };
    for (const [u, v] of [[0.25, 0], [0.5, 0.5], [1, 0.75]] as const) {
      const horizontal = evaluateWarpMesh(warpPresetMesh("arc", 40, square), u, v);
      const vertical = evaluateWarpMesh(warpPresetMesh("arc", 40, square, true), v, u);
      expect(vertical.x).toBeCloseTo(horizontal.y, 6);
      expect(vertical.y).toBeCloseTo(horizontal.x, 6);
    }
  });

  it("keeps the arc's two edges the same distance apart", () => {
    // The tell of a real Arc rather than a top edge bent on its own: the band
    // keeps its thickness, because both edges arc through the same angle. This
    // is what the donor's `(4/3)·tan(θ/2)·r` handle buys, and a hand-waved
    // control offset would fail it.
    const mesh = warpPresetMesh("arc", 50, BOUNDS);
    const thicknesses = [];
    for (let step = 0; step <= 6; step += 1) {
      const top = evaluateWarpMesh(mesh, step / 6, 0), bottom = evaluateWarpMesh(mesh, step / 6, 1);
      thicknesses.push(Math.hypot(bottom.x - top.x, bottom.y - top.y));
    }
    const min = Math.min(...thicknesses), max = Math.max(...thicknesses);
    expect(max - min).toBeLessThan(BOUNDS.height * 0.12);
  });

  it("pins both edges of a wave and ripples only its middle", () => {
    // Wave differs from Flag exactly here — Flag runs the S through the whole
    // band, Wave holds the edges. If the middle row's displacement leaked into
    // the edge rows, the two styles would be the same style.
    const mesh = warpPresetMesh("wave", 70, BOUNDS);
    for (const u of [0.25, 0.5, 0.75]) {
      expect(evaluateWarpMesh(mesh, u, 0).y).toBeCloseTo(BOUNDS.y, 6);
      expect(evaluateWarpMesh(mesh, u, 1).y).toBeCloseTo(BOUNDS.y + BOUNDS.height, 6);
    }
    expect(Math.abs(evaluateWarpMesh(mesh, 0.25, 0.5).y - (BOUNDS.y + BOUNDS.height / 2))).toBeGreaterThan(2);
  });

  it("moves inflate and squeeze in opposite directions", () => {
    // They are one construction with a sign, and the sign is the whole
    // difference between the two menu entries.
    const middleX = (id: WarpPresetId) => evaluateWarpMesh(warpPresetMesh(id, 60, BOUNDS), 0, 0.5).x;
    expect(middleX("inflate")).toBeLessThan(BOUNDS.x);
    expect(middleX("squeeze")).toBeGreaterThan(BOUNDS.x);
  });

  it("holds the corners still for fisheye", () => {
    // Only the four interior control points move, so the layer's outline is
    // untouched and the distortion is entirely inside it — the property that
    // makes Fisheye read as a lens rather than as a resize.
    const mesh = warpPresetMesh("fisheye", 80, BOUNDS);
    for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
      const point = evaluateWarpMesh(mesh, u, v);
      expect(point.x).toBeCloseTo(BOUNDS.x + u * BOUNDS.width, 6);
      expect(point.y).toBeCloseTo(BOUNDS.y + v * BOUNDS.height, 6);
    }
    expect(Math.abs(evaluateWarpMesh(mesh, 0.5, 0.5).x - (BOUNDS.x + BOUNDS.width / 2))
      + Math.abs(evaluateWarpMesh(mesh, 0.35, 0.35).y - (BOUNDS.y + 0.35 * BOUNDS.height))).toBeGreaterThan(1);
  });
});
