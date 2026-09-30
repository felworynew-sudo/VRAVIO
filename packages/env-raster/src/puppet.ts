import type { Point, RasterRect } from "./types";

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
 * The systems are small — a 9x9 grid is 81 vertices, 162 unknowns — so they are solved densely
 * with a Cholesky factorisation. Pass a {@link PuppetSolverCache} and that factorisation is
 * computed once per *set* of pins and reused for every frame of a drag, where only the
 * right-hand side moves; this is the donor paper's own optimisation (Igarashi et al. 2005 §4).
 *
 * That sentence stood here for a while before any of it was true — there was no cache and every
 * frame refactorised from scratch, at a measured 2.7ms a call. A comment describing behaviour
 * the code does not have is worse than no comment, so this one now names the type that makes it
 * true.
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

/**
 * A grid of `divisions` cells per side over `bounds`, split into triangles.
 *
 * `hasContent`, when given, is asked once per cell whether that cell's own rectangle covers any
 * of the layer's actual opaque pixels — not just whether it falls inside `bounds`. `bounds` is
 * already the layer's tight opaque *bounding box* (`layerOpaqueBounds`, computed by the caller),
 * which removes the empty margin around an upright rectangle of content but does nothing for the
 * empty corners of any bounding box drawn around a shape that is not itself a rectangle — a
 * silhouette, a diagonal object, a limb reaching out of a torso's own bbox. Photoshop's real
 * Puppet Warp mesh follows the shape's own alpha, not its bounding rectangle: the grid dots never
 * appear over dead space, and — found live, measured, not assumed — a bbox that is only half
 * covered by real content was spending roughly half of every drag frame's cost (159ms measured on
 * a 900×1200 bbox around a 46%-filled silhouette) warping pixels nobody will ever see, because
 * `puppetWarpPixels` below only skips a pixel it has no *triangle* covering it, and every cell
 * used to get one regardless of what was under it. Cells without any opaque pixel are dropped
 * before their triangles are ever built — the caller pays nothing for them, not even a
 * transparent warp — and the vertices only cells with content actually reference are the only
 * ones that survive into the returned mesh, kept dense with `nearestVertex`/the solver in mind
 * (a sparse vertex list, not a full grid with some entries marked unused).
 *
 * Omitting `hasContent` keeps the previous behaviour exactly (every cell kept) — every existing
 * caller that has no pixel data handy (this file's own tests) is unaffected.
 */
