import { defaultVectorStyle } from "./appearance";
import { IDENTITY_MATRIX } from "./matrix";
import type { GeometryModifier } from "./modifiers/types";
import type { LengthUnit } from "./units";
import type { Artboard, VectorDocumentState, VectorShape, VectorShapeKind, VectorStyle } from "./types";

export interface VectorDocumentOptions {
  resolution?: number;
  displayUnit?: LengthUnit;
}

export function createVectorDocument(width = 1280, height = 720, options: VectorDocumentOptions = {}): VectorDocumentState {
  return {
    kind: "vector", schemaVersion: 11, width, height,
    artboards: [], activeArtboardId: null, resolution: options.resolution ?? 72, displayUnit: options.displayUnit ?? "px",
    shapes: [], activeShapeId: null, selection: [], palette: [],
    guides: [], rulerOrigin: null, rulerMode: "global",
    cmykProfileAssetId: null, softproof: false,
  };
}

let artboardCounter = 0;
export function createArtboard(x: number, y: number, width: number, height: number, name?: string): Artboard {
  artboardCounter += 1;
  return { id: `artboard-${artboardCounter}`, name: name ?? `Artboard (Монтажная область) ${artboardCounter}`, x, y, width, height, bleed: 0 };
}

let counter = 0;
/** Short, readable ids ("rectangle-1") rather than UUIDs — vector documents stay small enough that collisions across a session are not a concern *within one running session*. That assumption breaks the moment a document is persisted and reloaded: `counter` is a module-level variable that restarts at 0 on every page load, while the reloaded document's own shapes already carry ids minted by a *previous* run's counter — a fresh session's very first new shape can mint the exact id an already-loaded shape has. `addShape` has no collision check (same reasoning: "small enough not to matter" — which was true only because nothing before this could actually produce a collision), so the new shape and the old one silently become the same array entry to every by-id lookup, and a mutation meant for the new shape lands on the old one's data instead. Found live (`docs/vector-plan.md` section 9's own pen-tool work): a fresh `vector.pen` click on a page that already had a persisted "path-1" square appended its new point straight onto that square's own point list. See `reseedShapeIdCounters` below — the fix, not a workaround. */
function nextId(kind: VectorShapeKind): string {
  counter += 1;
  return `${kind}-${counter}`;
}

/** The highest numeric suffix seen across `ids` (each expected to look like
 * `${kind}-${n}` or `artboard-${n}`) — 0 if none parse. Shared by both
 * counters `reseedShapeIdCounters` bumps below. */
function maxNumericSuffix(ids: Iterable<string>): number {
  let max = 0;
  for (const id of ids) {
    const match = /-(\d+)$/.exec(id);
    if (!match) continue;
    const value = Number(match[1]);
    if (value > max) max = value;
  }
  return max;
}

/**
 * Raises `nextId`'s counter so the *next* shape this session creates
 * cannot collide with one already in `state` — called once when a
 * persisted document re-enters the live app (`apps/web/src/kernel.ts`,
 * right after `autosave.restore()`), the one door every document takes
 * back into the session regardless of which environment it belongs to.
 * Only ever raises the counter, never lowers it — restoring several
 * documents in the same session (several open tabs' worth) must not let a
 * later, sparser document undo the headroom an earlier, denser one
 * already established.
 *
 * Also raises this file's own `artboardCounter` — but that counter backs
 * `createArtboard` above, which only `store.ts`'s "new document with a
 * default artboard" path actually calls; the Artboard tool and the
 * Artboards panel's own "add"/duplicate mint ids from a *separate*
 * `artboardCounter` living in `artboard-ops.ts`'s `createArtboardAt`, which
 * this function does not touch. See `reseedArtboardIdCounter` there for
 * the counter that matters for a restored document with any real
 * artboards in it — found only after `bleed` (stage 15) required touching
 * this area anyway, so a document with `artboard-3` already in it could,
 * until this was noticed, mint a colliding `artboard-1` for its first new
 * one, the same id-collision bug this very function was written to close.
 */
export function reseedShapeIdCounters(state: VectorDocumentState): void {
  counter = Math.max(counter, maxNumericSuffix(state.shapes.map((shape) => shape.id)));
  artboardCounter = Math.max(artboardCounter, maxNumericSuffix(state.artboards.map((artboard) => artboard.id)));
}

// A placeholder that `appendShapeAt` (tree.ts) always overwrites the moment a
// shape actually joins a document — see its callers, `addShape` in
// shape-ops.ts and `groupShapes` in group-ops.ts. A shape is never usable
// with this value still on it, but leaving it out entirely would mean every
// factory below has to know about sibling order at construction time, which
// only the document it is about to join can answer.
const UNASSIGNED_ORDER_KEY = "unassigned";

/** Places an image shape referencing an asset already sitting in the kernel's asset store — the
 * counterpart to createShape for the one kind that can't be conjured from nothing, since it
 * needs bytes to point at. */
export function createImageShape(x: number, y: number, width: number, height: number, pixelAssetId: string, name: string): VectorShape {
  const id = nextId("image");
  return { id, kind: "image", visible: true, locked: false, style: defaultVectorStyle(), x, y, width, height, pixelAssetId, name, parentId: null, orderKey: UNASSIGNED_ORDER_KEY, transform: IDENTITY_MATRIX, geometry: [] };
}

/** Creates a shape at a canonical size, for a click-to-place default (a drag then resizes it in place). */
export function createShape(kind: VectorShapeKind, x: number, y: number, style: VectorStyle = defaultVectorStyle()): VectorShape {
  const id = nextId(kind);
  const base = { id, visible: true, locked: false, style, parentId: null as string | null, orderKey: UNASSIGNED_ORDER_KEY, transform: IDENTITY_MATRIX, geometry: [] as GeometryModifier[] };
  if (kind === "rectangle") return { ...base, kind, x, y, width: 160, height: 100, cornerRadius: 0, name: `Rectangle (Прямоугольник) ${id}` };
  if (kind === "ellipse") return { ...base, kind, x, y, width: 160, height: 100, name: `Ellipse (Эллипс) ${id}` };
  if (kind === "line") return { ...base, kind, x1: x, y1: y, x2: x + 160, y2: y, name: `Line (Линия) ${id}` };
  if (kind === "text") return { ...base, kind, x, y, value: "Text (Текст)", fontSize: 32, fontFamily: "Arial", align: "left", frameWidth: null, name: `Text (Текст) ${id}` };
  if (kind === "group") return { ...base, kind, expanded: true, name: `Group (Группа) ${id}` };
  return { ...base, kind: "path", points: [{ x, y }], closed: false, name: `Path (Контур) ${id}` };
}
