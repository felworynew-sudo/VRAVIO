/**
 * A 2D affine transform, the standard `a b c d e f` six-number form SVG and
 * Canvas 2D both already use: `x' = a*x + c*y + e`, `y' = b*x + d*y + f`.
 *
 * This is the one thing docs/vector-plan.md §3.1/§7 makes every shape kind
 * share, replacing the per-kind `rotation: number` rectangle and ellipse used
 * to carry on their own (and that path, text, line and image never had at
 * all — bug §2.4). A shape's own x/y/width/height (or points, for a path)
 * describe its geometry in *its own* local space; `transform` is what places
 * that local space into its parent's — the document's, for a shape with no
 * parent. Nesting composes exactly the way `<g transform>` already composes
 * in SVG, which is deliberate: the renderer can hand a group's matrix straight
 * to a wrapping `<g>` and let the browser do the composition, and this module
 * only has to get composition right for the parts nothing else does —
 * hit-testing and bounds math in plain TypeScript.
 */
export interface Matrix { readonly a: number; readonly b: number; readonly c: number; readonly d: number; readonly e: number; readonly f: number }

export const IDENTITY_MATRIX: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export const isIdentityMatrix = (m: Matrix): boolean => m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && m.e === 0 && m.f === 0;

/** `parent ∘ child`: applying the result to a point gives the same answer as
 * applying `child` first and then `parent` — the order a shape's own
 * transform composes with its ancestors' as you walk from document root down
 * to the shape. */
export function multiplyMatrix(parent: Matrix, child: Matrix): Matrix {
  return {
    a: parent.a * child.a + parent.c * child.b,
    b: parent.b * child.a + parent.d * child.b,
    c: parent.a * child.c + parent.c * child.d,
    d: parent.b * child.c + parent.d * child.d,
    e: parent.a * child.e + parent.c * child.f + parent.e,
    f: parent.b * child.e + parent.d * child.f + parent.f,
  };
}

export function applyMatrix(m: Matrix, point: { x: number; y: number }): { x: number; y: number } {
  return { x: m.a * point.x + m.c * point.y + m.e, y: m.b * point.x + m.d * point.y + m.f };
}

/** `null` for a singular matrix (zero scale on some axis) — callers that need
 * to go from document space back to a shape's local space (hit-testing) treat
 * that as "nothing here can be picked," not as a crash. */
export function invertMatrix(m: Matrix): Matrix | null {
  const det = m.a * m.d - m.b * m.c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const inv = 1 / det;
  return {
    a: m.d * inv, b: -m.b * inv, c: -m.c * inv, d: m.a * inv,
    e: (m.c * m.f - m.d * m.e) * inv, f: (m.b * m.e - m.a * m.f) * inv,
  };
}

export const translationMatrix = (dx: number, dy: number): Matrix => ({ a: 1, b: 0, c: 0, d: 1, e: dx, f: dy });

export const scaleMatrix = (sx: number, sy: number): Matrix => ({ a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 });

/** A rotation of `degrees` around `(cx, cy)` — the pivot a shape rotates
 * around when it has one already (rotate in place, not around the origin),
 * which is what both the old per-kind `rotation` field meant and what a
 * "rotate selection" UI action means. */
export function rotationMatrixAround(degrees: number, cx: number, cy: number): Matrix {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians), sin = Math.sin(radians);
  const rotation: Matrix = { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
  return multiplyMatrix(multiplyMatrix(translationMatrix(cx, cy), rotation), translationMatrix(-cx, -cy));
}

/** SVG/CSS `matrix(a, b, c, d, e, f)` — the one string both a `transform`
 * attribute and a CSS `transform` property accept, so the renderer needs no
 * further branching between the two. */
export const matrixToCss = (m: Matrix): string => `matrix(${m.a}, ${m.b}, ${m.c}, ${m.d}, ${m.e}, ${m.f})`;