export function puppetMesh(bounds: RasterRect, divisions = 8, hasContent?: (cell: RasterRect) => boolean): PuppetMesh {
  const columns = divisions + 1, rows = divisions + 1;
  const gridVertices: Point[] = [];
  for (let row = 0; row < rows; row += 1) for (let col = 0; col < columns; col += 1) {
    gridVertices.push({ x: bounds.x + (col / divisions) * bounds.width, y: bounds.y + (row / divisions) * bounds.height });
  }
  const cellWidth = bounds.width / divisions, cellHeight = bounds.height / divisions;
  const gridTriangles: number[] = [];
  for (let row = 0; row < divisions; row += 1) {
    for (let col = 0; col < divisions; col += 1) {
      const cell: RasterRect = { x: bounds.x + col * cellWidth, y: bounds.y + row * cellHeight, width: cellWidth, height: cellHeight };
      if (hasContent && !hasContent(cell)) continue;
      const topLeft = row * columns + col, topRight = topLeft + 1;
      const bottomLeft = topLeft + columns, bottomRight = bottomLeft + 1;
      // Split each cell along the same diagonal, so the mesh has no preferred
      // direction beyond the one a grid already has.
      gridTriangles.push(topLeft, topRight, bottomLeft, topRight, bottomRight, bottomLeft);
    }
  }
  if (!hasContent) return { vertices: gridVertices, triangles: gridTriangles, columns, rows, bounds };

  // Re-index to only the vertices a kept triangle actually references, so a caller iterating
  // `mesh.vertices` (the solver's own unknown count, `nearestVertex`'s search space) never pays
  // for — or, worse, lets a user drop a pin on — a grid corner floating in transparent space.
  const remap = new Map<number, number>();
  const vertices: Point[] = [];
  const triangles: number[] = [];
  for (const original of gridTriangles) {
    let next = remap.get(original);
    if (next === undefined) { next = vertices.length; remap.set(original, next); vertices.push(gridVertices[original]!); }
    triangles.push(next);
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

/**
 * The two factorisations a set of pins produces, kept between frames of a drag.
 *
 * Both least-squares systems have matrices that depend only on the mesh, on *which* vertices are
 * pinned, and on which of those carry a rotation — never on where a pin currently sits or how far
 * it has been turned. Those enter only the right-hand side. So the expensive step (a dense
 * O(n³) factorisation) survives an entire drag, and each frame costs a pair of substitutions.
 *
 * Opaque on purpose: the caller holds one per editing session and passes it back in.
 */
export interface PuppetSolverCache {
  signature: string | null;
  similarFactor: Float64Array | null;
  fittedFactor: Float64Array | null;
}

export function createPuppetSolverCache(): PuppetSolverCache {
  return { signature: null, similarFactor: null, fittedFactor: null };
}

/**
 * What the cached factorisations are valid for: the pinned vertices and, per pin, whether it
 * carries a rotation at all. Not the positions and not the angle — those move the right-hand
 * side, which is rebuilt every call anyway. Sorted, so the order the user happened to add pins
 * in cannot invalidate anything on its own.
 */
function pinSignature(pins: readonly PuppetPin[]): string {
  return pins.map((pin) => `${pin.vertex}:${pin.rotation ? 1 : 0}`).sort().join(",");
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
  /** Null when the factorisation is being reused: every frame of a drag only needs Aᵀb, and
   * building AᵀA anyway — a dense size² array, twice per frame — was most of what a frame cost
   * once the factorisation itself was cached (§65.15). */
  readonly matrix: Float64Array | null;
  readonly rhs: Float64Array;

  constructor(size: number, withMatrix = true) {
    this.size = size;
    this.matrix = withMatrix ? new Float64Array(size * size) : null;
    this.rhs = new Float64Array(size);
  }

  /** One row: `sum(coefficient * unknown) = value`, weighted. */
  addRow(terms: readonly { readonly index: number; readonly value: number }[], value: number, weight = 1): void {
    const matrix = this.matrix;
    for (const a of terms) {
      this.rhs[a.index] = this.rhs[a.index]! + weight * a.value * value;
      if (!matrix) continue;
      for (const b of terms) {
        matrix[a.index * this.size + b.index] = matrix[a.index * this.size + b.index]! + weight * a.value * b.value;
      }
    }
  }
}

/** How firmly a pin is held relative to the rigidity terms. High enough that a
 * pin lands on the pointer, low enough to keep the system well conditioned. */
const PIN_WEIGHT = 1000;

/** How firmly a Rotation pin holds its one-ring. Below `PIN_WEIGHT`, so where a ring vertex
 * carries a pin of its own the pin still wins — a neighbour the user has pinned by hand is a
 * statement about where the artwork is, and the ring is only a statement about which way it
 * faces. */
const RING_WEIGHT = 250;

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

/** Every vertex sharing a triangle edge with `vertex` — the pin's one-ring. */
function oneRing(mesh: PuppetMesh, vertex: number): number[] {
  const ring = new Set<number>();
  for (let t = 0; t < mesh.triangles.length; t += 3) {
    const corner = [mesh.triangles[t]!, mesh.triangles[t + 1]!, mesh.triangles[t + 2]!];
    if (!corner.includes(vertex)) continue;
    for (const other of corner) if (other !== vertex) ring.add(other);
  }
  return [...ring];
}

/**
 * The rows a Rotation pin contributes: its immediate neighbours are asked to sit where the
 * pin's own rotation would carry them.
 *
 * A Position pin says only "this point is here", which leaves the artwork around it free to
 * arrive at any angle — so a single pin cannot twist anything, and that is the whole of what
 * Photoshop's third pin kind adds. Constraining the one-ring is the smallest statement that
 * says "and this neighbourhood is turned by θ": the ring's own neighbours are still free, so
 * the twist relaxes outward over the mesh instead of rotating the layer as a block.
 *
 * Photoshop is the donor here by behaviour rather than by code (it is closed, and
 * `mikecokina/puppet-warp` implements position pins only): a Rotation pin turns the mesh
 * around itself, and the further from the pin, the less of the turn survives.
 */
function addRotationRows(equations: NormalEquations, mesh: PuppetMesh, pins: readonly PuppetPin[], xIndex: (v: number) => number, yIndex: (v: number) => number): void {
  for (const pin of pins) {
    if (!pin.rotation) continue;
    const cos = Math.cos(pin.rotation), sin = Math.sin(pin.rotation);
    const origin = mesh.vertices[pin.vertex];
    if (!origin) continue;
    for (const neighbour of oneRing(mesh, pin.vertex)) {
      const rest = mesh.vertices[neighbour];
      if (!rest) continue;
      const dx = rest.x - origin.x, dy = rest.y - origin.y;
      equations.addRow([{ index: xIndex(neighbour), value: 1 }], pin.at.x + dx * cos - dy * sin, RING_WEIGHT);
      equations.addRow([{ index: yIndex(neighbour), value: 1 }], pin.at.y + dx * sin + dy * cos, RING_WEIGHT);
    }
  }
}

/**
 * Solves the mesh for a set of pins. Returns the deformed vertices, or the
 * original ones when the pins leave the mesh free to drift.
 */
export function solvePuppetMesh(mesh: PuppetMesh, pins: readonly PuppetPin[], cache?: PuppetSolverCache): readonly Point[] {
  const count = mesh.vertices.length;
  if (!pins.length) return mesh.vertices;
  const signature = cache ? pinSignature(pins) : null;
  // Valid only if the cache was filled for this very set of pins. Anything else — a pin added,
  // removed, or newly given a rotation — changes which entries the matrices even have.
  const reusable = cache !== undefined && cache.signature === signature;
  const size = count * 2;
  const xIndex = (vertex: number) => vertex * 2, yIndex = (vertex: number) => vertex * 2 + 1;

  // Step 1: rotation and uniform scale are free, everything else is penalised.
  const similar = new NormalEquations(size, !(reusable && cache!.similarFactor));
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
  addRotationRows(similar, mesh, pins, xIndex, yIndex);
  let similarFactor = reusable ? cache!.similarFactor : null;
  if (!similarFactor) {
    similarFactor = similar.matrix ? cholesky(similar.matrix, size) : null;
    if (cache) {
      // A new epoch: the fitted factor from the old signature must not survive it, even by
      // accident, so it is cleared together with the signature it belonged to.
      cache.signature = signature;
      cache.similarFactor = similarFactor;
      cache.fittedFactor = null;
    }
  }
  if (!similarFactor) return mesh.vertices;
  const intermediate = choleskySolve(similarFactor, size, similar.rhs);
  const stage1: Point[] = Array.from({ length: count }, (_, index) => ({ x: intermediate[xIndex(index)]!, y: intermediate[yIndex(index)]! }));

  // Step 2: take each triangle's rotation from step 1, apply it to the
  // triangle's original edges, and ask the mesh to match those — which is what
  // gives the original size back.
  const fitted = new NormalEquations(size, !(reusable && cache!.fittedFactor));
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
  // Both stages, or the second would quietly undo the first: step 2 re-fits every edge to the
  // rotation step 1 chose, and a constraint present in only one of them is a constraint the
  // other is free to relax away.
  addRotationRows(fitted, mesh, pins, xIndex, yIndex);
  let fittedFactor = reusable ? cache!.fittedFactor : null;
  if (!fittedFactor) {
    fittedFactor = fitted.matrix ? cholesky(fitted.matrix, size) : null;
    if (cache) cache.fittedFactor = fittedFactor;
  }
  if (!fittedFactor) return stage1;
  const final = choleskySolve(fittedFactor, size, fitted.rhs);
  return Array.from({ length: count }, (_, index) => ({ x: final[xIndex(index)]!, y: final[yIndex(index)]! }));
}

/**
 * Draws a layer through its deformed mesh — the donor's `graph_defined_warp`: every destination
 * pixel inside a deformed triangle is mapped back to the same barycentric spot in that triangle's
 * original, and sampled there. Reads only the pristine source, so a warp never resamples its own
 * output (the Warp mesh next door learned why).
 *
 * `source` is `sourceWidth`×`sourceHeight` straight RGBA with its top-left at document
 * `sourceX/Y`; `target` likewise at `targetX/Y`; mesh and deformed points are document space. The
 * result is composited over `target` and the document rectangle drawn into is returned.
 *
 * Written for a frame per pointer move (§65.15): each triangle's destination→source map is one
 * affine precomputed before its pixels, the inside test is three incrementally-updated edge
 * values, and the bilinear sample is inline. The version it replaced called a function returning
 * a fresh object per pixel and a sampler allocating two arrays per pixel, over a document-sized
 * copy of the layer, every frame.
 */
export function renderPuppetWarp(
  source: Uint8ClampedArray, sourceWidth: number, sourceHeight: number, sourceX: number, sourceY: number,
  mesh: PuppetMesh, deformed: readonly Point[],
  target: Uint8ClampedArray, targetWidth: number, targetHeight: number, targetX: number, targetY: number,
  step = 1,
): RasterRect | null {
  // `step` > 1 is a live preview at reduced detail — Krita's Instant Preview: one sample per
  // step×step block on a grid shared by every triangle (so blocks meet without gaps), the full
  // resolution kept for the commit.
  const block = Math.max(1, Math.floor(step));
  let drawnLeft = Infinity, drawnTop = Infinity, drawnRight = -Infinity, drawnBottom = -Infinity;
  const triangles = mesh.triangles;
  for (let t = 0; t < triangles.length; t += 3) {
    const i0 = triangles[t]!, i1 = triangles[t + 1]!, i2 = triangles[t + 2]!;
    const a = deformed[i0]!, b = deformed[i1]!, c = deformed[i2]!;
    const ax = a.x - targetX, ay = a.y - targetY, bx = b.x - targetX, by = b.y - targetY, cx = c.x - targetX, cy = c.y - targetY;
    const den = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    if (Math.abs(den) < 1e-9) continue;
    const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx))), maxX = Math.min(targetWidth, Math.ceil(Math.max(ax, bx, cx)));
    const minY = Math.max(0, Math.floor(Math.min(ay, by, cy))), maxY = Math.min(targetHeight, Math.ceil(Math.max(ay, by, cy)));
    if (maxX <= minX || maxY <= minY) continue;
    const sa = mesh.vertices[i0]!, sb = mesh.vertices[i1]!, sc = mesh.vertices[i2]!;
    const sax = sa.x - sourceX, say = sa.y - sourceY;
    const ubx = sb.x - sa.x, uby = sb.y - sa.y, ucx = sc.x - sa.x, ucy = sc.y - sa.y;
    // v, w as linear functions of the pixel centre (px, py).
    const vdx = (cy - ay) / den * block, wdx = -(by - ay) / den * block;
    const firstX = minX - minX % block, firstY = minY - minY % block, half = block / 2;
    for (let y = firstY; y < maxY; y += block) {
      const py = y + half;
      let v = ((firstX + half - ax) * (cy - ay) - (py - ay) * (cx - ax)) / den;
      let w = ((bx - ax) * (py - ay) - (by - ay) * (firstX + half - ax)) / den;
      for (let x = firstX; x < maxX; x += block, v += vdx, w += wdx) {
        if (v < -1e-7 || w < -1e-7 || v + w > 1 + 1e-7) continue;
        // Source position, then a bilinear sample around it (pixel centres at +0.5).
        const fx = sax + v * ubx + w * ucx - 0.5, fy = say + v * uby + w * ucy - 0.5;
        const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
        let sr = 0, sg = 0, sbl = 0, salpha = 0;
        for (let corner = 0; corner < 4; corner += 1) {
          const sx = x0 + (corner & 1), sy = y0 + (corner >> 1);
          if (sx < 0 || sy < 0 || sx >= sourceWidth || sy >= sourceHeight) continue;
          const weight = ((corner & 1) ? tx : 1 - tx) * ((corner >> 1) ? ty : 1 - ty);
          const at = (sy * sourceWidth + sx) * 4, alpha = source[at + 3]! * weight;
          if (alpha === 0) continue;
          sr += source[at]! * alpha; sg += source[at + 1]! * alpha; sbl += source[at + 2]! * alpha; salpha += alpha;
        }
        if (salpha <= 0) continue;
        const sourceAlpha = salpha / 255;
        // Over transparency — nearly every pixel, since the preview buffer and a commit frame both
        // start empty — "over" is a plain store of the sample's own straight colour.
        const plainR = Math.round(sr / salpha), plainG = Math.round(sg / salpha), plainB = Math.round(sbl / salpha), plainA = Math.round(salpha);
        const rowEnd = Math.min(targetHeight, y + block), columnEnd = Math.min(targetWidth, x + block);
        for (let by2 = Math.max(0, y); by2 < rowEnd; by2 += 1) for (let bx2 = Math.max(0, x); bx2 < columnEnd; bx2 += 1) {
          const to = (by2 * targetWidth + bx2) * 4;
          if (target[to + 3] === 0) { target[to] = plainR; target[to + 1] = plainG; target[to + 2] = plainB; target[to + 3] = plainA; continue; }
          const destinationAlpha = target[to + 3]! / 255;
          const outAlpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
          const keep = destinationAlpha * (1 - sourceAlpha);
          target[to] = Math.round((sr / 255 + target[to]! * keep) / outAlpha);
          target[to + 1] = Math.round((sg / 255 + target[to + 1]! * keep) / outAlpha);
          target[to + 2] = Math.round((sbl / 255 + target[to + 2]! * keep) / outAlpha);
          target[to + 3] = Math.round(outAlpha * 255);
        }
      }
    }
    // Whole blocks: the last one can reach past the triangle's own box.
    const blockRight = Math.min(targetWidth, maxX + block - 1), blockBottom = Math.min(targetHeight, maxY + block - 1);
    if (firstX < drawnLeft) drawnLeft = firstX; if (firstY < drawnTop) drawnTop = firstY;
    if (blockRight > drawnRight) drawnRight = blockRight; if (blockBottom > drawnBottom) drawnBottom = blockBottom;
  }
  return drawnRight > drawnLeft ? { x: drawnLeft + targetX, y: drawnTop + targetY, width: drawnRight - drawnLeft, height: drawnBottom - drawnTop } : null;
}

