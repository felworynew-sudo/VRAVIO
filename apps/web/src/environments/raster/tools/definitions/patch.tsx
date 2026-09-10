import { appendLassoPoint, applyPreparedPatchRegion, combineSelections, copyHealedRegion, createPolygonSelection, patchFromSelection, preparePatchFromSelection, selectionOutlinePath, type Point } from "@vravio/env-raster";
import { MarchingAnts } from "../../../../marching-ants";
import type { RasterToolDefinition, ToolContext } from "../types";
import { locksRefuse } from "../lock-guard";
import { healMembranePool } from "../../../../heal-membrane-pool";
import { diagnostic } from "../../../../diagnostics";

/**
 * The patch tool: drag a selected region elsewhere on the canvas and it is
 * blended in with a Poisson solve, the same membrane `spotHeal` and the
 * restoring brush both use.
 *
 * Photoshop's Patch draws its own selection when there is none yet, then
 * patches when you drag inside one — the old switch fell back to lasso's
 * own drag machinery for that first half (`selectionGesture`, kept alive
 * in `RasterWorkspace.tsx` for this one caller after `marquee`/`lasso`
 * moved into the catalogue). A tool has no way to reach another tool's host
 * refs, so this is its own small lasso tracker rather than a shared one —
 * deliberately not the full `marquee-selection.tsx` machinery (no Space-drag
 * reposition, no drag-inside-to-move): the owner's own request was only for
 * Shift/Alt to combine with an existing selection the way Lasso's own does,
 * not for the rest of that tool's own gesture vocabulary.
 */

interface FallbackLasso {
  readonly pointerId: number;
  readonly points: readonly Point[];
}

interface Stroke {
  readonly pointerId: number;
  readonly before: Uint8ClampedArray;
  working: Uint8ClampedArray;
  curveStart: Point;
  pending: Point;
  /**
   * The merged document, sampled once at pointer-down when "Sample all
   * layers" is on — not re-sampled per frame. Nothing else is painting
   * while a patch drag is in progress, so what the other layers contribute
   * cannot change mid-drag; recomputing `compositePixels()` (`ToolContext`'s
   * own doc: "Expensive; called only when asked for") on every pointer move
   * would pay a whole-document composite per frame for content that never
   * moves, the one thing a tool whose whole point is a live drag preview
   * cannot afford.
   */
  readonly compositeSnapshot: Uint8ClampedArray | null;
  /** The live preview's own in-flight Worker solve, if one is running — aborted (and replaced)
   *  the moment a newer frame supersedes it, and aborted outright the moment the gesture ends, so
   *  a stale solve can never resolve after the fact and paint over what just committed. See
   *  `applyPatchPreviewAsync`'s own comment. */
  previewAbort: AbortController | null;
}

export interface PatchState {
  readonly fallbackLasso: FallbackLasso | null;
  readonly stroke: Stroke | null;
}

const empty: PatchState = { fallbackLasso: null, stroke: null };

/**
 * How much of the multigrid solve's own sweep budget a live drag frame gets —
 * `solveHealMembrane`'s own `sweepScale` (heal_membrane.ts). The membrane
 * still converges close to the same result well under full sweeps; a live
 * preview only has to look right while the pointer is moving, not match the
 * committed pixels bit for bit. `final` (onGestureEnd, onDeactivate) always
 * solves at 1 — what actually lands in the document is never the cut-rate
 * version.
 */
const PREVIEW_SWEEP_SCALE = 0.3;

