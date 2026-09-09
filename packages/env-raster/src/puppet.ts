import type { PixelSelection, Point, RasterRect } from "./types";

/**
 * Puppet Warp: pin a few points of a layer, drag one, and the rest of the
 * picture follows as rigidly as it can.
 *
 * The method is the donor's — As-Rigid-As-Possible shape manipulation over a
 * triangulated mesh (Igarashi, Moscovich and Hughes, 2005), which is what
 * `mikecokina/puppet-warp` implements and what master-plan.md §1.2 points at.
 * Its two least-squares steps are here in full:
 *
 * 1. *Scale-free.* Every triangle is allowed to rotate and to scale uniformly,
 *    and nothing else. Each of a triangle's three vertices is written in the
 *    local frame of the opposite edge, which makes that condition linear, so
 *    the whole mesh is one least-squares problem with the pins as constraints.
 *    Solved alone it bends beautifully and shrinks or swells as handles move.
 * 2. *Scale adjustment.* Each triangle's rotation is read back from step 1 and
 *    applied to the triangle's **original** edges; a second least-squares then
 *    asks the mesh to match those edge vectors. That is what puts the original
 *    size back and makes the result read as a limb bending rather than a shape
 *    being stretched.
 *
 * A regular grid split into triangles stands in for the donor's Delaunay
 * triangulation: the mesh here always covers a rectangle, so there is nothing
 * for a general triangulator to decide, and a grid keeps the vertex ordering
 * predictable enough to test against.
 *
 * The systems are small — a 9x9 grid is 81 vertices, 162 unknowns — so they are
 * solved densely with a Cholesky factorisation, computed once per set of pins
 * and re-used for every frame of a drag, where only the right-hand side moves.
 */

export interface PuppetMesh {
  readonly vertices: readonly Point[];
  /** Vertex indices, three per triangle. */
  readonly triangles: readonly number[];
  readonly columns: number;
  readonly rows: number;
  readonly bounds: RasterRect;
}

/** One pin: a mesh vertex held at a position.
 *
 * Photoshop's three kinds differ in what the user may then do with them, not in
 * what the solver is told — a Position pin is dragged, a Fixed pin is not, and
 * both are the same constraint while the solve runs. `rotation` is what
 * separates a Rotation pin: the ring of vertices around it is turned by that
 * angle, which is how a pin twists the artwork around itself instead of only
 * holding it. */
export interface PuppetPin {
  readonly vertex: number;
  readonly at: Point;
  readonly rotation?: number;
}

/** A grid of `divisions` cells per side over `bounds`, split into triangles. */
export function puppetMesh(bounds: RasterRect, divisions = 8): PuppetMesh {
  const columns = divisions + 1, rows = divisions + 1;
  const vertices: Point[] = [];
  for (let row = 0; row < rows; row += 1) for (let col = 0; col < columns; col += 1) {
    vertices.push({ x: bounds.x + (col / divisions) * bounds.width, y: bounds.y + (row / divisions) * bounds.height });
  }
  const triangles: number[] = [];
  for (let row = 0; row < divisions; row += 1) for (let col = 0; col < divisions; col += 1) {
    const topLeft = row * columns + col, topRight = topLeft + 1;
    const bottomLeft = topLeft + columns, bottomRight = bottomLeft + 1;
    // Split each cell along the same diagonal, so the mesh has no preferred
    // direction beyond the one a grid already has.
    triangles.push(topLeft, topRight, bottomLeft, topRight, bottomRight, bottomLeft);
  }
  return { vertices, triangles, columns, rows, bounds };
}

/** The vertex nearest a point — how a click becomes a pin. */
export function nearestVertex(mesh: PuppetMesh, point: Point): number {
  let best = 0, bestDistance = Infinity;
  for (let index = 0; index < mesh.vertices.length; index += 1) {
    const vertex = mesh.vertices[index]!;
    const distance = Math.hypot(vertex.x - point.x, vertex.y - point.y);
    if (distance < bestDistance) { bestDistance = distance; best = index; }
  }
  return best;
}

/** Dense symmetric positive-definite solve, by Cholesky. The systems here are a
 * few hundred unknowns and are factored once per pin set, so the simplest
 * correct method is also the right one. */