/** Every pixel centre a set of triangles covers, in a `width`×`height` buffer at the origin. */
export function forEachMeshPixel(vertices: readonly Point[], triangles: readonly number[], width: number, height: number, visit: (index: number) => void): void {
  for (let t = 0; t < triangles.length; t += 3) {
    const a = vertices[triangles[t]!]!, b = vertices[triangles[t + 1]!]!, c = vertices[triangles[t + 2]!]!;
    const den = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
    if (Math.abs(den) < 1e-9) continue;
    const minX = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x))), maxX = Math.min(width, Math.ceil(Math.max(a.x, b.x, c.x)));
    const minY = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y))), maxY = Math.min(height, Math.ceil(Math.max(a.y, b.y, c.y)));
    for (let y = minY; y < maxY; y += 1) for (let x = minX; x < maxX; x += 1) {
      const px = x + 0.5, py = y + 0.5;
      const v = ((px - a.x) * (c.y - a.y) - (py - a.y) * (c.x - a.x)) / den;
      const w = ((b.x - a.x) * (py - a.y) - (b.y - a.y) * (px - a.x)) / den;
      if (v >= -1e-7 && w >= -1e-7 && v + w <= 1 + 1e-7) visit(y * width + x);
    }
  }
}

/**
 * A document-sized warp: what the mesh covered is lifted out, and drawn back through the deformed
 * mesh over what is left.
 */
export function puppetWarpPixels(source: Uint8ClampedArray, width: number, height: number, mesh: PuppetMesh, deformed: readonly Point[]): Uint8ClampedArray {
  const output = source.slice();
  forEachMeshPixel(mesh.vertices, mesh.triangles, width, height, (index) => { output.fill(0, index * 4, index * 4 + 4); });
  renderPuppetWarp(source, width, height, 0, 0, mesh, deformed, output, width, height, 0, 0);
  return output;
}
