import type { Point, RasterRect } from "./types";

/**
 * Photoshop's warp styles — Arc, Bulge, Flag, Wave, Fisheye and the rest —
 * ported from the donor (Patchy, `core/warp_mesh.cpp`), which builds each one as
 * a control mesh in content space and then raises it to a bicubic 4x4.
 *
 * master-plan.md §1.1's second item. Its own wording is "подсмотреть у Patchy
 * же", and that is literally what this is: every construction below is the
 * donor's, including the parts that only make sense against Photoshop's own
 * captures — the arc's `(4/3)·tan(θ/2)·r` handle length, Fisheye moving only its
 * four interior points a fraction of the way to their nearest corner, Wave
 * pinning both edges and rippling only the middle row.
 *
 * A style is built at its natural order (an arc needs 4x2, Inflate 3x3, Fisheye
 * 4x4) and degree-elevated, so the sixteen anchors handed to the warp mesh
 * describe exactly the same surface the smaller mesh did — elevation is exact
 * for Béziers, not an approximation.
 */

export type WarpPresetId =
  | "arc" | "arcLower" | "arcUpper" | "arch" | "bulge"
  | "flag" | "wave" | "fish" | "rise" | "fisheye"
  | "inflate" | "squeeze";

export interface WarpPreset {
  readonly id: WarpPresetId;
  readonly label: { readonly en: string; readonly ru: string };
  /** True for the styles Photoshop lets you flip to a vertical axis. */
  readonly orientable: boolean;
}

export const WARP_PRESETS: readonly WarpPreset[] = [
  { id: "arc", label: { en: "Arc", ru: "Дугой" }, orientable: true },
  { id: "arcLower", label: { en: "Arc Lower", ru: "Дугой вниз" }, orientable: true },
  { id: "arcUpper", label: { en: "Arc Upper", ru: "Дугой вверх" }, orientable: true },
  { id: "arch", label: { en: "Arch", ru: "Аркой" }, orientable: true },
  { id: "bulge", label: { en: "Bulge", ru: "Выпуклый" }, orientable: true },
  { id: "flag", label: { en: "Flag", ru: "Флагом" }, orientable: true },
  { id: "wave", label: { en: "Wave", ru: "Волной" }, orientable: true },
  { id: "fish", label: { en: "Fish", ru: "Рыбой" }, orientable: true },
  { id: "rise", label: { en: "Rise", ru: "Подъёмом" }, orientable: true },
  { id: "fisheye", label: { en: "Fisheye", ru: "Рыбий глаз" }, orientable: false },
  { id: "inflate", label: { en: "Inflate", ru: "Раздувание" }, orientable: false },
  { id: "squeeze", label: { en: "Squeeze", ru: "Сжатие" }, orientable: false },
];

/** A control mesh at whatever order the style needed, in content space. */
interface Grid { uOrder: number; vOrder: number; xs: number[]; ys: number[] }

const identityGrid = (width: number, height: number, uOrder: number, vOrder: number): Grid => {
  const xs: number[] = [], ys: number[] = [];
  for (let row = 0; row < vOrder; row += 1) for (let column = 0; column < uOrder; column += 1) {
    xs.push(uOrder === 1 ? 0 : (width * column) / (uOrder - 1));
    ys.push(vOrder === 1 ? 0 : (height * row) / (vOrder - 1));
  }
  return { uOrder, vOrder, xs, ys };
};

/** One exact Bézier degree-elevation step along a row. */
function elevateRow(source: readonly number[], count: number, target: number[]): void {
  target.push(source[0]!);
  for (let index = 1; index < count; index += 1) {
    const alpha = index / count;
    target.push(alpha * source[index - 1]! + (1 - alpha) * source[index]!);
  }
  target.push(source[count - 1]!);
}

function elevateU(mesh: Grid): Grid {
  const result: Grid = { uOrder: mesh.uOrder + 1, vOrder: mesh.vOrder, xs: [], ys: [] };
  for (let row = 0; row < mesh.vOrder; row += 1) {
    elevateRow(mesh.xs.slice(row * mesh.uOrder, (row + 1) * mesh.uOrder), mesh.uOrder, result.xs);
    elevateRow(mesh.ys.slice(row * mesh.uOrder, (row + 1) * mesh.uOrder), mesh.uOrder, result.ys);
  }
  return result;
}

