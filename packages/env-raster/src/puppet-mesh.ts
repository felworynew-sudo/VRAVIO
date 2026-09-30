import { traceOutlines } from "./outline";
import type { PuppetMesh } from "./puppet";
import type { Point, RasterRect } from "./types";

/**
 * Puppet Warp's mesh laid on the shape itself, the way Photoshop's is: its outline expanded by
 * `expansion` pixels (Photoshop's "Expansion", default 2), points along that outline and a
 * triangular lattice inside it at the spacing `density` asks for, Delaunay-triangulated, and only
 * the triangles that lie in the shape kept (§65.15).
 *
 * What it replaced was the donor's own mesh — `mikecokina/puppet-warp`'s `triangular_mesh`, a
 * regular grid over a rectangle — cut to the grid cells that had any opaque pixel. That is fine for
 * a rectangle and wrong for anything else: 8×8 square cells overhang a round shape into empty space
 * and follow its edge in steps, so the mesh never matched the layer's own outline ("сетка не
 * полностью повторяет пиксельный слой"), and a curved edge bent in long straight facets.
 */

export type PuppetDensity = "fewer" | "normal" | "more";

/** Roughly how many mesh points each density aims for — Photoshop's three steps. The solver is a
 * dense factorisation per set of pins, so "more" is where its cost starts to show. */
const TARGET_POINTS: Record<PuppetDensity, number> = { fewer: 70, normal: 160, more: 340 };

/** Exact squared Euclidean distance to the nearest filled cell — Felzenszwalb & Huttenlocher's
 * separable lower-envelope transform, O(n). */
function distanceSquared(filled: Uint8Array, width: number, height: number): Float64Array {
  const INF = 1e20;
  const grid = new Float64Array(width * height);
  for (let i = 0; i < grid.length; i += 1) grid[i] = filled[i] ? 0 : INF;
  const size = Math.max(width, height);
  const f = new Float64Array(size), d = new Float64Array(size), z = new Float64Array(size + 1);
  const v = new Int32Array(size);
  const pass = (n: number) => {
    let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < n; q += 1) {
      let s = ((f[q]! + q * q) - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
      while (s <= z[k]!) { k -= 1; s = ((f[q]! + q * q) - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!); }
      k += 1; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q += 1) { while (z[k + 1]! < q) k += 1; d[q] = (q - v[k]!) * (q - v[k]!) + f[v[k]!]!; }
  };
  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < height; y += 1) f[y] = grid[y * width + x]!;
    pass(height);
    for (let y = 0; y < height; y += 1) grid[y * width + x] = d[y]!;
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) f[x] = grid[y * width + x]!;
    pass(width);
    for (let x = 0; x < width; x += 1) grid[y * width + x] = d[x]!;
  }
  return grid;
}

/**
 * Picks points off a traced outline: never further apart than `maxStep` along it, and never
 * letting the chord between two picked points stray more than `tolerance` from the outline itself
 * (Douglas–Peucker, bounded by length). The tolerance is what keeps every original pixel inside
 * the mesh: the outline is `expansion` pixels outside the shape, so a chord that stays within
 * `expansion` of it cannot cut into the shape.
 */