function applyPatch(context: ToolContext<PatchState>, stroke: Stroke, to: Point, final: boolean): void {
  const selection = context.selection;
  if (!selection) return;
  const offsetX = to.x - stroke.curveStart.x, offsetY = to.y - stroke.curveStart.y;
  const options = context.options;
  const { width, height } = context.document;
  const opacity = Number(options.opacity ?? 100) / 100;
  const mode = (options.mode as "source" | "destination") ?? "source";
  const feather = Number(options.feather ?? 0);
  const sweepScale = final ? 1 : PREVIEW_SWEEP_SCALE;
  // Each frame patches the original, not the previous frame's result. Left
  // to accumulate, dragging a patch a hundred pixels applied it a hundred
  // times and the area turned to mush.
  if (stroke.compositeSnapshot) {
    // Solved on a fresh copy of the merged picture — patchFromSelection writes
    // into its first argument — then only the cells the patch actually wrote
    // cross back into the layer, same door spot healing's own "sample all
    // layers" already uses (copyHealedRegion): the repair belongs to this
    // layer, the rest of the composite does not.
    //
    // Where the patch wrote is the selection's own footprint in source mode,
    // but the *drop point* in destination mode — patch.ts's own createPatchRegion
    // shifts the whole write rectangle there — so the copy-back mask has to
    // follow that shift too, or "sample all layers" would silently no-op every
    // Destination drag by copying back the one spot that was never touched.
    const bx = Math.floor(selection.bounds.x), by = Math.floor(selection.bounds.y);
    const bw = Math.max(0, Math.ceil(selection.bounds.width)), bh = Math.max(0, Math.ceil(selection.bounds.height));
    const localMask = new Uint8ClampedArray(bw * bh);
    for (let ly = 0; ly < bh; ly += 1) for (let lx = 0; lx < bw; lx += 1) {
      const cx = bx + lx, cy = by + ly;
      if (cx < 0 || cx >= width || cy < 0 || cy >= height) continue;
      localMask[ly * bw + lx] = selection.mask[cy * width + cx]!;
    }
    const copyOriginX = mode === "destination" ? bx + Math.round(offsetX) : bx;
    const copyOriginY = mode === "destination" ? by + Math.round(offsetY) : by;

    const healed = stroke.compositeSnapshot.slice();
    patchFromSelection(healed, width, height, context.paintMask ?? null, selection.bounds, offsetX, offsetY, opacity, mode, feather, sweepScale);
    stroke.working.set(stroke.before);
    copyHealedRegion(stroke.working, healed, localMask, copyOriginX, copyOriginY, bw, bh, width, height);
  } else {
    stroke.working.set(stroke.before);
    patchFromSelection(stroke.working, width, height, context.paintMask ?? null, selection.bounds, offsetX, offsetY, opacity, mode, feather, sweepScale);
  }
  stroke.pending = to;
}

/**
 * `applyPatch`'s own live-preview half, moved off the main thread — the multigrid solve is real
 * work regardless of `PREVIEW_SWEEP_SCALE` (`patch.bench.test.ts`'s own ~66ms even at the cut
 * rate), and `docs/migration-plan.md` §6.2 named exactly this gap: nothing in the app routed
 * expensive computation to a Worker yet, `@vravio/kernel`'s own `WorkerPool` built and tested but
 * never actually wired to anything. This is the first wiring — `preparePatchFromSelection` /
 * `applyPreparedPatchRegion` (patch.ts) are the same gather/write halves `applyPatch` already used
 * through the all-in-one `patchFromSelection`, split so the expensive middle (the solve) can await
 * a Worker instead of blocking here.
 *
 * Superseding matters more here than in the synchronous version: a stale solve does not just
 * waste a solved-then-discarded frame the way an unthrottled synchronous call did, it can resolve
 * *after* a newer one and paint an old drag position — an actual visible regression, not just
 * slowness, if not guarded. `stroke.previewAbort` is the guard: aborted before starting a new
 * solve, and aborted again the moment the gesture ends (`onGestureEnd`/`onDeactivate`, before
 * their own synchronous full-quality `applyPatch` call), so a stale resolution after the fact is
 * silently ignored rather than flashing over whatever just committed.
 */
