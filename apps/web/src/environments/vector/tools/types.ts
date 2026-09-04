import type { ReactNode } from "react";
import type { VectorDocumentState, VectorShape } from "@vravio/env-vector";
import type { DocumentViewport } from "../../../store";
import type { VectorSnapshot } from "../../../vector-commands";

/**
 * What a vector tool is, as a file the registry can pick up — the vector
 * counterpart of `environments/raster/tools/types.ts`, same reasoning: the
 * hook set is read off `VectorWorkspace.tsx`'s own `onPointerDown`/
 * `onPointerMove`/`onPointerUp`, not invented ahead of a real tool asking
 * for it. There are far fewer branches to read off than raster ever had —
 * six tools sharing one `<svg>` gesture, not thirty sharing a canvas — so
 * unlike raster's stage 3/5 split, all six move over in one pass and the
 * old inline logic is deleted in the same change, not left running beside
 * a partial bridge.
 */

/** A pointer event, in the two coordinate spaces a tool actually works in — matches
 * `raster`'s `ToolPointer` except for `detail`, which `vector.pen` reads to tell a
 * plain click from the double-click that finishes a path (`event.detail >= 2`,
 * carried straight from the native `PointerEvent`, not something raster's tools
 * needed so far). */
export interface ToolPointer {
  readonly point: { x: number; y: number };
  readonly screenX: number;
  readonly screenY: number;
  readonly pointerId: number;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly button: number;
  readonly detail: number;
}

export interface ToolContext<TState> {
  readonly documentId: string;
  readonly document: VectorDocumentState;
  readonly viewport: DocumentViewport;
  /** This tool's own options, as the options bar has them. */
  readonly options: Readonly<Record<string, string | number | boolean>>;
  readonly activeShape: VectorShape | null;
  readonly selection: readonly string[];
  /** The foreground swatch — every shape tool paints new shapes in this, exactly
   * as raster's `paintColor` does; a "color" option on a vector tool is the same
   * kind of mirror of it that raster.fill's turned out to be, not a separate
   * channel a tool reads on its own. */
  readonly foregroundColor: string;

  /** The tool's own state for the gesture in progress. */
  readonly state: TState;
  /** Replaces that state and re-renders, which is what redraws the overlay. */
  setState(next: TState): void;

  /**
   * A live write during a gesture, with no history step yet — a shape drag or
   * resize calls this on every pointer move so the canvas stays responsive,
   * mirroring `kernel.documents.update` calls the pre-port workspace made
   * directly. Unlike raster's `schedulePreview`, this does not need RAF
   * coalescing of its own: an SVG re-render is cheap at the shape counts a
   * vector document runs at, which is exactly why the pre-port code never
   * bothered coalescing it either.
   */
  mutate(fn: (draft: VectorDocumentState) => void): void;

  /** A snapshot of shapes/activeShapeId/selection, for a drag's `before` — the
   * same shape `vector-commands.ts`'s `snapshotVector` already returns. */
  snapshot(): VectorSnapshot;

  /**
   * Records one history step for a gesture whose effect is already live on the
   * document via repeated `mutate` calls (a shape drag, a resize, the pen's
   * freehand point placement) — the vector counterpart of `commit`, thin
   * because a vector document is a small tree of shapes, not a pixel buffer:
   * there is no selection mask, no asset revision, no dirty-region hint to
   * thread through. `before` must be captured at the *start* of the gesture,
   * before any `mutate` call — the same ordering `commitVectorDrag`'s own
   * doc comment already requires.
   */
  commitDrag(before: VectorSnapshot, label: string): void;

  /**
   * One-shot mutate + diff + history step, for a tool with no live-drag phase
   * of its own — `vector.text`'s single click-to-place, or a shape's initial
   * placement before any resize drag has moved it. The vector counterpart of
   * raster's `commitDocument`, and for the same reason: adding a shape is a
   * structural change to the document's own shape list, not a live-then-commit
   * drag with a `before` captured up front.
   */
  changeDocument(label: string, mutate: (draft: VectorDocumentState) => boolean): Promise<void>;
}

export interface VectorToolDefinition<TState = unknown> {
  /** Matches the id in `tools.ts`, which still owns the descriptive fields —
   * same split raster's contract keeps between behaviour and description. */
  readonly id: string;
  /** Fresh state for this tool, held by the workspace and passed back in. */
  createState(): TState;

  onPointerDown?(context: ToolContext<TState>, pointer: ToolPointer): void;
  onPointerMove?(context: ToolContext<TState>, pointer: ToolPointer): void;
  /** Pointer-up *or* pointer-leave — `VectorWorkspace`'s pre-port canvas ends a
   * gesture on either (`onPointerUp={onPointerUp} onPointerLeave={onPointerUp}`),
   * since nothing here calls `setPointerCapture`: the SVG covers the whole
   * canvas, and a gesture that leaves it commits rather than hangs. */
  onGestureEnd?(context: ToolContext<TState>, pointer: ToolPointer): void;

  /**
   * Called when the tool stops being the active one — required of any tool
   * that keeps state, same contract raster's `onDeactivate` states and the
   * same reason: state is held per tool id and outlives a switch.
   */
  onDeactivate?(context: ToolContext<TState>): void;

  /**
   * Anything the tool draws over the canvas, inside the same `<svg>` the
   * shapes render into (not a separate overlay layer — a vector canvas has no
   * pixel/vector split to keep apart the way raster's canvas-plus-HTML-overlay
   * does). Sizes that must not scale with zoom divide by `context.viewport.zoom`,
   * the same convention `VectorWorkspace`'s own selection handles already use.
   */
  readonly Overlay?: (props: { state: TState; document: VectorDocumentState; options: Readonly<Record<string, string | number | boolean>>; context: ToolContext<TState> }) => ReactNode;
}

export interface VectorToolModule<TState = unknown> {
  readonly default: VectorToolDefinition<TState>;
}
