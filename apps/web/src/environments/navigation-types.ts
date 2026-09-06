import type { DocumentViewport } from "../store";

/**
 * The view-navigation contract — `hand`, `zoom` and (raster-only, so far)
 * `rotateView` — shared between `environments/raster/tools/types.ts` and
 * `environments/vector/tools/types.ts` rather than defined twice. It carries
 * nothing raster- or vector-specific (a `DocumentViewport` is the same shape
 * for both), so the two environments' tool catalogues genuinely need the same
 * contract, not two that happen to look alike today and are free to drift
 * apart tomorrow — see CLAUDE.md's own "дубликат — это два будущих, которые
 * разойдутся".
 */

/**
 * What a navigation gesture knows about itself.
 *
 * Client coordinates, not document ones. Panning, rotating and zooming the
 * view are the three things that are *about* the window rather than about the
 * picture: a pan of forty screen pixels is forty screen pixels whatever the
 * zoom, and converting to document space and back would only lose precision.
 * This is why navigation cannot simply reuse a tool's own pointer-event type.
 */
export interface NavigationGesture {
  readonly pointerId: number;
  /** Where the gesture began, in client coordinates. */
  readonly startX: number;
  readonly startY: number;
  /** Where the pointer is now. */
  readonly clientX: number;
  readonly clientY: number;
  readonly dx: number;
  readonly dy: number;
  /** True once the pointer has travelled far enough to count as a drag rather
   * than a click — what tells a zoom click from a scrubby-zoom drag. */
  readonly moved: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  /** The viewport as it stood when the gesture began. Every navigation tool
   * works from this rather than from the live viewport: applying a delta to a
   * value the previous frame already moved compounds it. */
  readonly initial: DocumentViewport;
}

export interface NavigationContext {
  readonly viewport: DocumentViewport;
  /** This tool's own options-bar values, the same snapshot a canvas tool's
   * own context carries — `zoom`'s `dragZoom` reads it. */
  readonly options: Readonly<Record<string, string | number | boolean>>;
  setViewport(patch: Partial<DocumentViewport>): void;
  /**
   * Changes the zoom while keeping whatever is under the given client point
   * still, which is what makes zooming feel anchored rather than jumping.
   *
   * Offered as a context method so a tool never touches the workspace
   * element: measuring it is the host's business, and a tool that could reach
   * the DOM would be a tool that could reach anything.
   */
  zoomAround(zoom: number, clientX: number, clientY: number, from?: DocumentViewport): void;
}

/**
 * A tool that moves the view instead of editing the document.
 *
 * `hand`, `zoom` and (raster only) `rotateView` never reach the canvas bridge
 * every other tool goes through: navigation is a capture-phase handler on the
 * *workspace* element, so it claims the gesture before the canvas underneath
 * sees it — deliberately, because dragging on the grey surround around the
 * canvas has to pan too, and the canvas's own handlers never fire there.
 *
 * The host still owns *temporary* navigation — space bar as a hand, the
 * middle mouse button, the wheel — because none of that is the active tool;
 * it overrides whatever is. It runs these same hooks, so "space is a
 * temporary hand tool" is literally the hand tool.
 */
export interface NavigationHooks {
  /**
   * Starts the gesture. Returns `"drag"` to keep it — `move` and `end` will
   * follow — or `"done"` when the tool has already done its work and there is
   * nothing to drag, which is what a plain zoom click is.
   */
  begin(context: NavigationContext, gesture: NavigationGesture): "drag" | "done";
  move?(context: NavigationContext, gesture: NavigationGesture): void;
  end?(context: NavigationContext, gesture: NavigationGesture): void;
}
