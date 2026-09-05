import { cssToColor } from "@vravio/kernel";
import { solidFill, solidStroke, type VectorStyle } from "./appearance";
import type { GeometryModifier } from "./modifiers/types";
import type { LengthUnit } from "./units";
import { IDENTITY_MATRIX, type Matrix, rotationMatrixAround } from "./matrix";

export type { VectorStyle } from "./appearance";

export interface VectorPoint {
  x: number;
  y: number;
  /**
   * Bezier control handles, stored as offsets from this anchor (not absolute positions) so
   * dragging the anchor moves its curve with it for free. `handleOut` steers the curve leaving
   * toward the next point, `handleIn` the curve arriving from the previous one — Illustrator's
   * own pen: dragging while placing a point pulls out both, mirrored through the anchor, giving
   * a smooth point; a corner point (the default, a plain click) has neither and the segment on
   * either side of it is a straight line.
   */
  handleIn?: { x: number; y: number };
  handleOut?: { x: number; y: number };
}

interface VectorShapeBase {
  readonly id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  style: VectorStyle;
  /**
   * The shape immediately containing this one, or `null` at the document's
   * top level — the same flat-array-plus-parentId shape `RasterLayer` already
   * uses (`packages/env-raster/src/types.ts`), rather than a second,
   * differently-shaped nested tree. Only a `group` shape can be a parent.
   */
  parentId: string | null;
  /** Paint/panel order among siblings sharing the same `parentId` — see
   * `packages/env-raster/src/document.ts`'s `makeLayerOrderKey` for why a
   * sortable string beats a plain index (reordering touches one shape's key,
   * not every sibling's). */
  orderKey: string;
  /**
   * Maps this shape's own geometry (its x/y/width/height, or its points, in
   * the fields below) into its parent's coordinate space — the document's,
   * for a top-level shape. Identity for a shape that has never been moved,
   * scaled or rotated as a unit, which is every shape a v2 document ever
   * stored: this field, and the composition it enables, is additive, so a
   * document with no groups and no rotation behaves exactly as before.
   */
  transform: Matrix;
  /**
   * Stage 9 of docs/vector-plan.md: non-destructive geometry modifiers,
   * back to front — index 0 runs first, against the shape's own base
   * outline (`modifiers/base-path.ts`), and each later entry runs against
   * the previous one's result. Empty for every shape that has never had a
   * modifier added, which is every shape a pre-Stage-9 document ever
   * stored — see `migrateVectorDocumentState`'s v4→v5 step. Only
   * `rectangle`, `ellipse`, and `path` shapes have a base outline for this
   * to act on (`basePathFor`); a stack on any other kind is simply inert.
   */
  geometry: GeometryModifier[];
}

export type VectorShape =
  | (VectorShapeBase & { kind: "rectangle"; x: number; y: number; width: number; height: number; cornerRadius: number })
  | (VectorShapeBase & { kind: "ellipse"; x: number; y: number; width: number; height: number })
  | (VectorShapeBase & { kind: "line"; x1: number; y1: number; x2: number; y2: number })
  | (VectorShapeBase & { kind: "path"; points: readonly VectorPoint[]; closed: boolean })
  | (VectorShapeBase & { kind: "text"; x: number; y: number; value: string; fontSize: number; fontFamily: string; align: "left" | "center" | "right" })
  | (VectorShapeBase & {
      kind: "image"; x: number; y: number; width: number; height: number;
      /**
       * The kernel asset holding this image's pixels — never the pixels themselves. A vector
       * document stays a small tree of shapes; the picture lives in the shared asset store, the
       * same place a raster layer's own pixels live. That's what makes "open this picture in the
       * raster environment, edit it, and see the change here" possible: both documents end up
       * holding a reference to the very same asset, not a copy each keeps privately.
       */
      pixelAssetId: string;
    })
  | (VectorShapeBase & {
      kind: "group";
      /** Whether the layers panel shows this group's children — a display
       * flag, never consulted by geometry, paint order or hit-testing, the
       * same separation `RasterLayer`'s own `expanded` keeps. */
      expanded: boolean;
    });

export type VectorShapeKind = VectorShape["kind"];

/**
 * A rectangle marking a region of the canvas for export and layout — the
 * Illustrator-style artboard docs/vector-plan.md §7.1 chose over a
 * Figma-style frame. An object may sit half outside every artboard, or
 * between two of them, and that is an ordinary document, not a broken one —
 * which is exactly why an artboard is a row in this list rather than a node
 * in the shape tree that could "contain" or clip anything.
 */
