import { isRasterDocumentState, type PixelSelection, type RasterDocumentState, type RasterLayer } from "@vravio/env-raster";
import { kernel } from "../../../kernel";

/**
 * The two ways a command changes a raster document as one undoable step.
 *
 * Lifted out of `commands.ts` unchanged when the registrations moved into
 * catalogue files (stage 7): they were module-level helpers there, and the
 * layer and selection command families both need them. `DockLayout.tsx` uses
 * `changeRasterDocument` too — a layer dragged in the panel is the same kind
 * of edit as one moved by a menu command, and always was.
 */

/** Copies a selection so history holds a value nothing else can write into. */
export function cloneSelection(selection: PixelSelection | null): PixelSelection | null {
  return selection ? { mask: selection.mask.slice(), bounds: { ...selection.bounds } } : null;
}

export async function changeRasterSelection(documentId: string, label: string, change: (state: RasterDocumentState) => PixelSelection | null): Promise<void> {
  const document = kernel.documents.get<RasterDocumentState>(documentId);
  const history = kernel.historyByDocument.get(documentId);
  if (!document || !history || !isRasterDocumentState(document.state)) return;
  const before = cloneSelection(document.state.selection);
  const after = cloneSelection(change(document.state));
  const assign = (selection: PixelSelection | null): void => { kernel.documents.update<RasterDocumentState>(documentId, (state) => { state.selection = cloneSelection(selection); }); };
  await history.execute({ label, redo: () => assign(after), undo: () => assign(before) });
}

/**
 * Applies a change to the layer tree as one undoable step.
 *
 * Layer operations rearrange structure and can rewrite pixels, so the step
 * holds a snapshot of each side. The snapshots share their pixel buffers with
 * the document — every path that edits pixels replaces the buffer rather than
 * writing through it — so the cost is the tree, not the image.
 */
export async function changeRasterDocument(documentId: string, label: string, mutate: (state: RasterDocumentState) => boolean): Promise<void> {
  const document = kernel.documents.get<RasterDocumentState>(documentId);
  const history = kernel.historyByDocument.get(documentId);
  if (!document || !history || !isRasterDocumentState(document.state)) return;

  const before = snapshotLayers(document.state);
  const draft = snapshotLayers(document.state);
  const working: RasterDocumentState = { ...document.state, layers: draft.layers, activeLayerId: draft.activeLayerId, selection: document.state.selection };
  if (!mutate(working)) return;
  const after = { layers: working.layers, activeLayerId: working.activeLayerId };

  const assign = (snapshot: { layers: RasterLayer[]; activeLayerId: string }): void => {
    kernel.documents.update<RasterDocumentState>(documentId, (state) => {
      state.layers = snapshot.layers.map((layer) => ({ ...layer }));
      state.activeLayerId = snapshot.activeLayerId;
    });
  };
  await history.execute({
    label,
    memoryEstimate: 0,
    redo: () => assign(after),
    undo: () => assign(before),
  });
}

/** Copies the layer tree's structure while sharing the pixel buffers. */
function snapshotLayers(state: RasterDocumentState): { layers: RasterLayer[]; activeLayerId: string } {
  return {
    layers: state.layers.map((layer) => ({
      ...layer,
      ...(layer.mask ? { mask: { ...layer.mask } } : {}),
      ...(layer.text ? { text: structuredClone(layer.text) } : {}),
      ...(layer.adjustment ? { adjustment: structuredClone(layer.adjustment) } : {}),
    })),
    activeLayerId: state.activeLayerId,
  };
}
