import { type Color, cssToColor } from "@vravio/kernel";
import type { LengthUnit } from "./units";
import { IDENTITY_MATRIX, type Matrix, rotationMatrixAround } from "./matrix";

export interface VectorStyle {
  /** `null` means no fill, matching Illustrator/Figma's "none" swatch rather than a hidden color. */
  fill: Color | null;
  stroke: Color | null;
  strokeWidth: number;
  opacity: number;
}

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
  readonly schemaVersion: 3;
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
 * In-place and idempotent, so a restored v2 session stays editable without a
 * stop-the-world conversion — the same contract
 * `packages/env-raster/src/document.ts`'s `migrateRasterDocumentState` keeps.
 *
 * Two things happen here that are not just "add a default":
 *
 * - Rectangle, ellipse and image used to carry their own `rotation: number`.
 *   That degree value is baked into `transform` as a rotation around the
 *   shape's own center — the same pivot the old field visually meant — and
 *   the field itself is dropped, so there is exactly one way a shape's
 *   rotation is stored going forward, not two that could disagree.
 * - `fill`/`stroke` were `string | null`; a stored hex or `rgba()` string
 *   becomes a `Color` via `cssToColor`, which is the same parser
 *   `<input type="color">`'s change handler feeds through going forward, so a
 *   migrated document's colours render identically to how they always did.
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
    const style = shape.style as { fill?: unknown; stroke?: unknown } | undefined;
    if (style) {
      if (typeof style.fill === "string") style.fill = cssToColor(style.fill);
      if (typeof style.stroke === "string") style.stroke = cssToColor(style.stroke);
    }
  });

  (state as { schemaVersion: number }).schemaVersion = 3;
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
  if (state.schemaVersion !== 2 && state.schemaVersion !== 3) return false;
  migrateVectorDocumentState(value as VectorDocumentState);
  return true;
}