async function applyPatchPreviewAsync(context: ToolContext<PatchState>, stroke: Stroke): Promise<void> {
  const selection = context.selection;
  if (!selection) return;
  stroke.previewAbort?.abort();
  const controller = new AbortController();
  stroke.previewAbort = controller;

  const to = stroke.pending;
  const offsetX = to.x - stroke.curveStart.x, offsetY = to.y - stroke.curveStart.y;
  const options = context.options;
  const { width, height } = context.document;
  const opacity = Number(options.opacity ?? 100) / 100;
  const mode = (options.mode as "source" | "destination") ?? "source";
  const feather = Number(options.feather ?? 0);

  const solve = async (pixels: Uint8ClampedArray): Promise<boolean> => {
    const prepared = preparePatchFromSelection(pixels, width, height, context.paintMask ?? null, selection.bounds, offsetX, offsetY, opacity, mode, feather);
    if (!prepared) return false;
    let solved: { offsetsRgb: Int16Array };
    try {
      solved = await healMembranePool().run(
        { interior: prepared.interior, width: prepared.regionWidth, height: prepared.regionHeight, offsetsRgb: prepared.offsets, sweepScale: PREVIEW_SWEEP_SCALE },
        { signal: controller.signal },
      );
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return false;
      throw error;
    }
    if (controller.signal.aborted) return false;
    applyPreparedPatchRegion(pixels, width, height, { ...prepared, offsets: solved.offsetsRgb });
    return true;
  };

  if (stroke.compositeSnapshot) {
    const bx = Math.floor(selection.bounds.x), by = Math.floor(selection.bounds.y);
    const bw = Math.max(0, Math.ceil(selection.bounds.width)), bh = Math.max(0, Math.ceil(selection.bounds.height));
    const localMask = new Uint8ClampedArray(bw * bh);
    for (let ly = 0; ly < bh; ly += 1) for (let lx = 0; lx < bw; lx += 1) {
      const cx = bx + lx, cy = by + ly;
      if (cx < 0 || cx >= width || cy < 0 || cy >= height) continue;
      localMask[ly * bw + lx] = selection.mask[cy * width + cx]!;
    }
    const copyOriginX = mode === "destination" ? bx + Math.round(offsetX) : bx;
    const copyOriginY = mode === "destination" ? by + Math.round(offsetY) : by;

    const healed = stroke.compositeSnapshot.slice();
    if (!await solve(healed)) return;
    stroke.working.set(stroke.before);
    copyHealedRegion(stroke.working, healed, localMask, copyOriginX, copyOriginY, bw, bh, width, height);
  } else {
    stroke.working.set(stroke.before);
    if (!await solve(stroke.working)) return;
  }
  // `stroke.pending` is not touched here — `onPointerMove` already set it, synchronously, to
  // whichever point was actually latest by the time this scheduled work ran (see its own
  // comment); reassigning it to `to` (this specific call's own, possibly since-superseded,
  // capture) after an `await` could stomp a newer value a later pointer sample already wrote.
  context.schedulePreview(stroke.working, "pixels", context.paintTarget.layerId, null);
}