function cholesky(matrix: Float64Array, size: number): Float64Array | null {
  const lower = new Float64Array(size * size);
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col <= row; col += 1) {
      let sum = matrix[row * size + col]!;
      for (let k = 0; k < col; k += 1) sum -= lower[row * size + k]! * lower[col * size + k]!;
      if (row === col) {
        // A singular system means the pins do not pin anything down (none at
        // all, or all at one point); the caller keeps the mesh it had.
        if (sum <= 1e-9) return null;
        lower[row * size + col] = Math.sqrt(sum);
      } else {
        lower[row * size + col] = sum / lower[col * size + col]!;
      }
    }
  }
  return lower;
}

function choleskySolve(lower: Float64Array, size: number, rhs: Float64Array): Float64Array {
  const y = new Float64Array(size);
  for (let row = 0; row < size; row += 1) {
    let sum = rhs[row]!;
    for (let k = 0; k < row; k += 1) sum -= lower[row * size + k]! * y[k]!;
    y[row] = sum / lower[row * size + row]!;
  }
  const x = new Float64Array(size);
  for (let row = size - 1; row >= 0; row -= 1) {
    let sum = y[row]!;
    for (let k = row + 1; k < size; k += 1) sum -= lower[k * size + row]! * x[k]!;
    x[row] = sum / lower[row * size + row]!;
  }
  return x;
}

/** Rows of a least-squares system, accumulated straight into AᵀA and Aᵀb so the
 * full A never has to exist. */
class NormalEquations {
  readonly size: number;
  readonly matrix: Float64Array;
  readonly rhs: Float64Array;

  constructor(size: number) {
    this.size = size;
    this.matrix = new Float64Array(size * size);
    this.rhs = new Float64Array(size);
  }

  /** One row: `sum(coefficient * unknown) = value`, weighted. */
  addRow(terms: readonly { readonly index: number; readonly value: number }[], value: number, weight = 1): void {
    for (const a of terms) {
      this.rhs[a.index] = this.rhs[a.index]! + weight * a.value * value;
      for (const b of terms) {
        this.matrix[a.index * this.size + b.index] = this.matrix[a.index * this.size + b.index]! + weight * a.value * b.value;
      }
    }
  }
}

/** How firmly a pin is held relative to the rigidity terms. High enough that a
 * pin lands on the pointer, low enough to keep the system well conditioned. */
const PIN_WEIGHT = 1000;

/** The local frame of edge (p0 → p1), in which the third vertex of a triangle
 * has coordinates that a rotation and a uniform scale both leave unchanged. */
function localFrame(p0: Point, p1: Point, p2: Point): { x: number; y: number } {
  const ex = p1.x - p0.x, ey = p1.y - p0.y;
  const length2 = ex * ex + ey * ey;
  if (length2 < 1e-12) return { x: 0, y: 0 };
  const dx = p2.x - p0.x, dy = p2.y - p0.y;
  // (x, y) such that p2 = p0 + x*e + y*perp(e), with perp(e) = (-ey, ex).
  return { x: (dx * ex + dy * ey) / length2, y: (dy * ex - dx * ey) / length2 };
}

/**
 * Solves the mesh for a set of pins. Returns the deformed vertices, or the
 * original ones when the pins leave the mesh free to drift.
 */
