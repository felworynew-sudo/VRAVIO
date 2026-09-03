import type { ReactNode } from "react";
import type { PixelSelection, Point, RasterDocumentState, RasterLayer, RasterRect } from "@vravio/env-raster";
import type { DocumentViewport } from "../../../store";

/**
 * What a raster tool is, as a file the registry can pick up.
 *
 * Stage 3 of docs/migration-plan.md. The set of hooks is not invented: it is
 * the set of functions that today hold the 49 `activeToolId === "…"` branches
 * inside RasterWorkspace.tsx, with the branch counts that justified each one
 * (see the plan's §4.1 table). A hook nothing branches on is not here.
 *
 * Two things this contract deliberately does *not* carry yet:
 *
 * - The descriptive half of a tool — label, icon, shortcut, options schema —
 *   still lives in `tools.ts`, because the toolbar and the options bar read it
 *   from there and both paths have to keep working while tools move over one
 *   at a time. Folding those fields in is stage 5's job, once there is nothing
 *   left in the old switch to disagree with.
 * - Anything a ported tool has not needed. `ToolContext` grows a member when a
 *   real tool asks for one, not in anticipation: a context designed ahead of
 *   its callers is a guess, and this one has to survive twenty-nine more
 *   tools.
 */

/** A pointer event, in the two coordinate spaces a tool actually works in. */
export interface ToolPointer {
  /** Where the pointer is in the document, after pan, zoom and rotation. */
  readonly point: Point;
  /**
   * Where the pointer is inside the workspace element.
   *
   * Overlays are interface, and interface is measured in screen pixels — the
   * rule CLAUDE.md records after the clone stamp's cursor was built in
   * document space and grew with the zoom.
   */
  readonly screenX: number;
  readonly screenY: number;
  readonly pointerId: number;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly button: number;
  readonly pressure: number;
}

/** Where a painting tool's pixels go: the layer itself, or the mask it is
 * editing. Resolved once by the host, since it depends on the shell's "which
 * layer's mask is being edited" state, not on anything the tool knows. */
export interface PaintTarget {
  readonly kind: "pixels" | "mask";
  readonly layerId: string;
}

export interface ToolContext<TState> {
  readonly documentId: string;
  readonly document: RasterDocumentState;
  readonly viewport: DocumentViewport;
  /** This tool's own options, as the options bar has them. */
  readonly options: Readonly<Record<string, string | number | boolean>>;
  readonly activeLayer: RasterLayer | null;
  readonly selection: PixelSelection | null;
  /**
   * Whether the space bar is down right now.
   *
   * Not a pointer modifier — it can change mid-gesture, independent of any
   * pointer event, which is exactly what lets holding Space slide a marquee
   * already being dragged instead of resizing it. Space is also the
   * navigation system's own temporary-pan key, handled by a separate
   * capture-phase listener on the workspace element that runs before a
   * gesture reaches a tool at all — this field is for a tool that wants to
   * react to Space *during* a gesture it already owns.
   */
  readonly spaceHeld: boolean;

  /** The tool's own state for the gesture in progress. */
  readonly state: TState;
  /** Replaces that state and re-renders, which is what redraws the overlay. */
  setState(next: TState): void;

  capturePointer(pointerId: number): void;

  /** The active layer's pixels, materialised to document size. */
  layerPixels(): Uint8ClampedArray;
  /** What the document composites to. Expensive; called only when asked for. */
  compositePixels(): Uint8ClampedArray;

  /**
   * Where painting goes right now, and the colour it goes in.
   *
   * `paintTarget` names the layer and whether it is the layer's own pixels or
   * a mask it is editing — the same distinction `commit`'s `target` picks up.
   * `paintColor` already accounts for that: editing a mask paints in black or
   * white, never the foreground swatch. `targetPixels()` reads whichever of
   * the two is live, as RGBA — a mask included, via the same encoding
   * `commit` expects back.
   */
  readonly paintTarget: PaintTarget;
  readonly paintColor: string;
  targetPixels(): Uint8ClampedArray;

  /**
   * Draws in-progress pixel work straight to the canvas, without going
   * through React.
   *
   * A dragged stroke can produce hundreds of pointer-move frames a second;
   * routing each one through `setState` would re-render the whole tree per
   * frame, undoing the exact optimisation this project already paid for
   * (RASTER-PAINT-002 — compositing dropped from 428ms to 14ms by working
   * outside React's render cycle, see CLAUDE.md's rule on abstraction by
   * layer). Calls coalesce to one paint per animation frame, and — the same
   * trade the existing render path already makes — a call with `dirty`
   * repaints only that region while one without repaints the frame in full;
   * pass `dirty` on every dab a stroke tool already tracks the bounds of.
   * Nothing needs to call this again once a gesture ends — `commit`
   * repaints from the committed state itself.
   */
  schedulePreview(pixels: Uint8ClampedArray, target: PaintTarget["kind"], layerId: string, dirty?: RasterRect | null): void;

