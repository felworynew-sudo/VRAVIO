/**
 * A minimal SVG path-data reader/writer for the two pure-TS modifiers
 * (`roundCorners`, `zigzag`), which both need the actual vertex list to do
 * their own geometry, not just a string to hand to WASM the way `offset`
 * and `simplify` do.
 *
 * Only `M`/`L`/`Z` (absolute) are read — any `C` segment already present
 * in the input collapses to its own endpoint. That is an honest,
 * documented scoping choice, not an oversight: `base-path.ts` only ever
 * hands these two modifiers a flattened polygon in the first place (a
 * `path` shape's own curves go through unmodified when *no* corner/zigzag
 * modifier is applied, and once one is, this stage treats the shape as a
 * polygon for the rest of the stack — the same "flatten once, work with
 * straight segments" answer the boolean-op pipeline already gives to the
 * same underlying question). A future stage that needs corner-rounding to
 * preserve existing curve segments untouched would need a real path
 * walker, not this one.
 */
export interface FlatPolygon { readonly points: readonly { x: number; y: number }[]; readonly closed: boolean }

export function parseFlatPolygon(d: string): FlatPolygon {
  const points: { x: number; y: number }[] = [];
  let closed = false;
  const commandPattern = /([MLZ])\s*([^MLZ]*)/gi;
  let match: RegExpExecArray | null;
  while ((match = commandPattern.exec(d))) {
    const command = match[1]!.toUpperCase();
    if (command === "Z") { closed = true; continue; }
    const numbers = (match[2]!.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
    for (let i = 0; i + 1 < numbers.length; i += 2) points.push({ x: numbers[i]!, y: numbers[i + 1]! });
  }
  // `pathData()` (env-vector's own writer, used by `path`-kind shapes and
  // `basePathFor`'s rect/ellipse polygons) explicitly closes a loop with a
  // line back to its own first point before the `Z`, duplicating it — this
  // reader normalizes that away so `FlatPolygon`'s convention matches
  // `vector-geometry-port.ts`'s own "no repeated first point" rule
  // everywhere in this codebase, not just at the WASM boundary.
  if (closed && points.length > 1 && points[0]!.x === points[points.length - 1]!.x && points[0]!.y === points[points.length - 1]!.y) points.pop();
  return { points, closed };
}

export function polygonToSvgPath(points: readonly { x: number; y: number }[], closed: boolean): string {
  if (!points.length) return "";
  let d = `M${points[0]!.x},${points[0]!.y}`;
  for (let i = 1; i < points.length; i += 1) d += ` L${points[i]!.x},${points[i]!.y}`;
  if (closed) d += " Z";
  return d;
}
