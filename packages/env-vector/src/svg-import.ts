import { srgb, type Color } from "@vravio/kernel";
import { colorPaint, emptyVectorStyle, type FillLayer, type Gradient, type Paint, type StrokeCap, type StrokeJoin, type StrokeLayer } from "./appearance";
import { createShape } from "./document";
import { createVectorGroup } from "./group-ops";
import { makeVectorOrderKey, type VectorShape } from "./types";

/**
 * Stage 10 of docs/vector-plan.md: turning `crates/vector-svg`'s
 * `import_svg` JSON (parsed by `usvg`, see that crate's own doc comment for
 * its honest scope cuts — no patterns, no text) into actual `VectorShape`s.
 * This file has no WASM dependency itself — the lazy loading is
 * `apps/web/src/vector-svg-wasm.ts`'s job, the same split Stage 7/8/9
 * already established (this package has no bundler of its own to fetch a
 * `.wasm` file with).
 */

interface ImportedStop { offset: number; color: [number, number, number]; opacity: number }
type ImportedPaint =
  | { kind: "color"; color: [number, number, number] }
  | { kind: "linear"; from: { x: number; y: number }; to: { x: number; y: number }; stops: ImportedStop[] }
  | { kind: "radial"; center: { x: number; y: number }; radius: number; stops: ImportedStop[] };
interface ImportedPaintStyle { paint: ImportedPaint; opacity: number }
interface ImportedStrokeStyle { paint: ImportedPaint; opacity: number; width: number; dash: number[]; cap: string; join: string }
/** One entry of `crates/vector-svg`'s single, order-preserving `nodes`
 * stream — `kind: "group"` carries `id` (for a later node's `parent_id` to
 * reference) and nothing else; `kind: "path"` carries everything else and
 * leaves `id` `null`. See that crate's own `ImportedNode` doc comment for
 * why paths and groups share one ordered list rather than two separate
 * ones — an SVG's own paint order can interleave a path and a sibling
 * group at the same level, and two separately-counted lists have no way to
 * recover which came first. */
interface ImportedNode {
  kind: "path" | "group";
  id: number | null;
  parent_id: number | null;
  transform: [number, number, number, number, number, number];
  d: string | null;
  fill: ImportedPaintStyle | null;
  stroke: ImportedStrokeStyle | null;
  opacity: number | null;
}

function rgbColor([r, g, b]: [number, number, number], alpha: number): Color {
  return srgb(r, g, b, alpha);
}

function toGradient(imported: Extract<ImportedPaint, { kind: "linear" | "radial" }>): Gradient {
  const stops = imported.stops.map((stop) => ({ offset: stop.offset, color: rgbColor(stop.color, stop.opacity) }));
  if (imported.kind === "linear") return { kind: "linear", stops, from: imported.from, to: imported.to };
  return { kind: "radial", stops, from: imported.center, to: { x: imported.center.x + imported.radius, y: imported.center.y } };
}

function toPaint(imported: ImportedPaint, opacity: number): Paint {
  if (imported.kind === "color") return colorPaint(rgbColor(imported.color, opacity));
  return { kind: "gradient", gradient: toGradient(imported) };
}

let layerCounter = 0;
function nextLayerId(prefix: string): string { layerCounter += 1; return `${prefix}-import-${layerCounter}`; }

function toFillLayer(style: ImportedPaintStyle): FillLayer {
  return { id: nextLayerId("fill"), paint: toPaint(style.paint, 1), opacity: style.opacity, visible: true, blendMode: "normal" };
}

function toStrokeLayer(style: ImportedStrokeStyle): StrokeLayer {
  return {
    id: nextLayerId("stroke"), paint: toPaint(style.paint, 1), opacity: style.opacity, width: style.width, visible: true, blendMode: "normal",
    dash: style.dash, cap: (["butt", "round", "square"].includes(style.cap) ? style.cap : "butt") as StrokeCap,
    join: (["miter", "round", "bevel"].includes(style.join) ? style.join : "miter") as StrokeJoin, alignment: "center",
  };
}

/**
 * Splits one `d` string into its subpaths (each own `M...Z?` run) and
 * parses each into `VectorPoint`s with real bezier handles — `Q`
 * (quadratic) is converted to the mathematically equivalent cubic control
 * points, since `VectorPoint` only has room for one curve representation.
 * One usvg `Path` node can hold several disjoint subpaths (a letter with a
 * hole, an icon's several separate strokes) that `VectorShape`'s own
 * `path` kind has no room for in a single shape — so this, not
 * `import_svg`, is where one imported path node becomes N `VectorShape`s.
 *
 * Exported (stage 11's "Convert to Outlines") because `crates/vector-text`'s
 * `text_to_curves` hands back the exact same SVG-path-`d` vocabulary for
 * each glyph — one parser for "a `d` string becomes real bezier points",
 * not a second copy living next to `apps/web/src/vector-text-to-shapes.ts`.
 */
