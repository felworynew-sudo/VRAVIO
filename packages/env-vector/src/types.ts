import { cssToColor, type Color } from "@vravio/kernel";
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
    })
  | (VectorShapeBase & {
      /**
       * Stage 13 of docs/vector-plan.md: a placed reference to a symbol
       * definition, not a copy of its geometry — the whole point of the
       * stage's own test ("a hundred instances don't store a hundred
       * copies"). A symbol's actual content is an ordinary `group` shape
       * living in `state.shapes` like any other, parented to
       * `SYMBOLS_ROOT_ID` (`symbol-ops.ts`) instead of the document root or
       * a real group — which is what keeps it out of normal paint order,
       * the layers panel, and hit-testing, without needing a second,
       * differently-shaped tree or a schema version bump for this file
       * alone. `symbolId` is that group's own `id`. An instance's `x`/`y` of
       * its own do not exist — like a group, `transform` alone places it,
       * and its content renders exactly the way a group's children do (see
       * `VectorWorkspace.tsx`'s `renderShapeTree`), just sourced from the
       * symbol's children instead of this shape's own.
       */
      kind: "instance";
      symbolId: string;
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
  /** Print bleed (docs/vector-plan.md stage 15) — an extra margin outside
   * the artboard's own rectangle that "Export this artboard" includes, and
   * `VectorWorkspace.tsx` draws as a dashed outline around it. `0` (the
   * default) means no bleed, drawn as no extra outline at all rather than
   * a dashed line sitting exactly on top of the solid one. */
  bleed: number;
}

/**
 * One named colour in the document's own palette — docs/vector-plan.md
 * section 8's "Плашечные цвета и палитры документа" (stage 6 addition):
 * a swatch list that travels *with the document*, unlike
 * `ColorPickerDialog.tsx`'s own recent-colours list (`localStorage`,
 * shared across every document in the browser, never saved or loaded with
 * a file). `color.space === "spot"` for an actual spot/Pantone-style
 * colour (its real definition sits in the asset store, per `Color`'s own
 * `profile` field in `packages/kernel/src/color.ts`); any other space is
 * a plain named process colour a designer wants to reuse across shapes
 * without redefining it — both are "a colour saved with this document",
 * the same concept a palette entry is in Illustrator/Inkscape regardless
 * of which one backs a given swatch.
 */
export interface PaletteColor {
  readonly id: string;
  name: string;
  color: Color;
}

export interface VectorDocumentState {
  readonly kind: "vector";
  readonly schemaVersion: 10;
  width: number;
  height: number;
  artboards: Artboard[];
  /**
   * Stage 15 of docs/vector-plan.md: which artboard "fit in window",
   * artboard-scoped rulers/guides and per-artboard export act on — `null`
   * when there are none, or none is current (deleting the active one, for
   * instance). Not a form of ownership: a shape's relationship to an
   * artboard is still purely spatial (`artboardsIntersecting`,
   * `artboard-ops.ts`), never a stored reference on the shape itself.
   */
  activeArtboardId: string | null;
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
  /** The document's own saved colour swatches — see `PaletteColor`'s own
   * doc comment for what this is and isn't. */
  palette: PaletteColor[];
  /** Stage 15/stage 5's own honest gap, closed together: draggable guide
   * lines, the vector side of what raster's `RasterGuide` already has. See
   * `VectorGuide`'s own doc comment for `scope`. */
  guides: VectorGuide[];
  /** Where the ruler shows "0" — `null` means the document's own (0, 0),
   * same as before this existed. Set by dragging from the ruler corner
   * (Illustrator's own gesture for repositioning the zero point), read
   * only in `"global"` ruler mode; `"artboard"` mode ignores this and
   * shows 0 at the active artboard's own corner instead, so the two
   * settings never fight over the same ruler. */
  rulerOrigin: { x: number; y: number } | null;
  /** `"global"`: ruler values are document-space (offset by `rulerOrigin`
   * if set). `"artboard"`: ruler values are relative to the active
   * artboard's own top-left corner, the way Illustrator's own per-artboard
   * ruler mode works — falls back to `"global"` behaviour when there is no
   * active artboard to be relative to. */
  rulerMode: "global" | "artboard";
  /** Stage 14's on-screen colour proof: which imported ICC CMYK profile
   * (an asset id, same "reference, not a copy" convention `pixelAssetId`
   * above already uses) `softproof` below simulates through — `null`
   * means none chosen, and `softproof` has nothing to show even if `true`.
   * `packages/env-vector/src/softproof.ts`'s own doc comment explains why
   * the actual sRGB↔CMYK roundtrip isn't computed in this package. */
  cmykProfileAssetId: string | null;
  /** Whether the canvas should currently show `cmykProfileAssetId`'s own
   * roundtrip instead of each shape's true sRGB colour — a view setting,
   * not a document edit in the usual sense (nothing about the artwork
   * itself changes), but it lives on the document rather than shell UI
   * state because "what this specific file proofs against" is exactly the
   * kind of thing that should travel with the file, the same reasoning
   * `activeArtboardId` already established for "which page is showing".
   */
  softproof: boolean;
}

/**
 * A draggable guide line — dragged out of a ruler, same gesture as
 * `RasterGuide`. `scope: null` is a *global* guide, shown and usable
 * regardless of which artboard (if any) is active; `scope: <artboardId>`
 * is visible only while that specific artboard is the active one, the
 * `Guide { scope }` this stage's own plan entry asked for. An artboard
 * being deleted does not delete its scoped guides — they simply become
 * unreachable the same way a shape under a deleted artboard stays exactly
 * where it was (an artboard owns nothing, `deleteArtboard`'s own doc
 * comment) — orphaned rather than destroyed, consistent with everything
 * else this stage already treats an artboard as pure metadata for.
 */
export interface VectorGuide {
  readonly orientation: "horizontal" | "vertical";
  readonly position: number;
  readonly scope: string | null;
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
 * - v5 → v6 (stage 15): `activeArtboardId` defaults to `null` — every v5
 *   document already behaved as if it had none (there was no canvas for a
 *   second artboard to be reachable on at all), so `null` reproduces that
 *   exactly rather than guessing at `artboards[0]?.id`.
 * - v6 → v7 (section 8's stage 6 addition): `palette` defaults to `[]` —
 *   every v6 document already behaved as if it had no saved swatches
 *   (there was no field for one to live in), so an empty list reproduces
 *   that exactly rather than inventing entries from nothing.
 * - v7 → v8 (stage 15's bleed): every artboard gets `bleed: 0` — a v7
 *   artboard already behaved as if it had none (nothing read the field,
 *   nothing drew a margin), so `0` reproduces that exactly.
 * - v8 → v9 (stage 15's rulers/guides): `guides` defaults to `[]`,
 *   `rulerOrigin` to `null`, `rulerMode` to `"global"` — a v8 document
 *   already behaved exactly like an empty-guides, zero-origin, global-mode
 *   one (there was no ruler for vector documents at all), so these
 *   reproduce that rather than inventing a saved ruler state from nothing.
 * - v9 → v10 (stage 14's softproof): `cmykProfileAssetId` defaults to
 *   `null`, `softproof` to `false` — a v9 document already behaved as if
 *   it had no profile assigned and proofing off (there was no on-screen
 *   proof at all), so these reproduce that exactly.
 */
export function migrateVectorDocumentState(state: VectorDocumentState): VectorDocumentState {
  const candidate = state as unknown as {
    artboards?: unknown;
    activeArtboardId?: string | null;
    resolution?: number;
    displayUnit?: LengthUnit;
    palette?: PaletteColor[];
    guides?: VectorGuide[];
    rulerOrigin?: { x: number; y: number } | null;
    rulerMode?: "global" | "artboard";
    cmykProfileAssetId?: string | null;
    softproof?: boolean;
    shapes: Array<Record<string, unknown>>;
  };
  if (typeof candidate.artboards === "boolean" || candidate.artboards === undefined) candidate.artboards = [];
  for (const artboard of candidate.artboards as Array<{ bleed?: number }>) artboard.bleed ??= 0;
  candidate.activeArtboardId ??= null;
  candidate.resolution ??= 72;
  candidate.displayUnit ??= "px";
  candidate.palette ??= [];
  candidate.cmykProfileAssetId ??= null;
  candidate.softproof ??= false;
  candidate.guides ??= [];
  candidate.rulerOrigin ??= null;
  candidate.rulerMode ??= "global";

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

  (state as { schemaVersion: number }).schemaVersion = 10;
  return state;
}

/**
 * Stage 13's symbol library lives inside `state.shapes` itself, as ordinary
 * `group` shapes parented here instead of to the document root or a real
 * group — see the `instance` shape kind's own doc comment above for why.
 * Not a real shape id (no shape is ever created with this as its own `id`),
 * so it can never collide with one; every existing reader that walks
 * `parentId` chains (`siblingsOf`, `flattenVectorShapes`,
 * `vectorShapeRows`, ...) already treats an unresolvable parent id as "not
 * found" and simply stops there, which is exactly what keeps a symbol
 * definition's own content out of normal paint order, the layers panel, and
 * top-level hit-testing without any of those functions needing to know this
 * constant exists.
 */
export const SYMBOLS_ROOT_ID = "@@symbols@@";

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
  if (![2, 3, 4, 5, 6, 7, 8, 9, 10].includes(state.schemaVersion as number)) return false;
  migrateVectorDocumentState(value as VectorDocumentState);
  return true;
}