  /**
   * Recomposites the document straight to the canvas with one layer
   * suppressed, or (`null`) repaints the ordinary composite — outside React,
   * like `schedulePreview`, for the same reason.
   *
   * What editing an existing text layer needs: the live edit shows as an
   * HTML `<textarea>` overlay (see `text.tsx`'s `Overlay`), not as rendered
   * pixels, so the layer's own rasterised pixels have to stay out of the
   * way underneath it or the two would visibly double up. Nothing else
   * about the document changes while this is in effect — no history step,
   * no `commit` — it is purely what the canvas shows until the edit ends
   * one way or the other and either a real commit repaints it correctly or
   * `null` puts the ordinary composite back.
   */
  previewWithLayerHidden(layerId: string | null): void;

  /**
   * The single mask every painting tool is confined to, combining the
   * selection with "lock transparent pixels" into one.
   *
   * This is the enforcement CLAUDE.md's "one door, not one checkpoint" rule
   * calls for: a tool does not decide whether it may touch a pixel, it reads
   * how much this says it may and stops there — `floodFill`, `drawDab` and
   * every painting primitive in @vravio/env-raster take a mask exactly this
   * shape for that reason. `commit` enforces the selection independently at
   * the write end regardless, so a tool that ignored this mask would still
   * be confined, just without the softened edge feathering implies.
   */
  /** Undefined means nothing restricts painting — the fast unrestricted
   * path `paintMask()` itself takes, not a mask materialised to all-255. */
  readonly paintMask: Uint8ClampedArray | undefined;

  /**
   * The only way a tool puts pixels into the document.
   *
   * Routed to the workspace's existing `commitPixels`, so a tool gets the
   * selection rule, the history step and the asset revision without knowing
   * any of them exist. `target`/`layerId` default to `paintTarget`, which is
   * right for every painting tool ported so far; a tool commits to a
   * different layer only when it names one, the way Auto-Select's
   * click-to-pick-a-different-layer will need to.
   *
   * `bounds`, when given, is what actually changed — the same dirty-region
   * hint `commitPixels` always took, feeding the tile cache CLAUDE.md's §5
   * traces to a measured 428ms→38ms. A one-shot tool has no reason to pass
   * it (the whole layer *is* what changed); a dragged stroke does, or every
   * commit forces a full-canvas recomposite regardless of how small the
   * stroke actually was.
   */
  commit(before: Uint8ClampedArray, after: Uint8ClampedArray, label: string, target?: PaintTarget["kind"], layerId?: string, bounds?: RasterRect | null): Promise<void>;

  /**
   * The only way a tool changes what is selected.
   *
   * A thin wrapper over the workspace's `commitSelection`: clones both
   * sides, records one history step. Selections are cheap enough (one byte
   * per pixel, no asset revision) that this does not need `commit`'s
   * machinery — a document-sized pixel buffer and a selection mask are
   * different orders of cost, which is why this is its own member rather
   * than `commit` overloaded to take either.
   */
  commitSelection(before: PixelSelection | null, after: PixelSelection | null, label: string): Promise<void>;

  /**
   * The only way a tool changes the document's own shape — adding, removing
   * or replacing a layer wholesale, rather than the pixels inside one.
   *
   * Shape and text both create a brand-new layer (`appendLayer`) rather than
   * writing into the active one, which `commit` has no way to express: it
   * only ever replaces one layer's existing pixel buffer. This is the same
   * whole-document history step `commitDocumentState` already gave
   * rasterize-layer and every other structural edit in the old switch, not a
   * new mechanism invented for these two — a tool takes it only when it is
   * genuinely restructuring the document, not painting into what is already
   * there.
   */
  commitDocument(before: RasterDocumentState, after: RasterDocumentState, label: string, bounds?: RasterRect | null): Promise<void>;

  /** Re-centres the viewport on the whole canvas at a fit-to-window zoom —
   * what a crop needs immediately after it changes the canvas's own size,
   * or the old pan/zoom would be framing a canvas that no longer exists
   * where it used to. */
  resetViewportToFit(): void;

  /**
   * Makes `layerId` the active layer, without a history step — the same
   * "clicking a layer selects it" that has never itself been undoable.
   * `commit`/`commitDocument` set `activeLayerId` too, but only as a side
   * effect of an edit that already needed a step of its own; this is for a
   * tool whose gesture selects a *different* layer without editing one, the
   * way clicking an existing text layer with the type tool does before any
   * typing has happened yet to commit.
   */
  setActiveLayer(layerId: string): void;

  /** The foreground swatch, unconditionally — unlike `paintColor`, never
   * swapped for black/white because some *other* layer's mask happens to be
   * in edit mode right now. Text always types in the real foreground
   * colour; masks are not a thing a text layer has. */
  readonly foregroundColor: string;

  setForegroundColor(color: string): void;

  /**
   * Sets which side of black/white the mask brush paints in — Alt-click's
   * other half: sampling a mask reads not a colour but which side of the
   * threshold the pixel already sits on, and setting *that* is what the
   * next stroke needs, not a hex value `setForegroundColor` has no use for
   * while a mask is being edited (`paintColor` already reads this, not the
   * foreground swatch, whenever a mask is the paint target).
   */
  setMaskForegroundWhite(white: boolean): void;