export function subpathsToPoints(d: string): { points: { x: number; y: number; handleIn?: { x: number; y: number }; handleOut?: { x: number; y: number } }[]; closed: boolean }[] {
  const subpaths: string[] = [];
  const parts = d.split(/(?=M)/gi);
  for (const part of parts) if (part.trim()) subpaths.push(part.trim());

  return subpaths.map((subpath) => {
    const tokens = subpath.match(/[MLQCZ][^MLQCZ]*/gi) ?? [];
    const points: { x: number; y: number; handleIn?: { x: number; y: number }; handleOut?: { x: number; y: number } }[] = [];
    let closed = false;
    for (const token of tokens) {
      const command = token[0]!.toUpperCase();
      const numbers = (token.slice(1).match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
      if (command === "Z") { closed = true; continue; }
      if (command === "M" || command === "L") {
        points.push({ x: numbers[0]!, y: numbers[1]! });
      } else if (command === "Q" && points.length) {
        const prev = points[points.length - 1]!;
        const qx = numbers[0]!, qy = numbers[1]!, x = numbers[2]!, y = numbers[3]!;
        prev.handleOut = { x: (2 / 3) * (qx - prev.x), y: (2 / 3) * (qy - prev.y) };
        points.push({ x, y, handleIn: { x: (2 / 3) * (qx - x), y: (2 / 3) * (qy - y) } });
      } else if (command === "C" && points.length) {
        const prev = points[points.length - 1]!;
        const c1x = numbers[0]!, c1y = numbers[1]!, c2x = numbers[2]!, c2y = numbers[3]!, x = numbers[4]!, y = numbers[5]!;
        prev.handleOut = { x: c1x - prev.x, y: c1y - prev.y };
        points.push({ x, y, handleIn: { x: c2x - x, y: c2y - y } });
      }
    }
    return { points, closed };
  });
}

/**
 * Parses `import_svg`'s JSON output into `VectorShape`s, ready to push
 * directly onto a fresh document's `shapes` array (in the returned order —
 * not through `addShape`, which forces `parentId: null` unconditionally
 * and would flatten the very hierarchy this function reconstructs).
 *
 * Group nesting is preserved (added 6 September 2026 — a real `usvg::Group`
 * becomes a real `VectorShape` group, `parentId`/`orderKey` set correctly
 * on every returned shape) rather than the earlier pass's flattened
 * top-level list — see `crates/vector-svg`'s own doc comment for exactly
 * what still isn't carried over (a group's own opacity/clip/mask) and why
 * paths and groups arrive as one interleaved stream, not two separate
 * lists, to keep the source's own paint order.
 *
 * `orderKey`s are computed fresh here, one running counter per parent —
 * safe only because this always populates a *brand-new* document with no
 * existing siblings to collide with (`apps/web/src/App.tsx`'s own
 * `importSvgAsVector`, the only caller, opens a fresh document first).
 */
export function importedShapesFromJson(json: string): VectorShape[] {
  const imported = JSON.parse(json) as { nodes: ImportedNode[] };
  const groupShapeIdByImportedId = new Map<number, string>();
  const siblingIndexByParent = new Map<string | null, number>();
  const nextOrderKey = (parentId: string | null): string => {
    const index = siblingIndexByParent.get(parentId) ?? 0;
    siblingIndexByParent.set(parentId, index + 1);
    return makeVectorOrderKey(index);
  };

  const shapes: VectorShape[] = [];
  for (const node of imported.nodes) {
    const parentId = node.parent_id !== null ? (groupShapeIdByImportedId.get(node.parent_id) ?? null) : null;
    const transform = { a: node.transform[0], b: node.transform[1], c: node.transform[2], d: node.transform[3], e: node.transform[4], f: node.transform[5] };

    if (node.kind === "group") {
      const group = createVectorGroup();
      group.parentId = parentId;
      group.orderKey = nextOrderKey(parentId);
      group.transform = transform;
      groupShapeIdByImportedId.set(node.id!, group.id);
      shapes.push(group);
      continue;
    }

    const subpaths = subpathsToPoints(node.d ?? "");
    for (const { points, closed } of subpaths) {
      if (points.length < 2) continue;
      const style = { ...emptyVectorStyle(), opacity: node.opacity ?? 1 };
      if (node.fill) style.fills = [toFillLayer(node.fill)];
      if (node.stroke) style.strokes = [toStrokeLayer(node.stroke)];
      const shape = createShape("path", points[0]!.x, points[0]!.y, style);
      if (shape.kind !== "path") continue;
      shape.points = points;
      shape.closed = closed;
      shape.transform = transform;
      shape.parentId = parentId;
      shape.orderKey = nextOrderKey(parentId);
      shapes.push(shape);
    }
  }
  return shapes;
}
