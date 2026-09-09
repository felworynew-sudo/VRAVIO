import type { ReactNode } from "react";
import type { ShapeSpatialIndex, SnapSource } from "@vravio/env-vector";
import type { VectorDocumentState, VectorShape } from "@vravio/env-vector";
import type { DocumentViewport } from "../../../store";
import type { VectorSnapshot } from "../../../vector-commands";
import type { NavigationHooks } from "../../navigation-types";

export type { NavigationContext, NavigationGesture, NavigationHooks } from "../../navigation-types";

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
  /**
   * The workspace element's own pixel size and the document-space rectangle
   * its scaled stage currently represents (`computeCanvasBounds`) — together
   * everything `toScreenPoint` (`vector-coordinates.ts`) needs to convert a
   * document-space point into screen pixels local to the workspace's own
   * top-left. Added for `ScreenOverlay` below (docs/master-plan.md section
   * 4.8's unscaled-overlay refactor): a tool that draws its own chrome in
   * the unscaled layer needs both to place anything there at all, the same
   * two values `VectorWorkspace.tsx` itself already threads through
   * `toScreenPoint` for the selection handles.
   */
  readonly workspaceSize: { readonly width: number; readonly height: number };
  readonly stageBounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  /** This tool's own options, as the options bar has them. */
  readonly options: Readonly<Record<string, string | number | boolean>>;
  readonly activeShape: VectorShape | null;
  readonly selection: readonly string[];
  /** The foreground swatch — every shape tool paints new shapes in this, exactly
   * as raster's `paintColor` does; a "color" option on a vector tool is the same
   * kind of mirror of it that raster.fill's turned out to be, not a separate
   * channel a tool reads on its own. */
  readonly foregroundColor: string;

  /** Rebuilt once per document revision (see `VectorWorkspace.tsx`), not once
   * per gesture — a tool that needs "what shape is at this point" uses this
   * instead of calling the linear-scan `shapeAt` directly, the same fast
   * path the canvas's own context-menu hit-test already goes through. */
  readonly spatialIndex: ShapeSpatialIndex;
  /**
   * What a drag should snap to right now, assembled from live Settings
   * preferences (Guides & Grid) — a tool stays decoupled from the store
   * itself (no vector tool file imports `useShellStore`, and this keeps that
   * true) by receiving the *already-resolved* answer instead. `sources` is
   * `smartGuides`-filtered (empty when that preference is off) and
   * `gridSpacing` is `null` unless `snapToGrid` is on — a tool that ignores
   * both preferences entirely by construction, not by remembering to check
   * a flag itself, which is exactly how docs/vector-plan.md's stage 5 avoids
   * the "declared option nothing reads" bug `smartGuides`/`snapToGuides`
   * turned out to already be before this stage wired them to anything.
   */
  readonly snapping: { readonly sources: readonly SnapSource[]; readonly gridSpacing: number | null; readonly radius: number };

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

  /**
   * Present only on `vector.hand`/`vector.zoom` — the tools that move the
   * view rather than edit the document. A tool has these hooks or the
   * pointer hooks below, never both: same split raster's own contract
   * makes (`environments/raster/tools/types.ts`), for the same reason —
   * navigation claims the gesture in a capture-phase handler on the
   * *workspace* element, before `VectorWorkspace.tsx`'s own `<svg>` ever
   * sees it, so pointer hooks on a navigation tool would simply never run.
   */
  readonly navigation?: NavigationHooks;


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
   * A CSS `cursor` value for the current hover position, or `undefined` to
   * fall back to the tool's static default (`.vector-stage svg{cursor:...}`
   * in `styles.css`). Added for `vector.pen` — docs/vector-plan.md section 9,
   * second priority ("Состояния курсора... чтобы результат клика был
   * предсказуем до самого клика"): whether a click will place a corner
   * point, delete an existing one, close the path, resume an open one, or
   * add a node on a segment, are five genuinely different outcomes at the
   * same tool, and Pen picking the wrong one silently (no visual hint
   * beforehand) is exactly what this exists to prevent. Optional and on the
   * shared tool contract, not a `vector.pen`-specific host hook, since any
   * future tool with the same "several different outcomes for the same
   * click" shape can reuse it.
   */
  cursorFor?(context: ToolContext<TState>, pointer: ToolPointer): string | undefined;

  /**
   * Anything the tool draws over the canvas, inside the same `<svg>` the
   * shapes render into — document-space coordinates, sharing that `<svg>`'s
   * own pan/zoom/rotate CSS transform. Sizes that must not visually scale
   * with zoom still need `/ context.viewport.zoom` here (the same
   * convention this file has always used); a size that must never be
   * divided by anything, ever — because a competing CSS rule or a future
   * edit could silently defeat that division, the exact regression
   * `docs/master-plan.md` section 4.8 documents happening twice already —
   * belongs in `ScreenOverlay` below instead.
   */
  readonly Overlay?: (props: { state: TState; document: VectorDocumentState; options: Readonly<Record<string, string | number | boolean>>; context: ToolContext<TState> }) => ReactNode;

  /**
   * Screen-space chrome: rendered *outside* the scaled `<svg>`, in the same
   * unscaled layer `VectorWorkspace.tsx`'s own selection handles live in
   * (`docs/master-plan.md` section 4.8) — a plain `<circle r={5}>` here is
   * really always 5 screen pixels, not "5 document units that happen to be
   * divided by zoom today." Use `context.workspaceSize`/`context.stageBounds`
   * with `toScreenPoint` (`vector-coordinates.ts`) to convert a document
   * point into this layer's own coordinate space. Added for `vector.nodes`'
   * anchor/handle overlay — the one other place besides the selection
   * handles this project's own bug history (commit `93fdc6e`, then the CSS
   * regression `5ba9856` fixed) has already shown needs this, not the
   * scaled `Overlay` above.
   */
  readonly ScreenOverlay?: (props: { state: TState; document: VectorDocumentState; options: Readonly<Record<string, string | number | boolean>>; context: ToolContext<TState> }) => ReactNode;
}

export interface VectorToolModule<TState = unknown> {
  readonly default: VectorToolDefinition<TState>;
}
