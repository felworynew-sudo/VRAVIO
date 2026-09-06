import { colorToCss } from "@vravio/kernel";
import {
  isIdentityMatrix, matrixToCss, pathData, resolveAppearance, siblingsOf, TEXT_LINE_HEIGHT, wrapText,
  type FillLayer, type GradientDef, type StrokeLayer, type TextMeasurer, type VectorDocumentState, type VectorShape,
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

/** `measurer` is only ever consulted for a framed text shape's own
 * word-wrap (`wrapText`) — every other shape kind, and unframed text
 * (`frameWidth: null`, the same single-line behaviour this always had),
 * ignores it entirely. `undefined` here (no measurer supplied) makes a
 * framed shape fall back to rendering its whole `value` as one unwrapped
 * line rather than throwing — the same "degrade, don't crash" contract
 * `shapeBounds`'s own optional `TextMeasurer` already has, needed because
 * this module's own test files import it under Vitest's Node environment,
 * which has no `window` for the browser-backed `vectorTextMeasurer`
 * (`apps/web/src/vector-text-metrics.ts`) to use — only the real UI call
 * sites (`App.tsx`, `DockLayout.tsx`) ever pass one. */
function geometryElement(shape: Exclude<VectorShape, { kind: "image" } | { kind: "group" } | { kind: "instance" }>, attrs: string, measurer?: TextMeasurer): string {
  if (shape.kind === "rectangle") return `<rect x="${shape.x}" y="${shape.y}" width="${shape.width}" height="${shape.height}" rx="${shape.cornerRadius}" ${attrs}/>`;
  if (shape.kind === "ellipse") return `<ellipse cx="${shape.x + shape.width / 2}" cy="${shape.y + shape.height / 2}" rx="${shape.width / 2}" ry="${shape.height / 2}" ${attrs}/>`;
  if (shape.kind === "line") return `<line x1="${shape.x1}" y1="${shape.y1}" x2="${shape.x2}" y2="${shape.y2}" ${attrs}/>`;
  if (shape.kind === "text") {
    const commonAttrs = `font-size="${shape.fontSize}" font-family="${escapeAttr(shape.fontFamily)}" text-anchor="${shape.align === "center" ? "middle" : shape.align === "right" ? "end" : "start"}" ${attrs}`;
    if (shape.frameWidth && measurer) {
      const lines = wrapText(shape.value, shape.fontFamily, shape.fontSize, shape.frameWidth, measurer);
      const tspans = lines.map((line, index) => `<tspan x="${shape.x}" dy="${index === 0 ? 0 : shape.fontSize * TEXT_LINE_HEIGHT}">${escapeAttr(line)}</tspan>`).join("");
      return `<text x="${shape.x}" y="${shape.y}" ${commonAttrs}>${tspans}</text>`;
    }
    return `<text x="${shape.x}" y="${shape.y}" ${commonAttrs}>${escapeAttr(shape.value)}</text>`;
  }
  return `<path d="${escapeAttr(pathData(shape.points, shape.closed))}" ${attrs}/>`;
}

function gradientDefMarkup({ id, gradient }: GradientDef): string {
  const stops = gradient.stops.map((stop) => `<stop offset="${stop.offset}" stop-color="${colorToCss(stop.color)}"/>`).join("");
  if (gradient.kind === "linear") return `<linearGradient id="${id}" gradientUnits="objectBoundingBox" x1="${gradient.from.x}" y1="${gradient.from.y}" x2="${gradient.to.x}" y2="${gradient.to.y}">${stops}</linearGradient>`;
  const radius = Math.hypot(gradient.to.x - gradient.from.x, gradient.to.y - gradient.from.y) || 0.0001;
  return `<radialGradient id="${id}" gradientUnits="objectBoundingBox" cx="${gradient.from.x}" cy="${gradient.from.y}" r="${radius}">${stops}</radialGradient>`;
}

function shapeMarkup(shape: VectorShape, gradientDefs: GradientDef[], measurer?: TextMeasurer): string {
  if (!shape.visible) return "";
  if (shape.kind === "group" || shape.kind === "image" || shape.kind === "instance") return ""; // images have no portable pixel reference to write into a standalone file (see this module's own doc comment); an instance is written as <use> by `walk` instead, since it needs the symbol-id bookkeeping this function doesn't have
  const resolved = resolveAppearance(shape.style, shape.id);
  gradientDefs.push(...resolved.gradientDefs);
  const transform = isIdentityMatrix(shape.transform) ? "" : ` transform="${matrixToCss(shape.transform)}"`;
  const fillElements = resolved.fills.filter((fill) => fill.layer.visible).map((fill) => geometryElement(shape, fillAttrs(fill.layer, fill.css), measurer)).join("");
  const strokeElements = resolved.strokes.filter((stroke) => stroke.layer.visible).map((stroke, index) => strokeMarkup(shape, stroke.layer, stroke.css, index, measurer)).join("");
  const blend = shape.style.blendMode === "normal" ? "" : ` style="mix-blend-mode:${shape.style.blendMode}"`;
  return `<g${transform} opacity="${shape.style.opacity}"${blend}>${fillElements}${strokeElements}</g>`;
}

function fillAttrs(layer: FillLayer, css: string): string {
  return `fill="${css}" stroke="none" opacity="${layer.opacity}"${layer.blendMode === "normal" ? "" : ` style="mix-blend-mode:${layer.blendMode}"`}`;
}

function strokeAttrs(layer: StrokeLayer, css: string, width: number): string {
  const dash = layer.dash.length ? ` stroke-dasharray="${layer.dash.join(" ")}"` : "";
  return `fill="none" stroke="${css}" stroke-width="${width}" stroke-linecap="${layer.cap}" stroke-linejoin="${layer.join}"${dash} opacity="${layer.opacity}"${layer.blendMode === "normal" ? "" : ` style="mix-blend-mode:${layer.blendMode}"`}`;
}

/**
 * Mirrors `VectorWorkspace.tsx`'s own `renderShape` stroke handling —
 * see that function's doc comment for why "inside"/"outside" alignment
 * needs a double-width stroke plus a `<clipPath>`/`<mask>` at all (SVG's
 * `stroke` primitive has no native alignment attribute), and specifically
 * for why "outer" is a `<mask>` and not a `<clipPath clip-rule="evenodd">`
 * across two sibling shapes — that was the first attempt here too, and
 * `vector-svg.crosscheck.test.ts` (rendering this exact function's output
 * through `resvg`, not just reading the markup's own attribute strings)
 * caught it rendering straight through to the shape's untouched interior.
 * Kept in step with the live-canvas version by hand, the same acknowledged
 * tradeoff this file's own module doc comment already makes for every
 * other piece of markup here.
 */
function strokeMarkup(shape: Exclude<VectorShape, { kind: "image" } | { kind: "group" } | { kind: "instance" }>, layer: StrokeLayer, css: string, index: number, measurer?: TextMeasurer): string {
  if (layer.alignment === "center") return geometryElement(shape, strokeAttrs(layer, css, layer.width), measurer);
  const confineId = `stroke-align-${shape.id}-${index}`;
  const confine = layer.alignment === "inner"
    ? `<clipPath id="${confineId}">${geometryElement(shape, "", measurer)}</clipPath>`
    : `<mask id="${confineId}"><rect x="-100000" y="-100000" width="200000" height="200000" fill="white"/>${geometryElement(shape, 'fill="black"', measurer)}</mask>`;
  const confineAttr = layer.alignment === "inner" ? `clip-path="url(#${confineId})"` : `mask="url(#${confineId})"`;
  return `${confine}${geometryElement(shape, `${strokeAttrs(layer, css, layer.width * 2)} ${confineAttr}`, measurer)}`;
}

/** `usedSymbolIds` collects every symbol an `instance` shape references as
 * `walk` encounters it — real SVG has its own native reuse mechanism
 * (`<symbol>`/`<use>`), a much closer match to a VRAVIO symbol than
 * flattening each instance into its own independent copy of the markup
 * would be, and exactly the same "one shared definition, many placed
 * references" shape the in-app document already has. */
function walk(shapes: readonly VectorShape[], parentId: string | null, gradientDefs: GradientDef[], usedSymbolIds: Set<string>, measurer?: TextMeasurer): string {
  return siblingsOf(shapes, parentId).map((shape) => {
    if (!shape.visible) return "";
    if (shape.kind === "group") {
      const transform = isIdentityMatrix(shape.transform) ? "" : ` transform="${matrixToCss(shape.transform)}"`;
      return `<g${transform}>${walk(shapes, shape.id, gradientDefs, usedSymbolIds, measurer)}</g>`;
    }
    if (shape.kind === "instance") {
      usedSymbolIds.add(shape.symbolId);
      const transform = isIdentityMatrix(shape.transform) ? "" : ` transform="${matrixToCss(shape.transform)}"`;
      return `<use href="#${shape.symbolId}"${transform}/>`;
    }
    return shapeMarkup(shape, gradientDefs, measurer);
  }).join("");
}

/** The whole document as a standalone `.svg` string — `width`/`height` on
 * the root, one `<defs>` for every gradient any shape resolved to, then the
 * shape tree in paint order. */
/**
 * `crop`, when given, exports one artboard's own rectangle (stage 15 of
 * docs/vector-plan.md's "export by artboard") instead of the whole
 * document — the `viewBox` moves to the artboard's own (x, y) and every
 * shape keeps its real document-space coordinates (nothing is
 * re-parented or re-positioned), the same "crop the view, not the
 * content" a camera crop is. Anything outside the artboard's rectangle
 * simply falls outside the exported `viewBox` — SVG's own default clip,
 * not code this function has to write itself.
 *
 * `measurer`, when given, is what a framed text shape's own word-wrap
 * (`geometryElement`'s text branch) measures against — pass
 * `vectorTextMeasurer` (`vector-text-metrics.ts`) from a real browser call
 * site. Omitted, a framed shape falls back to one unwrapped line rather
 * than throwing — this module's own test files run under Vitest's Node
 * environment, which has no `window` for that measurer to use at all.
 */
export function exportVectorDocumentToSvg(state: VectorDocumentState, crop?: { x: number; y: number; width: number; height: number }, measurer?: TextMeasurer): string {
  const gradientDefs: GradientDef[] = [];
  const usedSymbolIds = new Set<string>();
  const body = walk(state.shapes, null, gradientDefs, usedSymbolIds, measurer);

  // A symbol's own content can itself use another symbol — walking one
  // adds to `usedSymbolIds` mid-loop, so this keeps processing newly
  // discovered ids until nothing new turns up, rather than snapshotting
  // the set once and missing a nested reference.
  const processedSymbolIds = new Set<string>();
  let symbolDefs = "";
  for (;;) {
    const pending = [...usedSymbolIds].filter((id) => !processedSymbolIds.has(id));
    if (pending.length === 0) break;
    for (const symbolId of pending) {
      processedSymbolIds.add(symbolId);
      symbolDefs += `<symbol id="${symbolId}">${walk(state.shapes, symbolId, gradientDefs, usedSymbolIds, measurer)}</symbol>`;
    }
  }

  const defs = gradientDefs.length || symbolDefs ? `<defs>${symbolDefs}${gradientDefs.map(gradientDefMarkup).join("")}</defs>` : "";
  const box = crop ?? { x: 0, y: 0, width: state.width, height: state.height };
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${box.width}" height="${box.height}" viewBox="${box.x} ${box.y} ${box.width} ${box.height}">${defs}${body}</svg>`;
}
