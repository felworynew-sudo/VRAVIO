import { useEffect, useRef, type RefObject } from "react";
import {
  activeRasterLayer, changedRenderRegion, clampRegionToDocument, cloneRasterState, compositeRasterDocument, compositeRasterRegion,
  DirtyRegion, flattenRasterLayers, layerRenderSignatures, mipForZoom, RasterTileCache, setLayerPixels, RASTER_ASSET_MIME,
  type LayerRenderSignature, type PixelSelection, type RasterDocumentState, type RasterRect,
} from "@vravio/env-raster";
import { createBufferRevisionOperation, type AssetId, type VravioDocument } from "@vravio/kernel";
import { kernel } from "./kernel";
import { diagnostic } from "./diagnostics";
import { applyRasterRules } from "./environments/raster/rules/registry";
import { cropPixels, fromBytes, putPixels, putRegionPixels, rgbaToMask, stateDeltaBytes, toBytes, withActiveLayerPixels, withLayerMaskPixels } from "./raster-pixel-buffers";
import type { DocumentViewport } from "./store";

/**
 * The tile-cache render pipeline and every path that turns a gesture's
 * result into a history step — split out of `RasterWorkspace.tsx` purely to
 * bring its own line count down (docs/migration-plan.md §8), not because
 * any of this changed. This is the file CLAUDE.md §5 points at for the
 * project's central performance lesson (tiled compositing, 428ms → 38ms on
 * a 46-layer document): every comment on the tile-invalidation effect below
 * is preserved verbatim, not summarised, because the reasoning is the part
 * that matters if this ever needs touching again.
 */