function transpose(mesh: Grid): Grid {
  const result: Grid = { uOrder: mesh.vOrder, vOrder: mesh.uOrder, xs: new Array(mesh.xs.length), ys: new Array(mesh.ys.length) };
  for (let row = 0; row < mesh.vOrder; row += 1) for (let column = 0; column < mesh.uOrder; column += 1) {
    result.xs[column * mesh.vOrder + row] = mesh.xs[row * mesh.uOrder + column]!;
    result.ys[column * mesh.vOrder + row] = mesh.ys[row * mesh.uOrder + column]!;
  }
  return result;
}

function toCubic(mesh: Grid): Grid {
  let current = mesh;
  while (current.uOrder < 4) current = elevateU(current);
  while (current.vOrder < 4) current = transpose(elevateU(transpose(current)));
  return current;
}

/** Mirrors a mesh vertically — Photoshop's negative-bend arc is the positive one
 * flipped, which the donor relies on rather than deriving twice. */
function mirrorVertically(mesh: Grid, height: number): Grid {
  const result: Grid = { uOrder: mesh.uOrder, vOrder: mesh.vOrder, xs: new Array(mesh.xs.length), ys: new Array(mesh.ys.length) };
  for (let row = 0; row < mesh.vOrder; row += 1) for (let column = 0; column < mesh.uOrder; column += 1) {
    const to = row * mesh.uOrder + column, from = (mesh.vOrder - 1 - row) * mesh.uOrder + column;
    result.xs[to] = mesh.xs[from]!;
    result.ys[to] = height - mesh.ys[from]!;
  }
  return result;
}

/** Swaps the axes — how every horizontal style becomes its vertical twin. */
function swapAxes(mesh: Grid): Grid {
  const result: Grid = { uOrder: mesh.vOrder, vOrder: mesh.uOrder, xs: new Array(mesh.xs.length), ys: new Array(mesh.ys.length) };
  for (let row = 0; row < mesh.vOrder; row += 1) for (let column = 0; column < mesh.uOrder; column += 1) {
    const to = column * mesh.vOrder + row, from = row * mesh.uOrder + column;
    result.xs[to] = mesh.ys[from]!;
    result.ys[to] = mesh.xs[from]!;
  }
  return result;
}

/** One row of the classic cubic circle-arc approximation: the arc with the
 * horizontal chord (ax, y)..(bx, y) and central angle 2θ, bulging toward -y when
 * `bulgeUp`. The handle length is the donor's, and it is what makes the curve an
 * arc rather than something merely arc-shaped. */
function arcRow(mesh: Grid, ax: number, bx: number, y: number, theta: number, bulgeUp: boolean): void {
  const sin = Math.sin(theta), cos = Math.cos(theta);
  const radius = (bx - ax) / (2 * sin);
  const handle = (4 / 3) * Math.tan(theta / 2) * radius;
  const dy = bulgeUp ? -handle * sin : handle * sin;
  mesh.xs.push(ax, ax + handle * cos, bx - handle * cos, bx);
  mesh.ys.push(y, y + dy, y + dy, y);
}

function identityRow(mesh: Grid, width: number, y: number): void {
  mesh.xs.push(0, width / 3, (2 * width) / 3, width);
  mesh.ys.push(y, y, y, y);
}

const ZERO_BEND = 1e-9;