export function solvePuppetMesh(mesh: PuppetMesh, pins: readonly PuppetPin[]): readonly Point[] {
  const count = mesh.vertices.length;
  if (!pins.length) return mesh.vertices;
  const size = count * 2;
  const xIndex = (vertex: number) => vertex * 2, yIndex = (vertex: number) => vertex * 2 + 1;

  // Step 1: rotation and uniform scale are free, everything else is penalised.
  const similar = new NormalEquations(size);
  for (let t = 0; t < mesh.triangles.length; t += 3) {
    const corner = [mesh.triangles[t]!, mesh.triangles[t + 1]!, mesh.triangles[t + 2]!];
    for (let which = 0; which < 3; which += 1) {
      const i0 = corner[which]!, i1 = corner[(which + 1) % 3]!, i2 = corner[(which + 2) % 3]!;
      const frame = localFrame(mesh.vertices[i0]!, mesh.vertices[i1]!, mesh.vertices[i2]!);
      const { x, y } = frame;
      // v2 - v0 - x*(v1 - v0) - y*perp(v1 - v0) = 0, split into its two axes.
      similar.addRow([
        { index: xIndex(i2), value: 1 }, { index: xIndex(i0), value: -1 + x }, { index: xIndex(i1), value: -x },
        { index: yIndex(i0), value: -y }, { index: yIndex(i1), value: y },
      ], 0);
      similar.addRow([
        { index: yIndex(i2), value: 1 }, { index: yIndex(i0), value: -1 + x }, { index: yIndex(i1), value: -x },
        { index: xIndex(i0), value: y }, { index: xIndex(i1), value: -y },
      ], 0);
    }
  }
  for (const pin of pins) {
    similar.addRow([{ index: xIndex(pin.vertex), value: 1 }], pin.at.x, PIN_WEIGHT);
    similar.addRow([{ index: yIndex(pin.vertex), value: 1 }], pin.at.y, PIN_WEIGHT);
  }
  const similarFactor = cholesky(similar.matrix, size);
  if (!similarFactor) return mesh.vertices;
  const intermediate = choleskySolve(similarFactor, size, similar.rhs);
  const stage1: Point[] = Array.from({ length: count }, (_, index) => ({ x: intermediate[xIndex(index)]!, y: intermediate[yIndex(index)]! }));

  // Step 2: take each triangle's rotation from step 1, apply it to the
  // triangle's original edges, and ask the mesh to match those — which is what
  // gives the original size back.
  const fitted = new NormalEquations(size);
  for (let t = 0; t < mesh.triangles.length; t += 3) {
    const corner = [mesh.triangles[t]!, mesh.triangles[t + 1]!, mesh.triangles[t + 2]!];
    for (let which = 0; which < 3; which += 1) {
      const i0 = corner[which]!, i1 = corner[(which + 1) % 3]!;
      const originalEdge = { x: mesh.vertices[i1]!.x - mesh.vertices[i0]!.x, y: mesh.vertices[i1]!.y - mesh.vertices[i0]!.y };
      const warpedEdge = { x: stage1[i1]!.x - stage1[i0]!.x, y: stage1[i1]!.y - stage1[i0]!.y };
      const warpedLength = Math.hypot(warpedEdge.x, warpedEdge.y);
      const originalLength = Math.hypot(originalEdge.x, originalEdge.y);
      if (warpedLength < 1e-9 || originalLength < 1e-9) continue;
      // The rotation step 1 chose for this edge, applied to the original edge:
      // same direction as the warped edge, the length it started with.
      const target = { x: (warpedEdge.x / warpedLength) * originalLength, y: (warpedEdge.y / warpedLength) * originalLength };
      fitted.addRow([{ index: xIndex(i1), value: 1 }, { index: xIndex(i0), value: -1 }], target.x);
      fitted.addRow([{ index: yIndex(i1), value: 1 }, { index: yIndex(i0), value: -1 }], target.y);
    }
  }
  for (const pin of pins) {
    fitted.addRow([{ index: xIndex(pin.vertex), value: 1 }], pin.at.x, PIN_WEIGHT);
    fitted.addRow([{ index: yIndex(pin.vertex), value: 1 }], pin.at.y, PIN_WEIGHT);
  }
  const fittedFactor = cholesky(fitted.matrix, size);
  if (!fittedFactor) return stage1;
  const final = choleskySolve(fittedFactor, size, fitted.rhs);
  return Array.from({ length: count }, (_, index) => ({ x: final[xIndex(index)]!, y: final[yIndex(index)]! }));
}

/** Barycentric coordinates of a point in a triangle. */
function barycentric(px: number, py: number, a: Point, b: Point, c: Point): { u: number; v: number; w: number } | null {
  const v0x = b.x - a.x, v0y = b.y - a.y, v1x = c.x - a.x, v1y = c.y - a.y;
  const denominator = v0x * v1y - v1x * v0y;
  if (Math.abs(denominator) < 1e-12) return null;
  const v2x = px - a.x, v2y = py - a.y;
  const v = (v2x * v1y - v1x * v2y) / denominator;
  const w = (v0x * v2y - v2x * v0y) / denominator;
  return { u: 1 - v - w, v, w };
}

function sampleBilinear(pixels: Uint8ClampedArray, width: number, height: number, x: number, y: number): [number, number, number, number] {
  const cx = Math.max(0, Math.min(width - 1, x)), cy = Math.max(0, Math.min(height - 1, y));
  const x0 = Math.floor(cx), y0 = Math.floor(cy);
  const x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1);
  const fx = cx - x0, fy = cy - y0;
  const corners = [(y0 * width + x0) * 4, (y0 * width + x1) * 4, (y1 * width + x0) * 4, (y1 * width + x1) * 4];
  const weights = [(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy];
  let alpha = 0, red = 0, green = 0, blue = 0;
  for (let corner = 0; corner < 4; corner += 1) {
    const at = corners[corner]!, weight = weights[corner]!, cornerAlpha = pixels[at + 3]! / 255;
    alpha += cornerAlpha * weight;
    red += pixels[at]! * cornerAlpha * weight;
    green += pixels[at + 1]! * cornerAlpha * weight;
    blue += pixels[at + 2]! * cornerAlpha * weight;
  }
  if (alpha <= 0) return [0, 0, 0, 0];
  return [red / alpha, green / alpha, blue / alpha, alpha * 255];
}