export function useRasterCommit(params: {
  document: VravioDocument;
  state: RasterDocumentState;
  viewport: DocumentViewport;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  canvasPixels: (layer: ReturnType<typeof activeRasterLayer>) => Uint8ClampedArray;
}) {
  const { document, state, viewport, canvasRef, canvasPixels } = params;
  /** Serializes the storage half of pixel commits; see commitPixels. */
  const commitQueue = useRef<Promise<void>>(Promise.resolve());
  const tiles = useRef(new RasterTileCache({ tileSize: 256 }));
  const documentDirty = useRef(new DirtyRegion());
  /** What the visible canvas currently holds, so idle renders repaint nothing. */
  const painted = useRef<{ canvas: HTMLCanvasElement | null; revision: number; signatures?: readonly LayerRenderSignature[]; mip?: number }>({ canvas: null, revision: -1 });

  // Committed edits repaint through the tile cache: only tiles the edit actually touched are
  // recomposited, instead of rebuilding the whole document on every revision (spec §4.2).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // This effect runs on every render, and most renders have nothing to do with
    // the pixels: a history notification, a tool change, a selection. Treating
    // those as "an edit that did not say what it touched" threw away the whole
    // tile cache and recomposited the document — six hundred milliseconds on a
    // fifteen-layer document, several times per operation. The document's
    // revision is what says whether the pixels can have moved at all.
    const canvasChanged = painted.current.canvas !== canvas;
    // Zoomed out, the composite is sampled rather than made at full resolution:
    // at six percent a 1920x1080 canvas is 115 pixels across on screen, and
    // fifteen of every sixteen pixels composited for it are thrown away.
    const mip = mipForZoom(viewport.zoom);
    const revised = document.revision !== painted.current.revision || painted.current.mip !== mip;
    const signatures = layerRenderSignatures(state);
    const previousSignatures = painted.current.signatures;
    painted.current = { canvas, revision: document.revision, signatures, mip };

    // A canvas React has just mounted holds nothing, whatever the cache thinks.
    if (canvasChanged) tiles.current.invalidateAll();
    else if (revised) {
      const pending = documentDirty.current.isEmpty ? null : documentDirty.current.consume();
      if (pending !== null) for (const rect of pending) tiles.current.invalidate(rect);
      else {
        // The edit did not say what it touched — a filter, a layer operation, an
        // undo. Rather than assume the whole document, ask which layers render
        // differently now and repaint what they cover. Null still means "cannot
        // be bounded honestly", and then everything goes.
        const changed = previousSignatures ? changedRenderRegion(previousSignatures, signatures) : null;
        if (!changed) tiles.current.invalidateAll();
        else if (changed.width > 0 && changed.height > 0) tiles.current.invalidate(changed);
      }
    }
    const { repainted } = tiles.current.update(state, { x: 0, y: 0, width: state.width, height: state.height }, mip);
    for (const tile of repainted) putRegionPixels(canvas, tile.pixels, tile.rect, tile.step);
  }, [document.revision, state, viewport.zoom]);

  // Destructive adjustment dialogs render a transient composite here. The
  // document, layer pixels and history remain untouched until the dialog's OK
  // button commits one command; cancelling simply redraws the canonical state.
  useEffect(() => {
    const preview = (raw: Event) => {
      const event = raw as CustomEvent<{ documentId: string; pixels: Uint8ClampedArray | null }>;
      if (event.detail.documentId !== document.id) return;
      const canvas = canvasRef.current; if (!canvas) return;
      putPixels(canvas, event.detail.pixels ?? compositeRasterDocument(state), state.width, state.height);
    };
    window.addEventListener("vravio-raster-preview", preview);
    return () => window.removeEventListener("vravio-raster-preview", preview);
  }, [document.id, state, canvasRef]);

  const renderWorking = (pixels: Uint8ClampedArray, target: "pixels" | "mask" = "pixels", layerId = state.activeLayerId) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (target === "mask") { putPixels(canvas, compositeRasterDocument(withLayerMaskPixels(state, layerId, pixels)), state.width, state.height); return; }
    const layer = activeRasterLayer(state);
    const direct = state.layers.length === 1 && layer.visible && layer.opacity === 1 && layer.blendMode === "normal";
    putPixels(canvas, direct ? pixels : compositeRasterDocument(withActiveLayerPixels(state, pixels)), state.width, state.height);
  };

  /**
   * Repaints only the area the stroke has touched since the last frame. Compositing the whole
   * document every pointermove is what makes brushes stutter on large canvases (spec §4.2), and
   * a stroke only ever changes a few hundred pixels around the cursor.
   */
  const renderWorkingRegion = (pixels: Uint8ClampedArray, dirty: RasterRect) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const region = clampRegionToDocument(state, dirty);
    if (!region.width || !region.height) return;
    const layer = activeRasterLayer(state);
    const direct = state.layers.length === 1 && layer.visible && layer.opacity === 1 && layer.blendMode === "normal";
    putRegionPixels(canvas, direct ? cropPixels(pixels, state.width, region) : compositeRasterRegion(withActiveLayerPixels(state, pixels), region), region);
  };

  const renderSpotHealOverlay = (mask: Uint8ClampedArray, originX: number, originY: number, maskW: number, maskH: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    renderWorking(canvasPixels(activeRasterLayer(state)));
    const imageData = ctx.getImageData(0, 0, state.width, state.height);
    const px = imageData.data;
    for (let y = 0; y < maskH; y++) {
      for (let x = 0; x < maskW; x++) {
        const m = mask[y * maskW + x]!;
        if (m === 0) continue;
        const idx = ((originY + y) * state.width + (originX + x)) * 4;
        const a = m / 255 * 0.5;
        px[idx] = Math.round(px[idx]! * (1 - a) + 40 * a);
        px[idx + 1] = Math.round(px[idx + 1]! * (1 - a) + 40 * a);
        px[idx + 2] = Math.round(px[idx + 2]! * (1 - a) + 40 * a);
      }
    }
    ctx.putImageData(imageData, 0, 0);
  };

  /** Binds a layer buffer to an asset on first edit, seeding it with the pre-edit bytes. */
  const ensureBufferAsset = async (layerId: string, target: "pixels" | "mask", before: Uint8ClampedArray): Promise<AssetId | null> => {
    await kernel.assetsReady;
    // Read the live document, not the state this render closed over: commits are
    // queued, so by the time this runs an earlier one may already have bound the
    // asset, and working from the stale copy would bind a second one.
    const live = kernel.documents.get<RasterDocumentState>(document.id)?.state;
    const layer = live?.layers.find((item) => item.id === layerId);
    if (!layer) return null;

    const key = target === "mask" ? "maskAssetId" : "pixelAssetId";
    const existing = layer[key];
    if (existing && kernel.assets.has(existing)) return existing as AssetId;

    const assetId = await kernel.assets.importAsset(toBytes(before, state.width, state.height), { kind: "image", name: `${layer.name}.${target}.vraster`, mime: RASTER_ASSET_MIME });
    kernel.documents.update<RasterDocumentState>(document.id, (current) => {
      const target_ = current.layers.find((item) => item.id === layerId);
      if (target_) target_[key] = assetId;
    });
    kernel.documents.addAssetRef(document.id, assetId);
    return assetId;
  };

  /**
   * Records a destructive pixel edit.
   *
   * The edit lands in the document first and is written to the asset store
   * afterwards. That order matters: the store is on OPFS, and a full layer is
   * eight megabytes each way, so making the document wait for it left a window
   * of tens of milliseconds after the pointer came up in which the layer still
   * held the previous pixels. A second stroke started inside that window read
   * the stale buffer and was lost when the first commit finally landed.
   *
   * The buffers go to the asset store and the history step keeps two revision
   * numbers. Holding the before and after buffers inside the step instead would
   * cost 16 MB per stroke on a 1920x1080 layer, and the memory budget would
   * start dropping undo depth after a dozen strokes.
   */
  const commitPixels = async (before: Uint8ClampedArray, after: Uint8ClampedArray, label: string, target: "pixels" | "mask" = "pixels", layerId = state.activeLayerId, bounds?: RasterRect | null) => {
    // Every pixel edit passes the rules before it passes anywhere else — this
    // is the door section 4.4 of the plan is about. A rule may rewrite the
    // edit (confine it to the selection) or refuse it outright (a locked
    // layer), and the refusal ends the commit here: nothing is shown, nothing
    // is stored, and no history step is recorded for an edit that never was.
    const outcome = applyRasterRules(
      { before, after, label, target, layerId, bounds: bounds ?? null },
      { document: state, layer: flattenRasterLayers(state.layers).find((item) => item.id === layerId) ?? null },
    );
    if (!outcome.edit) {
      diagnostic("info", "rules.veto", `Edit refused by rule "${outcome.vetoedBy}"`, { documentId: document.id, layerId, rule: outcome.vetoedBy });
      // A gesture that gets this far already painted straight to the canvas
      // via schedulePreview — outside React, ahead of ever knowing whether
      // the edit would hold up (paint-stroke.ts's whole reason for existing).
      // A veto leaves the document exactly as it was, but nobody told the
      // canvas: document.revision never changes, so the tile-cache effect
      // above never re-fires, and the refused stroke would sit there looking
      // committed until some unrelated edit happened to repaint over it.
      // Recompositing from `state` here is what makes the screen agree with
      // the document it was just told to disagree with.
      const canvas = canvasRef.current;
      if (canvas) putPixels(canvas, compositeRasterDocument(state), state.width, state.height);
      return;
    }
    const edit = outcome.edit;
    if (edit.bounds) documentDirty.current.add(edit.bounds);
    const history = kernel.historyByDocument.get(document.id);
    if (!history) throw new Error(`History missing for ${document.id}`);
    const assign = (pixels: Uint8Array | Uint8ClampedArray): void => {
      const buffer = pixels instanceof Uint8ClampedArray ? pixels : fromBytes(pixels);
      kernel.documents.update<RasterDocumentState>(document.id, (current) => {
        const layer = current.layers.find((item) => item.id === layerId);
        if (!layer) return;
        if (target === "mask" && layer.mask) { layer.mask.pixels = rgbaToMask(buffer); return; }
        // Stored at the size of what was painted, not the size of the canvas.
        // The tool worked at canvas size because a stroke can go anywhere; what
        // is kept afterwards is the part that has something in it.
        setLayerPixels(layer, buffer, current.width, current.height);
      });
    };

    // One buffer, from here to both consumers. The screen gets `confined` and
    // so does the asset store; recomputing it for the second would be how the
    // two quietly disagree, which is the bug section 4.4 was written after.
    const confined = edit.after;

    // Show the result now; the gesture is over and the user is looking at it.
    assign(confined);

    // Queue the bookkeeping. Two commits must not interleave: each reads the
    // asset head to name the revision it undoes to, and a head read between
    // another commit's write and its own would record a step that undoes to
    // the wrong picture.
    commitQueue.current = commitQueue.current
      .catch(() => undefined)
      .then(async () => {
        const assetId = await ensureBufferAsset(layerId, target, before);
        if (!assetId) {
          // No asset store available: fall back to buffer snapshots so the edit
          // is still reversible, just at the old memory cost.
          await history.record({ label, memoryEstimate: before.byteLength + confined.byteLength, redo: () => assign(confined), undo: () => assign(before) });
          return;
        }
        const previousRev = kernel.assets.mustGet(assetId).head;
        // The confined buffer, not the raw one: this revision is what redo and
        // any later reload restore from, so committing the unconfined edit here
        // would show the selection honoured and then quietly undo that on the
        // first redo. Every current tool masks as it paints, which is why the
        // two agree today; the guarantee above is for the one that does not.
        const nextRev = await kernel.assets.commitRevision(assetId, toBytes(confined, state.width, state.height), "raster", label);
        await history.record(createBufferRevisionOperation({ assets: kernel.assets, assetId, label, producedBy: "raster", apply: assign }, previousRev, nextRev));
      });
    await commitQueue.current;
  };

  const commitDocumentState = async (before: RasterDocumentState, after: RasterDocumentState, label: string, bounds?: RasterRect | null) => {
    if (bounds) documentDirty.current.add(bounds);
    const history = kernel.historyByDocument.get(document.id);
    if (!history) throw new Error(`History missing for ${document.id}`);
    const assign = (snapshot: RasterDocumentState): void => { kernel.documents.update<RasterDocumentState>(document.id, (current) => { Object.assign(current, cloneRasterState(snapshot)); }); };
    await history.execute({ label, memoryEstimate: stateDeltaBytes(before, after), redo: () => assign(after), undo: () => assign(before) });
  };

  const commitSelection = async (before: PixelSelection | null, after: PixelSelection | null, label = "Marquee Selection (Прямоугольное выделение)") => {
    const history = kernel.historyByDocument.get(document.id);
    if (!history) throw new Error(`History missing for ${document.id}`);
    const clone = (selection: PixelSelection | null): PixelSelection | null => selection ? { mask: selection.mask.slice(), bounds: { ...selection.bounds } } : null;
    const assign = (selection: PixelSelection | null): void => { kernel.documents.update<RasterDocumentState>(document.id, (current) => { current.selection = clone(selection); }); };
    await history.execute({ label, memoryEstimate: (before?.mask.byteLength ?? 0) + (after?.mask.byteLength ?? 0), redo: () => assign(after), undo: () => assign(before) });
  };

  return { renderWorking, renderWorkingRegion, renderSpotHealOverlay, commitPixels, commitDocumentState, commitSelection };
}