export interface Artboard {
  readonly id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VectorDocumentState {
  readonly kind: "vector";
  readonly schemaVersion: 5;
  width: number;
  height: number;
  artboards: Artboard[];
  /** Pixels per inch — the one number `units.ts`'s conversions need to make
   * `10мм` and `500px` both mean something on this document. */
  resolution: number;
  /** What a numeric field shows and accepts when the user has not typed an
   * explicit unit suffix — see `units.ts`'s `parseLength` `fallbackUnit`. */
  displayUnit: LengthUnit;
  /** Back to front; the last entry draws on top, same order convention as raster layers. */
  shapes: VectorShape[];
  activeShapeId: string | null;
  selection: readonly string[];
}

/**
 * In-place and idempotent, so a restored session stays editable without a
 * stop-the-world conversion — the same contract
 * `packages/env-raster/src/document.ts`'s `migrateRasterDocumentState` keeps.
 * One function carries a document from whatever version it was saved at
 * (2 through 5) up to current, in order, rather than one function per step —
 * a v2 document run through this once ends up fully on v5, not stuck at v3
 * waiting for a second pass nothing would ever trigger.
 *
 * What changes at each step:
 *
 * - v2 → v3: rectangle/ellipse/image's own `rotation: number` is baked into
 *   `transform` as a rotation around the shape's own center (the same pivot
 *   the field visually meant), and dropped — one way to store rotation, not
 *   two that could disagree. A stored hex/`rgba()` fill or stroke string
 *   becomes a `Color` via `cssToColor`.
 * - v3 → v4 (stage 6): `style` was `{fill, stroke, strokeWidth, opacity}` —
 *   one fill, one stroke. Becomes `{fills: FillLayer[], strokes:
 *   StrokeLayer[], opacity, blendMode}` — a non-null `fill`/`stroke`
 *   becomes a one-entry stack via the same `solidFill`/`solidStroke`
 *   factories a user adding a fill from the properties panel gets, so a
 *   migrated shape's appearance stack looks exactly like one built by hand
 *   to match it.
 * - v4 → v5 (stage 9): every shape gets an empty `geometry: []` modifier
 *   stack if it doesn't already have one — an empty stack behaves exactly
 *   like no stack at all (`applyModifierStack` just returns the base path
 *   unchanged), so this step is purely additive.
 */
export function migrateVectorDocumentState(state: VectorDocumentState): VectorDocumentState {
  const candidate = state as unknown as {
    artboards?: unknown;
    resolution?: number;
    displayUnit?: LengthUnit;
    shapes: Array<Record<string, unknown>>;
  };
  if (typeof candidate.artboards === "boolean" || candidate.artboards === undefined) candidate.artboards = [];
  candidate.resolution ??= 72;
  candidate.displayUnit ??= "px";

  candidate.shapes.forEach((shape, index) => {
    if (typeof shape.parentId === "undefined") shape.parentId = null;
    if (!shape.orderKey) shape.orderKey = makeVectorOrderKey(index);
    if (!shape.transform) {
      const rotation = typeof shape.rotation === "number" ? shape.rotation : 0;
      if (rotation && ("x" in shape) && ("width" in shape)) {
        const x = shape.x as number, y = shape.y as number, width = shape.width as number, height = shape.height as number;
        shape.transform = rotationMatrixAround(rotation, x + width / 2, y + height / 2);
      } else {
        shape.transform = IDENTITY_MATRIX;
      }
    }
    delete shape.rotation;
    if (!Array.isArray(shape.geometry)) shape.geometry = [];

    const style = shape.style as { fill?: unknown; stroke?: unknown; strokeWidth?: unknown; opacity?: unknown; fills?: unknown; strokes?: unknown } | undefined;
    if (!style) return;
    if (typeof style.fill === "string") style.fill = cssToColor(style.fill);
    if (typeof style.stroke === "string") style.stroke = cssToColor(style.stroke);
    if (!style.fills || !style.strokes) {
      const oldFill = style.fill as ReturnType<typeof cssToColor> | null | undefined;
      const oldStroke = style.stroke as ReturnType<typeof cssToColor> | null | undefined;
      const oldStrokeWidth = typeof style.strokeWidth === "number" ? style.strokeWidth : 2;
      style.fills = oldFill ? [solidFill(oldFill)] : [];
      style.strokes = oldStroke ? [solidStroke(oldStroke, oldStrokeWidth)] : [];
      style.opacity ??= 1;
      (style as { blendMode?: string }).blendMode ??= "normal";
      delete style.fill; delete style.stroke; delete style.strokeWidth;
    }
  });

  (state as { schemaVersion: number }).schemaVersion = 5;
  return state;
}

/** A sortable order key from a plain index — `document.ts`'s
 * `appendShapeAt`/`createVectorGroup` and this migration are the only
 * writers, kept here so both import the one definition instead of each
 * carrying its own copy of `.toString(36).padStart(8, "0")`. Mirrors
 * `packages/env-raster/src/document.ts`'s `makeLayerOrderKey`. */
export function makeVectorOrderKey(index: number): string {
  return Math.max(0, Math.floor(index)).toString(36).padStart(8, "0");
}

export function isVectorDocumentState(value: unknown): value is VectorDocumentState {
  if (!value || typeof value !== "object") return false;
  const state = value as { kind?: unknown; shapes?: unknown; schemaVersion?: unknown };
  if (state.kind !== "vector" || !Array.isArray(state.shapes)) return false;
  if (![2, 3, 4, 5].includes(state.schemaVersion as number)) return false;
  migrateVectorDocumentState(value as VectorDocumentState);
  return true;
}
