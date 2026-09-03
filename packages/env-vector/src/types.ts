export interface VectorStyle {
  /** `null` means no fill, matching Illustrator/Figma's "none" swatch rather than a hidden color. */
  fill: string | null;
  stroke: string | null;
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
}

export type VectorShape =
  | (VectorShapeBase & { kind: "rectangle"; x: number; y: number; width: number; height: number; rotation: number; cornerRadius: number })
  | (VectorShapeBase & { kind: "ellipse"; x: number; y: number; width: number; height: number; rotation: number })
  | (VectorShapeBase & { kind: "line"; x1: number; y1: number; x2: number; y2: number })
  | (VectorShapeBase & { kind: "path"; points: readonly VectorPoint[]; closed: boolean })
  | (VectorShapeBase & { kind: "text"; x: number; y: number; value: string; fontSize: number; fontFamily: string; align: "left" | "center" | "right" })
  | (VectorShapeBase & {
      kind: "image"; x: number; y: number; width: number; height: number; rotation: number;
      /**
       * The kernel asset holding this image's pixels — never the pixels themselves. A vector
       * document stays a small tree of shapes; the picture lives in the shared asset store, the
       * same place a raster layer's own pixels live. That's what makes "open this picture in the
       * raster environment, edit it, and see the change here" possible: both documents end up
       * holding a reference to the very same asset, not a copy each keeps privately.
       */
      pixelAssetId: string;
    });

export type VectorShapeKind = VectorShape["kind"];

export interface VectorDocumentState {
  readonly kind: "vector";
  readonly schemaVersion: 2;
  width: number;
  height: number;
  artboards: boolean;
  /** Back to front; the last entry draws on top, same order convention as raster layers. */
  shapes: VectorShape[];
  activeShapeId: string | null;
  selection: readonly string[];
}

export function isVectorDocumentState(value: unknown): value is VectorDocumentState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<VectorDocumentState>;
  return state.kind === "vector" && Array.isArray(state.shapes);
}
