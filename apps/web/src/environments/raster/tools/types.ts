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
   * The only way a tool puts pixels into the document.
   *
   * Routed to the workspace's existing `commitPixels`, so a tool gets the
   * selection rule, the history step and the asset revision without knowing
   * any of them exist. Nothing ported so far writes pixels — the eyedropper
   * reads — so this member is wired but unexercised until stage 5 moves a
   * painting tool across, and it is the part of this contract with the least
   * evidence behind it.
   */
  commit(before: Uint8ClampedArray, after: Uint8ClampedArray, label: string): Promise<void>;

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