const patch: RasterToolDefinition<PatchState> = {
  id: "raster.patch",
  requiresRasterized: true,
  createState: () => empty,

  onPointerDown(context, pointer) {
    if (context.paintTarget.kind === "mask") return;
    if (locksRefuse(context, "paint", "raster.patch")) return;
    context.capturePointer(pointer.pointerId);
    // No selection yet, or Shift/Alt held — draw a new lasso instead of starting a patch drag,
    // the same rule `marquee-selection.tsx`'s own lasso already follows for a click that lands
    // inside its current selection (Shift/Alt held always means "a fresh shape to combine", never
    // "move what's already there"). Without this, Patch could only ever draw a first selection
    // with nothing existing yet — there was no way to add more, the way Lasso already lets you.
    if (!context.selection || pointer.shiftKey || pointer.altKey) {
      context.setState({ fallbackLasso: { pointerId: pointer.pointerId, points: [pointer.point] }, stroke: null });
      return;
    }
    const before = context.layerPixels();
    // Sampled once, here, not per frame — see the field's own doc comment.
    const compositeSnapshot = context.options.sampleAllLayers === true ? context.compositePixels() : null;
    context.setState({ fallbackLasso: null, stroke: { pointerId: pointer.pointerId, before, working: before.slice(), curveStart: pointer.point, pending: pointer.point, compositeSnapshot, previewAbort: null } });
  },

  onPointerMove(context, pointer) {
    const state = context.state;
    if (state.fallbackLasso && state.fallbackLasso.pointerId === pointer.pointerId) {
      context.setState({ ...state, fallbackLasso: { ...state.fallbackLasso, points: appendLassoPoint(state.fallbackLasso.points, pointer.point) } });
      return;
    }
    const stroke = state.stroke;
    if (!stroke || stroke.pointerId !== pointer.pointerId) return;
    // Only the target point is recorded synchronously here — `applyPatch` itself runs a real
    // (if scaled-down) multigrid solve, and `RasterWorkspace.tsx`'s own pointer-move handler
    // calls every catalogue tool once per *coalesced* native event, not once per animation
    // frame: a fast drag can coalesce a dozen samples between paints, and running a full solve
    // for each of them — the previous version did — blocks the main thread for that many solves
    // in a row before the browser can even show a frame. That is the reported "hangs, keeps
    // overwriting": not a correctness bug (each solve was still a real one, from `stroke.before`,
    // same as always), just so much backed-up synchronous work that several stale results paint
    // in a burst once it finally catches up, reading as flicker. `scheduleWork` (this project's
    // own "coalesce to the next frame, run only the latest" queue, already used by tools with a
    // per-frame side effect) collapses that whole backlog to exactly one solve per real frame,
    // always against whichever point turns out to be latest by the time it actually runs.
    stroke.pending = pointer.point;
    // The solve itself is scheduled through `applyPatchPreviewAsync`, off the main thread — see
    // its own comment. `scheduleWork` still coalesces *when* that async kick-off happens to once
    // per frame; superseding an already-running solve is `applyPatchPreviewAsync`'s own job
    // (`stroke.previewAbort`), since a frame boundary and "the previous Worker call finished" are
    // two different clocks now that the solve itself is async.
    context.scheduleWork(() => {
      // Never left as an unhandled rejection: a genuine failure here (the Worker script fails to
      // load, `Worker` itself is unavailable — the Node/jsdom test harness this same code path
      // runs under in `contract.test.ts`, for one) should not crash the drag, only skip that
      // frame's own preview and say so once, the same way `diagnostic` already surfaces every
      // other non-fatal tool-level problem in this codebase.
      applyPatchPreviewAsync(context, stroke).catch((error: unknown) => {
        diagnostic("warn", "patch", "Live preview solve failed", { error: error instanceof Error ? error.message : String(error) });
      });
    });
  },

  onGestureEnd(context, pointer) {
    const state = context.state;
    if (state.fallbackLasso && state.fallbackLasso.pointerId === pointer.pointerId) {
      context.setState(empty);
      // Same reasoning as `marquee-selection.tsx`'s own `appendLassoPoint`
      // call at gesture end: the spacing floor can leave the exact release
      // point unrecorded, so it is forced in here too.
      const points = appendLassoPoint(state.fallbackLasso.points, pointer.point, 0);
      const first = points[0]!;
      // A click that never became a drag draws nothing, as it does for
      // lasso itself — a one-pixel selection is never what anyone wanted.
      const travelled = Math.max(...points.map((item) => Math.hypot(item.x - first.x, item.y - first.y)), 0);
      if (travelled < 2) return;
      const feather = Number(context.options.feather ?? 0);
      const incoming = createPolygonSelection(context.document.width, context.document.height, points, feather);
      // Shift/Alt read the same way `marquee-selection.tsx`'s own lasso does — this fallback
      // draws the identical shape (a freehand polygon), so it should combine with an existing
      // selection the identical way, not the one fixed "replace" it used to be stuck on.
      const mode = pointer.shiftKey && pointer.altKey ? "intersect" : pointer.shiftKey ? "add" : pointer.altKey ? "subtract" : "replace";
      const combined = combineSelections(context.selection, incoming, context.document.width, context.document.height, mode);
      void context.commitSelection(context.selection, combined, "Patch Selection (Выделение заплаткой)");
      return;
    }
    const stroke = state.stroke;
    if (!stroke || stroke.pointerId !== pointer.pointerId) return;
    context.setState(empty);
    // Cancels whatever live-preview solve might still be in flight in the Worker before this
    // tool's own synchronous, full-quality solve runs — otherwise that stale preview could
    // resolve after the commit below and repaint over it (`applyPatchPreviewAsync`'s own comment
    // has the full reasoning).
    stroke.previewAbort?.abort();
    applyPatch(context, stroke, pointer.point, true);
    // The changed region is the selection itself, translated by the drag —
    // not a brush-stroke bounding box, which is what this tool has no use
    // for in the first place.
    const selection = context.selection;
    const pad = Number(context.options.feather ?? 0) + 2;
    const bounds = selection ? {
      x: selection.bounds.x + (stroke.pending.x - stroke.curveStart.x) - pad,
      y: selection.bounds.y + (stroke.pending.y - stroke.curveStart.y) - pad,
      width: selection.bounds.width + pad * 2,
      height: selection.bounds.height + pad * 2,
    } : null;
    void context.commit(stroke.before, stroke.working, "Patch (Заплатка)", "pixels", context.paintTarget.layerId, bounds);
  },

  onDeactivate(context) {
    const state = context.state;
    const stroke = state.stroke;
    if (stroke) {
      // A mid-drag tool switch lands here instead of onGestureEnd — still has
      // to solve at full quality before it commits, not whatever the last
      // preview frame's cut-rate sweep count left behind.
      stroke.previewAbort?.abort();
      applyPatch(context, stroke, stroke.pending, true);
      void context.commit(stroke.before, stroke.working, "Patch (Заплатка)", "pixels", context.paintTarget.layerId, null);
    }
    // A fallback lasso is a selection gesture, not a paint one — discarded
    // on a mid-drag tool switch, the same as marquee/lasso's own
    // onDeactivate, not committed the way a stroke is.
    if (state.fallbackLasso || state.stroke) context.setState(empty);
  },

  Overlay({ state, document, context }) {
    if (state.fallbackLasso) {
      return <svg className="selection-overlay" viewBox={`0 0 ${document.width} ${document.height}`} preserveAspectRatio="none" aria-hidden="true">
        <MarchingAnts zoom={context.viewport.zoom}>
          <polyline points={state.fallbackLasso.points.map((point) => `${point.x},${point.y}`).join(" ")}/>
        </MarchingAnts>
      </svg>;
    }
    const stroke = state.stroke;
    const selection = context.selection;
    if (!stroke || !selection) return null;
    const offsetX = stroke.pending.x - stroke.curveStart.x, offsetY = stroke.pending.y - stroke.curveStart.y;
    if (offsetX === 0 && offsetY === 0) return null;
    const path = selectionOutlinePath(selection.mask, document.width, document.height);
    if (!path) return null;
    // Where the patch is reading from. The destination keeps its own
    // marching ants, so the pair shows both halves of the operation at
    // once — otherwise a drag looks like it is moving the selection.
    // Screen measurements, divided back out of the stage's zoom — the dash
    // lengths as much as the width, since a dash pattern in document units
    // stretches with the zoom exactly like the line it is drawn on.
    const zoom = context.viewport.zoom;
    return <svg className="patch-source-overlay" viewBox={`0 0 ${document.width} ${document.height}`} preserveAspectRatio="none" aria-hidden="true">
      <path className="patch-source-path" strokeWidth={1.5 / zoom} strokeDasharray={`${5 / zoom} ${4 / zoom}`} d={path} transform={`translate(${offsetX} ${offsetY})`}/>
    </svg>;
  },
};

export default patch;
