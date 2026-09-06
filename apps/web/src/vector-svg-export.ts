import { colorToCss } from "@vravio/kernel";
import {
  isIdentityMatrix, matrixToCss, pathData, resolveAppearance, siblingsOf,
  type FillLayer, type GradientDef, type StrokeLayer, type VectorDocumentState, type VectorShape,
} from "@vravio/env-vector";

/**
 * Stage 10 of docs/vector-plan.md: exporting the semantic model as an SVG
 * file someone else's software can open — plain TS, no WASM, since this
 * direction (our own model → text) never needs `usvg`'s "make sense of
 * someone else's markup" job; it only needs to write markup this app's own
 * model already fully determines. Deliberately kept close to
 * `VectorWorkspace.tsx`'s own `renderShape`/`geometryFor` (same fill/stroke
 * stacking order, same gradient handling) so what a browser shows live and
 * what gets written to a `.svg` file can't quietly drift apart — see
 * `vector-svg.crosscheck.test.ts` for the check that actually proves that,
 * via `resvg` rendering this function's own output.
 */

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function geometryElement(shape: Exclude<VectorShape, { kind: "image" } | { kind: "group" }>, attrs: string): string {
  if (shape.kind === "rectangle") return `<rect x="${shape.x}" y="${shape.y}" width="${shape.width}" height="${shape.height}" rx="${shape.cornerRadius}" ${attrs}/>`;
  if (shape.kind === "ellipse") return `<ellipse cx="${shape.x + shape.width / 2}" cy="${shape.y + shape.height / 2}" rx="${shape.width / 2}" ry="${shape.height / 2}" ${attrs}/>`;
  if (shape.kind === "line") return `<line x1="${shape.x1}" y1="${shape.y1}" x2="${shape.x2}" y2="${shape.y2}" ${attrs}/>`;
  if (shape.kind === "text") return `<text x="${shape.x}" y="${shape.y}" font-size="${shape.fontSize}" font-family="${escapeAttr(shape.fontFamily)}" text-anchor="${shape.align === "center" ? "middle" : shape.align === "right" ? "end" : "start"}" ${attrs}>${escapeAttr(shape.value)}</text>`;
  return `<path d="${escapeAttr(pathData(shape.points, shape.closed))}" ${attrs}/>`;
}

function gradientDefMarkup({ id, gradient }: GradientDef): string {
  const stops = gradient.stops.map((stop) => `<stop offset="${stop.offset}" stop-color="${colorToCss(stop.color)}"/>`).join("");
  if (gradient.kind === "linear") return `<linearGradient id="${id}" gradientUnits="objectBoundingBox" x1="${gradient.from.x}" y1="${gradient.from.y}" x2="${gradient.to.x}" y2="${gradient.to.y}">${stops}</linearGradient>`;
  const radius = Math.hypot(gradient.to.x - gradient.from.x, gradient.to.y - gradient.from.y) || 0.0001;
  return `<radialGradient id="${id}" gradientUnits="objectBoundingBox" cx="${gradient.from.x}" cy="${gradient.from.y}" r="${radius}">${stops}</radialGradient>`;
}

function shapeMarkup(shape: VectorShape, gradientDefs: GradientDef[]): string {
  if (!shape.visible) return "";
  if (shape.kind === "group" || shape.kind === "image") return ""; // images have no portable pixel reference to write into a standalone file; see this module's own doc comment
  const resolved = resolveAppearance(shape.style, shape.id);
  gradientDefs.push(...resolved.gradientDefs);
  const transform = isIdentityMatrix(shape.transform) ? "" : ` transform="${matrixToCss(shape.transform)}"`;
  const fillElements = resolved.fills.filter((fill) => fill.layer.visible).map((fill) => geometryElement(shape, fillAttrs(fill.layer, fill.css))).join("");
  const strokeElements = resolved.strokes.filter((stroke) => stroke.layer.visible).map((stroke) => geometryElement(shape, strokeAttrs(stroke.layer, stroke.css))).join("");
  const blend = shape.style.blendMode === "normal" ? "" : ` style="mix-blend-mode:${shape.style.blendMode}"`;
  return `<g${transform} opacity="${shape.style.opacity}"${blend}>${fillElements}${strokeElements}</g>`;
}

function fillAttrs(layer: FillLayer, css: string): string {
  return `fill="${css}" stroke="none" opacity="${layer.opacity}"${layer.blendMode === "normal" ? "" : ` style="mix-blend-mode:${layer.blendMode}"`}`;
}

function strokeAttrs(layer: StrokeLayer, css: string): string {
  const dash = layer.dash.length ? ` stroke-dasharray="${layer.dash.join(" ")}"` : "";
  return `fill="none" stroke="${css}" stroke-width="${layer.width}" stroke-linecap="${layer.cap}" stroke-linejoin="${layer.join}"${dash} opacity="${layer.opacity}"${layer.blendMode === "normal" ? "" : ` style="mix-blend-mode:${layer.blendMode}"`}`;
}

function walk(shapes: readonly VectorShape[], parentId: string | null, gradientDefs: GradientDef[]): string {
  return siblingsOf(shapes, parentId).map((shape) => {
    if (!shape.visible) return "";
    if (shape.kind === "group") {
      const transform = isIdentityMatrix(shape.transform) ? "" : ` transform="${matrixToCss(shape.transform)}"`;
      return `<g${transform}>${walk(shapes, shape.id, gradientDefs)}</g>`;
    }
    return shapeMarkup(shape, gradientDefs);
  }).join("");
}

/** The whole document as a standalone `.svg` string — `width`/`height` on
 * the root, one `<defs>` for every gradient any shape resolved to, then the
 * shape tree in paint order. */
export function exportVectorDocumentToSvg(state: VectorDocumentState): string {
  const gradientDefs: GradientDef[] = [];
  const body = walk(state.shapes, null, gradientDefs);
  const defs = gradientDefs.length ? `<defs>${gradientDefs.map(gradientDefMarkup).join("")}</defs>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${state.width}" height="${state.height}" viewBox="0 0 ${state.width} ${state.height}">${defs}${body}</svg>`;
}