function sampleOutline(loop: readonly Point[], maxStep: number, tolerance: number): Point[] {
  const n = loop.length;
  if (n <= 3) return loop.slice();
  // Walk the closed loop from index 0 back to index 0 (as n).
  const point = (i: number) => loop[i % n]!;
  const keep = new Uint8Array(n + 1);
  keep[0] = 1; keep[n] = 1;
  const refine = (from: number, to: number) => {
    const a = point(from), b = point(to);
    let length = 0;
    for (let i = from; i < to; i += 1) length += Math.hypot(point(i + 1).x - point(i).x, point(i + 1).y - point(i).y);
    let worst = -1, worstDistance = 0;
    const dx = b.x - a.x, dy = b.y - a.y, chord = Math.hypot(dx, dy);
    for (let i = from + 1; i < to; i += 1) {
      const p = point(i);
      const distance = chord < 1e-9 ? Math.hypot(p.x - a.x, p.y - a.y) : Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / chord;
      if (distance > worstDistance) { worstDistance = distance; worst = i; }
    }
    if (worst < 0) return;
    if (worstDistance > tolerance || length > maxStep) {
      // Too far from the outline: split where it strays most. Too long: split at the middle.
      const split = worstDistance > tolerance ? worst : from + Math.max(1, Math.round((to - from) / 2));
      if (split <= from || split >= to) return;
      keep[split] = 1;
      refine(from, split);
      refine(split, to);
    }
  };
  refine(0, n);
  const picked: Point[] = [];
  for (let i = 0; i < n; i += 1) if (keep[i]) picked.push(point(i));
  // A long straight side is one pair of corners to Douglas–Peucker; split it by length too.
  const out: Point[] = [];
  for (let i = 0; i < picked.length; i += 1) {
    const a = picked[i]!, b = picked[(i + 1) % picked.length]!;
    out.push(a);
    const parts = Math.floor(Math.hypot(b.x - a.x, b.y - a.y) / maxStep);
    for (let k = 1; k <= parts; k += 1) {
      const t = k / (parts + 1);
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return out;
}

/** Bowyer–Watson Delaunay triangulation; triangles as vertex-index triples. */
function delaunay(points: readonly Point[]): number[] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  const span = Math.max(maxX - minX, maxY - minY, 1) * 20;
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const all = [...points, { x: cx - span, y: cy - span }, { x: cx + span, y: cy - span }, { x: cx, y: cy + span }];
  const n = points.length;
  type Triangle = { a: number; b: number; c: number; x: number; y: number; r: number };
  const circle = (a: number, b: number, c: number): Triangle => {
    const A = all[a]!, B = all[b]!, C = all[c]!;
    const d = 2 * (A.x * (B.y - C.y) + B.x * (C.y - A.y) + C.x * (A.y - B.y));
    if (Math.abs(d) < 1e-12) return { a, b, c, x: 0, y: 0, r: Infinity };
    const a2 = A.x * A.x + A.y * A.y, b2 = B.x * B.x + B.y * B.y, c2 = C.x * C.x + C.y * C.y;
    const x = (a2 * (B.y - C.y) + b2 * (C.y - A.y) + c2 * (A.y - B.y)) / d;
    const y = (a2 * (C.x - B.x) + b2 * (A.x - C.x) + c2 * (B.x - A.x)) / d;
    return { a, b, c, x, y, r: (A.x - x) ** 2 + (A.y - y) ** 2 };
  };
  let triangles: Triangle[] = [circle(n, n + 1, n + 2)];
  for (let i = 0; i < n; i += 1) {
    const p = all[i]!;
    const bad: Triangle[] = [], good: Triangle[] = [];
    for (const t of triangles) ((p.x - t.x) ** 2 + (p.y - t.y) ** 2 <= t.r ? bad : good).push(t);
    const edges = new Map<number, [number, number]>();
    const key = (u: number, v: number) => (u < v ? u * (n + 3) + v : v * (n + 3) + u);
    for (const t of bad) for (const [u, v] of [[t.a, t.b], [t.b, t.c], [t.c, t.a]] as const) {
      const k = key(u, v);
      if (edges.has(k)) edges.delete(k); else edges.set(k, [u, v]);
    }
    for (const [u, v] of edges.values()) good.push(circle(u, v, i));
    triangles = good;
  }
  const out: number[] = [];
  for (const t of triangles) if (t.a < n && t.b < n && t.c < n) out.push(t.a, t.b, t.c);
  return out;
}

/**
 * The mesh for a layer's own pixels (`width`×`height`, straight RGBA, its top-left at document
 * `originX/Y`) — in document coordinates, possibly past the canvas. Null when the layer is empty.
 */
export function puppetMeshFromAlpha(pixels: Uint8ClampedArray, width: number, height: number, originX: number, originY: number, density: PuppetDensity = "normal", expansion = 2): PuppetMesh | null {
  // At least a pixel: with none, a chord across a convex corner could shave off an antialiased
  // edge pixel that then has no triangle to be drawn through.
  const grow = Math.max(1, Math.round(expansion));
  const W = width + 2 * grow, H = height + 2 * grow;
  const shape = new Uint8Array(W * H);
  let any = false;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    if (pixels[(y * width + x) * 4 + 3]! > 0) { shape[(y + grow) * W + x + grow] = 1; any = true; }
  }
  if (!any) return null;
  const distance = distanceSquared(shape, W, H);
  const region = new Uint8Array(W * H);
  let area = 0;
  for (let i = 0; i < region.length; i += 1) if (distance[i]! <= grow * grow) { region[i] = 1; area += 1; }

  const spacing = Math.max(6, Math.sqrt(area / (0.866 * TARGET_POINTS[density])));
  const outlines = traceOutlines(W, H, (x, y) => region[y * W + x] === 1);
  const points: Point[] = [];
  for (const outline of outlines) for (const loop of [outline.outer, ...outline.holes]) points.push(...sampleOutline(loop, spacing * 0.7, grow * 0.9));

  // Interior: a triangular lattice, skipping anything too close to a point already placed.
  const bucket = new Map<number, Point[]>();
  const cellOf = (x: number, y: number) => Math.floor(x / spacing) * 100003 + Math.floor(y / spacing);
  for (const p of points) { const k = cellOf(p.x, p.y); (bucket.get(k) ?? bucket.set(k, []).get(k)!).push(p); }
  const tooClose = (x: number, y: number, limit: number) => {
    const cx = Math.floor(x / spacing), cy = Math.floor(y / spacing);
    for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) {
      for (const q of bucket.get((cx + dx) * 100003 + cy + dy) ?? []) if ((q.x - x) ** 2 + (q.y - y) ** 2 < limit * limit) return true;
    }
    return false;
  };
  const rowStep = spacing * 0.866;
  for (let row = 0, y = spacing / 2; y < H; row += 1, y += rowStep) {
    for (let x = (row % 2 ? spacing : spacing / 2); x < W; x += spacing) {
      if (!region[Math.floor(y) * W + Math.floor(x)] || tooClose(x, y, spacing * 0.55)) continue;
      const p = { x, y };
      points.push(p);
      const k = cellOf(x, y); (bucket.get(k) ?? bucket.set(k, []).get(k)!).push(p);
    }
  }
  if (points.length < 3) return null;

  const all = delaunay(points);
  // Kept: triangles whose centre lies in the expanded shape.
  const inside = (x: number, y: number) => { const ix = Math.floor(x), iy = Math.floor(y); return ix >= 0 && iy >= 0 && ix < W && iy < H && region[iy * W + ix] === 1; };
  const kept = new Uint8Array(all.length / 3);
  for (let t = 0; t < kept.length; t += 1) {
    const a = points[all[t * 3]!]!, b = points[all[t * 3 + 1]!]!, c = points[all[t * 3 + 2]!]!;
    if (inside((a.x + b.x + c.x) / 3, (a.y + b.y + c.y) / 3)) kept[t] = 1;
  }
  // Every opaque pixel must end up inside a kept triangle, or the warp has nothing to draw it
  // through and it disappears. Where one is not (a thin sliver the centre test dropped), the
  // triangle that holds it is put back.
  const covered = new Uint8Array(W * H);
  const rasterise = (t: number, visit: (index: number) => void) => {
    const a = points[all[t * 3]!]!, b = points[all[t * 3 + 1]!]!, c = points[all[t * 3 + 2]!]!;
    const den = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
    if (Math.abs(den) < 1e-9) return;
    const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x))), x1 = Math.min(W - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
    const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y))), y1 = Math.min(H - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
    for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) {
      const px = x + 0.5, py = y + 0.5;
      const v = ((px - a.x) * (c.y - a.y) - (py - a.y) * (c.x - a.x)) / den;
      const w = ((b.x - a.x) * (py - a.y) - (b.y - a.y) * (px - a.x)) / den;
      if (v >= -1e-6 && w >= -1e-6 && v + w <= 1 + 1e-6) visit(y * W + x);
    }
  };
  for (let t = 0; t < kept.length; t += 1) if (kept[t]) rasterise(t, (i) => { covered[i] = 1; });
  const owner = new Int32Array(W * H).fill(-1);
  for (let t = 0; t < kept.length; t += 1) if (!kept[t]) rasterise(t, (i) => { if (owner[i] === -1) owner[i] = t; });
  for (let i = 0; i < shape.length; i += 1) {
    if (!shape[i] || covered[i]) continue;
    const t = owner[i]!;
    if (t < 0 || kept[t]) continue;
    kept[t] = 1;
    rasterise(t, (j) => { covered[j] = 1; });
  }

  const remap = new Map<number, number>();
  const vertices: Point[] = [];
  const triangles: number[] = [];
  for (let t = 0; t < kept.length; t += 1) {
    if (!kept[t]) continue;
    for (let corner = 0; corner < 3; corner += 1) {
      const original = all[t * 3 + corner]!;
      let index = remap.get(original);
      if (index === undefined) {
        index = vertices.length; remap.set(original, index);
        const p = points[original]!;
        vertices.push({ x: p.x - grow + originX, y: p.y - grow + originY });
      }
      triangles.push(index);
    }
  }
  if (!triangles.length) return null;
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const p of vertices) { left = Math.min(left, p.x); top = Math.min(top, p.y); right = Math.max(right, p.x); bottom = Math.max(bottom, p.y); }
  const bounds: RasterRect = { x: left, y: top, width: right - left, height: bottom - top };
  return { vertices, triangles, columns: 0, rows: 0, bounds };
}