/** Every horizontal construction, in content space. */
function horizontalGrid(style: WarpPresetId, bendPercent: number, width: number, height: number): Grid {
  const bend = Math.max(-100, Math.min(100, bendPercent));
  const theta = (Math.abs(bend) * Math.PI) / 200;
  // Flag, wave, fish and rise scale by the *height*, which is what keeps their
  // amplitude sane on a wide, short layer.
  const displacement = (2 * height * bend) / 100;
  const mesh: Grid = { uOrder: 4, vOrder: style === "wave" ? 3 : 2, xs: [], ys: [] };

  if (style === "arcLower" || style === "arcUpper") {
    if (Math.abs(bend) < ZERO_BEND) return identityGrid(width, height, 4, 2);
    identityRow(mesh, width, 0);
    arcRow(mesh, 0, width, height, theta, bend < 0);
    return style === "arcUpper" ? mirrorVertically(mesh, height) : mesh;
  }
  if (style === "arc") {
    if (Math.abs(bend) < ZERO_BEND) return identityGrid(width, height, 4, 2);
    const sin = Math.sin(theta);
    // The top corners swing outward about the bottom ones, both edges arcing
    // through the same angle, so the band keeps its thickness.
    arcRow(mesh, -height * sin, width + height * sin, height * (1 - Math.cos(theta)), theta, true);
    arcRow(mesh, 0, width, height, theta, true);
    return bend < 0 ? mirrorVertically(mesh, height) : mesh;
  }
  if (style === "arch" || style === "bulge") {
    if (Math.abs(bend) < ZERO_BEND) return identityGrid(width, height, 4, 2);
    const topUp = bend > 0;
    arcRow(mesh, 0, width, 0, theta, topUp);
    // Arch bows both edges the same way (the columns translate rigidly); bulge
    // bows the bottom the other way, so the band inflates.
    arcRow(mesh, 0, width, height, theta, style === "bulge" ? !topUp : topUp);
    return mesh;
  }
  if (style === "flag") {
    identityRow(mesh, width, 0);
    identityRow(mesh, width, height);
    mesh.ys[1] = mesh.ys[1]! - displacement;
    mesh.ys[2] = mesh.ys[2]! + displacement;
    mesh.ys[5] = mesh.ys[5]! - displacement;
    mesh.ys[6] = mesh.ys[6]! + displacement;
    return mesh;
  }
  if (style === "fish") {
    // Flag's S on the top edge with the bottom edge S-ing the other way, which
    // pinches head and tail.
    identityRow(mesh, width, 0);
    identityRow(mesh, width, height);
    mesh.ys[1] = mesh.ys[1]! - displacement;
    mesh.ys[2] = mesh.ys[2]! + displacement;
    mesh.ys[5] = mesh.ys[5]! + displacement;
    mesh.ys[6] = mesh.ys[6]! - displacement;
    return mesh;
  }
  if (style === "wave") {
    identityRow(mesh, width, 0);
    identityRow(mesh, width, height / 2);
    identityRow(mesh, width, height);
    // Both edges stay pinned; only the middle row ripples, opposite to flag's S.
    mesh.ys[5] = mesh.ys[5]! + displacement;
    mesh.ys[6] = mesh.ys[6]! - displacement;
    return mesh;
  }
  if (style === "rise") {
    // A rigid column ramp: each column keeps its own height and slides.
    identityRow(mesh, width, 0);
    identityRow(mesh, width, height);
    for (let column = 0; column < 4; column += 1) {
      const lift = (displacement * column) / 3;
      mesh.ys[column] = mesh.ys[column]! - lift;
      mesh.ys[4 + column] = mesh.ys[4 + column]! - lift;
    }
    return mesh;
  }
  if (style === "fisheye") {
    // Only the four interior points move, each toward its nearest corner: at
    // ±50% they sit exactly on the corners.
    const grid = identityGrid(width, height, 4, 4);
    const t = bend / 50;
    for (let row = 1; row <= 2; row += 1) for (let column = 1; column <= 2; column += 1) {
      const index = row * 4 + column;
      const cornerX = column === 1 ? 0 : width, cornerY = row === 1 ? 0 : height;
      grid.xs[index] = grid.xs[index]! + t * (cornerX - grid.xs[index]!);
      grid.ys[index] = grid.ys[index]! + t * (cornerY - grid.ys[index]!);
    }
    return grid;
  }
  // inflate / squeeze: corners and centre pinned, the edge midpoints slide.
  const grid = identityGrid(width, height, 3, 3);
  const dx = (width * bend) / 200, dy = (height * bend) / 200;
  grid.ys[1] = grid.ys[1]! - dy;
  grid.ys[7] = grid.ys[7]! + dy;
  if (style === "inflate") {
    grid.xs[3] = grid.xs[3]! - dx;
    grid.xs[5] = grid.xs[5]! + dx;
  } else {
    grid.xs[3] = grid.xs[3]! + dx;
    grid.xs[5] = grid.xs[5]! - dx;
  }
  return grid;
}

/**
 * The sixteen anchors for a preset, in document coordinates over `bounds`.
 *
 * `bend` is Photoshop's own -100..100. `vertical` runs the horizontal
 * construction over swapped dimensions and swaps the result back, which is how
 * the donor turns every style into its vertical twin instead of writing each
 * one twice.
 */
export function warpPresetMesh(preset: WarpPresetId, bend: number, bounds: RasterRect, vertical = false): Point[] {
  const width = vertical ? bounds.height : bounds.width;
  const height = vertical ? bounds.width : bounds.height;
  let grid = horizontalGrid(preset, bend, width, height);
  if (vertical) grid = swapAxes(grid);
  grid = toCubic(grid);
  const points: Point[] = [];
  for (let index = 0; index < 16; index += 1) {
    points.push({ x: bounds.x + grid.xs[index]!, y: bounds.y + grid.ys[index]! });
  }
  return points;
}