  /**
   * Where the last stroke ended, for Shift-click's "draw a straight line
   * from here" — Photoshop's behaviour for every brush-like tool, and one
   * that has to survive both across gestures (click, release, Shift-click
   * elsewhere) and across switching to a *different* brush-like tool and
   * back, which is why this lives at the host rather than in any one tool's
   * own `state`: state is reset by `onDeactivate` on every tool switch,
   * this deliberately is not. `layerId` is `mask:<id>` when the point was
   * laid down while editing that layer's mask, matching `paintTarget`'s own
   * `mask:`-free `layerId` plus `kind` split kept apart here only because
   * this needs a single comparable key, not a pair.
   */
  readonly lastStrokePoint: { readonly toolId: string; readonly layerId: string; readonly point: Point } | null;
  setLastStrokePoint(next: { toolId: string; layerId: string; point: Point } | null): void;

  /**
   * Where the clone stamp reads from, and the running offset between that
   * source and whatever point is being painted.
   *
   * Host-level for two reasons `lastStrokePoint` doesn't have to justify on
   * its own: the crosshair-and-swatch cursor that shows the source lives in
   * the workspace chrome, outside any tool's `Overlay`, and reads these
   * directly on every pointer move regardless of which tool is even active;
   * and "registered" alignment means the offset from one stroke carries into
   * the next, deliberately surviving past a single gesture the way a tool's
   * own `state` does not.
   */
  readonly cloneSource: Point | null;
  setCloneSource(point: Point | null): void;
  readonly cloneOffset: Point | null;
  setCloneOffset(offset: Point | null): void;

  /**
   * Tints the canvas wherever the spot-healing brush has marked so far, over
   * whatever `schedulePreview` most recently painted — straight to the
   * canvas, outside React, like `schedulePreview`/`previewWithLayerHidden`.
   *
   * Spot healing accumulates a *mask* of where to heal as the gesture drags
   * (the repair itself only runs once, on release, over the whole marked
   * area at once — healing each dab in isolation would seam at the
   * overlaps) — this is the only way to show the user what has been marked
   * before that repair happens, and it is a tint over the existing picture,
   * not a buffer `schedulePreview`'s pixels-for-a-layer shape can express.
   */
  previewSpotHealMask(mask: Uint8ClampedArray, originX: number, originY: number, width: number, height: number): void;
}

export interface RasterToolDefinition<TState = unknown> {
  /** Matches the id in `tools.ts`, which still owns the descriptive fields. */
  readonly id: string;
  /**
   * True for a tool that edits real pixels and cannot work against a layer
   * that has none yet — text and adjustment layers are described by data,
   * not a pixel buffer, and only carry a cached preview of one. Replaces
   * the old `RASTER_ONLY_TOOLS` set: the workspace checks this before
   * calling `onPointerDown` and offers to rasterize the layer instead of
   * calling the tool against a buffer that is about to be thrown away.
   */
  readonly requiresRasterized?: boolean;
  /** Fresh state for this tool, held by the workspace and passed back in. */
  createState(): TState;

  onPointerDown?(context: ToolContext<TState>, pointer: ToolPointer): void;
  onPointerMove?(context: ToolContext<TState>, pointer: ToolPointer): void;
  onGestureEnd?(context: ToolContext<TState>, pointer: ToolPointer): void;

  /**
   * Called when the tool stops being the active one.
   *
   * Required of any tool that keeps state, because state is held per tool id
   * and outlives the tool being switched away from: without this, changing
   * tool in the middle of a gesture strands whatever was in progress, and
   * coming back to the tool renders it again as though the pointer were
   * still down. The contract test enforces that a tool ends up back at
   * `createState()` after this runs.
   */
  onDeactivate?(context: ToolContext<TState>): void;

  /**
   * Anything the tool draws over the canvas.
   *
   * A component rather than an imperative handle, because what it draws is a
   * function of the tool's state and React already knows how to keep those
   * two in step. Sizes inside it are screen pixels.
   *
   * `options` is the same live options-bar snapshot `ToolContext.options`
   * carries — added for `raster.shape`, whose live drag preview has to
   * follow `shapeKind` (rectangle vs ellipse vs line draw differently) even
   * though which shape that is was never part of the drag's own state, only
   * of the panel next to the canvas.
   *
   * `context` is the same context object every hook above gets — added for
   * `raster.text`, whose overlay is not just a shape drawn over the canvas
   * but a live `<textarea>` that has to call `setState`/`commitDocument`
   * itself as the user types and commits, the same as any gesture handler
   * would. `state`/`document`/`options` stay as their own props rather than
   * folding into `context` alone: every Overlay before this one destructures
   * them directly, and `context.state`/`context.document`/`context.options`
   * would be the identical values under a different spelling.
   */
  readonly Overlay?: (props: { state: TState; document: RasterDocumentState; options: Readonly<Record<string, string | number | boolean>>; context: ToolContext<TState> }) => ReactNode;
}

export interface RasterToolModule<TState = unknown> {
  readonly default: RasterToolDefinition<TState>;
}
