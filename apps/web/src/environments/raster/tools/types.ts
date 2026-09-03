import type { ReactNode } from "react";
import type { PixelSelection, Point, RasterDocumentState, RasterLayer } from "@vravio/env-raster";
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
   */
  commit(before: Uint8ClampedArray, after: Uint8ClampedArray, label: string, target?: PaintTarget["kind"], layerId?: string): Promise<void>;

  setForegroundColor(color: string): void;
}

export interface RasterToolDefinition<TState = unknown> {
  /** Matches the id in `tools.ts`, which still owns the descriptive fields. */
  readonly id: string;
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
   */
  readonly Overlay?: (props: { state: TState; document: RasterDocumentState }) => ReactNode;
}

export interface RasterToolModule<TState = unknown> {
  readonly default: RasterToolDefinition<TState>;
}