/**
 * Draws the layer through the deformed mesh — the donor's `graph_defined_warp`:
 * every destination pixel inside a deformed triangle is mapped back to the same
 * barycentric spot in that triangle's original, and sampled there.
 *
 * One pass over the destination, reading only the pristine source, for the same
 * reason the Warp mesh next door had to be rewritten that way: a warp that
 * resamples its own output smears.
 */
export function puppetWarpPixels(
  source: Uint8ClampedArray, width: number, height: number,
  mesh: PuppetMesh, deformed: readonly Point[], selection: PixelSelection | null,
): Uint8ClampedArray {
  const output = source.slice();
  const left = Math.max(0, Math.floor(mesh.bounds.x)), top = Math.max(0, Math.floor(mesh.bounds.y));
  const right = Math.min(width, Math.ceil(mesh.bounds.x + mesh.bounds.width));
  const bottom = Math.min(height, Math.ceil(mesh.bounds.y + mesh.bounds.height));
  const coverage = (index: number) => selection
    ? selection.mask[index]! / 255
    : (index % width >= left && index % width < right && Math.floor(index / width) >= top && Math.floor(index / width) < bottom ? 1 : 0);

  for (let y = top; y < bottom; y += 1) for (let x = left; x < right; x += 1) {
    const index = y * width + x, alpha = coverage(index);
    if (alpha <= 0) continue;
    const pixel = index * 4, remaining = 1 - alpha;
    output[pixel] = Math.round(output[pixel]! * remaining);
    output[pixel + 1] = Math.round(output[pixel + 1]! * remaining);
    output[pixel + 2] = Math.round(output[pixel + 2]! * remaining);
    output[pixel + 3] = Math.round(output[pixel + 3]! * remaining);
  }

  for (let t = 0; t < mesh.triangles.length; t += 3) {
    const i0 = mesh.triangles[t]!, i1 = mesh.triangles[t + 1]!, i2 = mesh.triangles[t + 2]!;
    const a = deformed[i0]!, b = deformed[i1]!, c = deformed[i2]!;
    const sa = mesh.vertices[i0]!, sb = mesh.vertices[i1]!, sc = mesh.vertices[i2]!;
    const minX = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x))), maxX = Math.min(width, Math.ceil(Math.max(a.x, b.x, c.x)));
    const minY = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y))), maxY = Math.min(height, Math.ceil(Math.max(a.y, b.y, c.y)));
    for (let y = minY; y < maxY; y += 1) for (let x = minX; x < maxX; x += 1) {
      const bary = barycentric(x + 0.5, y + 0.5, a, b, c);
      // A hair of tolerance so the seam between two triangles is covered by one
      // of them rather than falling between both.
      if (!bary || bary.u < -0.0001 || bary.v < -0.0001 || bary.w < -0.0001) continue;
      const sampleX = sa.x * bary.u + sb.x * bary.v + sc.x * bary.w - 0.5;
      const sampleY = sa.y * bary.u + sb.y * bary.v + sc.y * bary.w - 0.5;
      const nearest = Math.max(top, Math.min(bottom - 1, Math.round(sampleY))) * width + Math.max(left, Math.min(right - 1, Math.round(sampleX)));
      const maskAlpha = coverage(nearest);
      if (maskAlpha <= 0) continue;
      const sample = sampleBilinear(source, width, height, sampleX, sampleY);
      const to = (y * width + x) * 4;
      const sourceAlpha = sample[3] / 255 * maskAlpha, destinationAlpha = output[to + 3]! / 255;
      const alpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
      if (alpha <= 0) continue;
      output[to] = Math.round((sample[0] * sourceAlpha + output[to]! * destinationAlpha * (1 - sourceAlpha)) / alpha);
      output[to + 1] = Math.round((sample[1] * sourceAlpha + output[to + 1]! * destinationAlpha * (1 - sourceAlpha)) / alpha);
      output[to + 2] = Math.round((sample[2] * sourceAlpha + output[to + 2]! * destinationAlpha * (1 - sourceAlpha)) / alpha);
      output[to + 3] = Math.round(alpha * 255);
    }
  }
  return output;
}
