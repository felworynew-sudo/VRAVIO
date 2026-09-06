import { createSymbolFromShapes, detachInstance, duplicateShape, groupShapes, moveShapeInStack, placeSymbolInstance, redefineSymbolFromShapes, removeShapes, ungroupShapes, type Artboard, type PaletteColor, type VectorDocumentState, type VectorGuide, type VectorShape, type ZOrderMove } from "@vravio/env-vector";
import { kernel } from "./kernel";

/**
 * `artboards`/`activeArtboardId` joined this snapshot in stage 15 of
 * docs/vector-plan.md — before that, undo/redo and `changeVectorDocument`'s
 * own before/after diff only ever needed `shapes`/`activeShapeId`/
 * `selection`, and every artboard command (create, move, duplicate,
 * delete, rename) silently no-opped through here: `changeVectorDocument`
 * built its own `after` from `working.shapes`/`activeShapeId`/`selection`
 * alone, so a mutate callback that only touched `working.artboards` (every
 * one of `artboard-ops.ts`'s own functions) had its entire effect thrown
 * away the moment `assign` wrote back a snapshot that never mentioned
 * artboards at all — caught live, not in a test: the Artboards panel's own
 * delete button visibly did nothing. `palette` (section 8's addition) hit
 * the exact same bug the same way, live again; `guides`/`rulerOrigin`/
 * `rulerMode` (stage 15's rulers) and `cmykProfileAssetId`/`softproof`
 * (stage 14's proof) were each added to all three spots — this type,
 * `snapshotVector`, and both `assign`/`working`/`after` sites in
 * `changeVectorDocument` below — in the same commit that introduced them,
 * on the strength of that pattern, rather than waiting to rediscover it a
 * third time live.
 */
export interface VectorSnapshot { shapes: VectorShape[]; activeShapeId: string | null; selection: readonly string[]; artboards: Artboard[]; activeArtboardId: string | null; palette: PaletteColor[]; guides: VectorGuide[]; rulerOrigin: { x: number; y: number } | null; rulerMode: "global" | "artboard"; cmykProfileAssetId: string | null; softproof: boolean }

export function snapshotVector(state: VectorDocumentState): VectorSnapshot {
  return { shapes: structuredClone(state.shapes), activeShapeId: state.activeShapeId, selection: state.selection, artboards: structuredClone(state.artboards), activeArtboardId: state.activeArtboardId, palette: structuredClone(state.palette), guides: structuredClone(state.guides), rulerOrigin: state.rulerOrigin, rulerMode: state.rulerMode, cmykProfileAssetId: state.cmykProfileAssetId, softproof: state.softproof };
}

function assignVectorSnapshot(documentId: string, snapshot: VectorSnapshot): void {
  kernel.documents.update<VectorDocumentState>(documentId, (state) => {
    state.shapes = structuredClone(snapshot.shapes);
    state.activeShapeId = snapshot.activeShapeId;
    state.selection = snapshot.selection;
    state.artboards = structuredClone(snapshot.artboards);
    state.activeArtboardId = snapshot.activeArtboardId;
    state.palette = structuredClone(snapshot.palette);
    state.guides = structuredClone(snapshot.guides);
    state.rulerOrigin = snapshot.rulerOrigin;
    state.rulerMode = snapshot.rulerMode;
    state.cmykProfileAssetId = snapshot.cmykProfileAssetId;
    state.softproof = snapshot.softproof;
  });
}

/**
 * Records one history step for an edit whose effect is already live on the document — a shape
 * drag, resize, or the freehand pen tool, all of which call `kernel.documents.update` directly
 * on every pointermove so the canvas stays responsive while the pointer is down. `before` must
 * be captured at the *start* of the gesture (pointerdown), before any of those live writes —
 * `changeVectorDocument` below diffs against whatever the document holds at call time, which by
 * pointerup already includes the gesture's own edits, and would record a no-op undo.
 */
export function commitVectorDrag(documentId: string, label: string, before: VectorSnapshot): void {
  const document = kernel.documents.get<VectorDocumentState>(documentId);
  const history = kernel.historyByDocument.get(documentId);
  if (!document || !history) return;
  const after = snapshotVector(document.state);
  void history.record({ label, redo: () => assignVectorSnapshot(documentId, after), undo: () => assignVectorSnapshot(documentId, before) });
}

/**
 * The vector equivalent of `changeRasterDocument` in commands.ts — same shape (snapshot,
 * mutate a draft, diff, one history step), kept in its own module because vector and raster
 * documents share nothing but the pattern. A shape drag or resize should call
 * `kernel.documents.update` directly while the pointer is down (so it stays live) and this
 * once at pointer-up, so dragging a shape across the canvas is one undo step, not hundreds.
 */
export async function changeVectorDocument(documentId: string, label: string, mutate: (state: VectorDocumentState) => boolean): Promise<void> {
  const document = kernel.documents.get<VectorDocumentState>(documentId);
  const history = kernel.historyByDocument.get(documentId);
  if (!document || !history) return;

  const before = snapshotVector(document.state);
  const working: VectorDocumentState = { ...document.state, shapes: structuredClone(document.state.shapes), artboards: structuredClone(document.state.artboards), palette: structuredClone(document.state.palette), guides: structuredClone(document.state.guides) };
  if (!mutate(working)) return;
  const after: VectorSnapshot = { shapes: working.shapes, activeShapeId: working.activeShapeId, selection: working.selection, artboards: working.artboards, activeArtboardId: working.activeArtboardId, palette: working.palette, guides: working.guides, rulerOrigin: working.rulerOrigin, rulerMode: working.rulerMode, cmykProfileAssetId: working.cmykProfileAssetId, softproof: working.softproof };

  const assign = (snapshot: VectorSnapshot): void => assignVectorSnapshot(documentId, snapshot);
  await history.execute({ label, memoryEstimate: 0, redo: () => assign(after), undo: () => assign(before) });
}

/** The Object menu's actions — duplicate, delete, and the four z-order moves — all reduced to the one active shape, the way a single-selection vector editor treats them. Multi-shape versions can widen `ids` later without touching call sites. */
export function duplicateActiveVectorShape(documentId: string): void {
  const document = kernel.documents.get<VectorDocumentState>(documentId);
  const id = document?.state.activeShapeId;
  if (!id) return;
  void changeVectorDocument(documentId, "Duplicate Shape (Дублировать фигуру)", (state) => Boolean(duplicateShape(state, id)));
}

export function deleteActiveVectorShapes(documentId: string): void {
  const document = kernel.documents.get<VectorDocumentState>(documentId);
  const ids = document?.state.selection;
  if (!ids?.length) return;
  void changeVectorDocument(documentId, "Delete Shape (Удалить фигуру)", (state) => { removeShapes(state, ids); return true; });
}

const zOrderLabels: Record<ZOrderMove, string> = { front: "Bring to Front (На передний план)", back: "Send to Back (На задний план)", forward: "Bring Forward (Переместить выше)", backward: "Send Backward (Переместить ниже)" };

export function reorderActiveVectorShape(documentId: string, move: ZOrderMove): void {
  const document = kernel.documents.get<VectorDocumentState>(documentId);
  const id = document?.state.activeShapeId;
  if (!id) return;
  void changeVectorDocument(documentId, zOrderLabels[move], (state) => { moveShapeInStack(state, id, move); return true; });
}

/** Wraps the current selection in a new group — Cmd/Ctrl+G, mirroring Photoshop's own Group
 * Layers. Fewer than two shapes selected is a no-op rather than a pointless single-member group:
 * `groupShapes` already returns null for an empty selection, and grouping a lone shape produces
 * nothing a user asked for, only an extra level to immediately have to see through. */
export function groupActiveVectorShapes(documentId: string): void {
  const document = kernel.documents.get<VectorDocumentState>(documentId);
  const ids = document?.state.selection;
  if (!ids || ids.length < 2) return;
  void changeVectorDocument(documentId, "Group (Сгруппировать)", (state) => Boolean(groupShapes(state, ids)));
}

/** Dissolves the active group, Cmd/Ctrl+Shift+G — a no-op on anything that is not a group,
 * the same guard `ungroupShapes` itself already has. */
export function ungroupActiveVectorGroup(documentId: string): void {
  const document = kernel.documents.get<VectorDocumentState>(documentId);
  const id = document?.state.activeShapeId;
  if (!id) return;
  void changeVectorDocument(documentId, "Ungroup (Разгруппировать)", (state) => ungroupShapes(state, id));
}

/** Stage 13: wraps the current selection into a new symbol, leaving one
 * instance where the selection used to be — the Symbols panel's own
 * "Create Symbol from Selection", and the Object menu's mirror of it. */
export function createSymbolFromActiveSelection(documentId: string): void {
  const document = kernel.documents.get<VectorDocumentState>(documentId);
  const ids = document?.state.selection;
  if (!ids?.length) return;
  void changeVectorDocument(documentId, "Create Symbol (Создать символ)", (state) => Boolean(createSymbolFromShapes(state, ids)));
}

/** "Break Link" (Разорвать связь) — a no-op unless the active shape is
 * actually an instance, the same guard `detachInstance` itself already has. */
export function detachActiveVectorInstance(documentId: string): void {
  const document = kernel.documents.get<VectorDocumentState>(documentId);
  const id = document?.state.activeShapeId;
  if (!id) return;
  void changeVectorDocument(documentId, "Break Link (Разорвать связь)", (state) => Boolean(detachInstance(state, id)));
}

/** "Redefine Symbol" (Переопределить символ) — folds the current selection
 * into an existing symbol's definition, replacing what it used to contain;
 * every instance of it updates immediately since none of them ever held a
 * copy to begin with. */
export function redefineSymbolFromActiveSelection(documentId: string, symbolId: string): void {
  const document = kernel.documents.get<VectorDocumentState>(documentId);
  const ids = document?.state.selection;
  if (!ids?.length) return;
  void changeVectorDocument(documentId, "Redefine Symbol (Переопределить символ)", (state) => redefineSymbolFromShapes(state, symbolId, ids));
}

/** Places a new instance of an existing symbol at the given document-space
 * point — the Symbols panel's own "place" action. */
export function placeVectorSymbolInstance(documentId: string, symbolId: string, x: number, y: number): void {
  void changeVectorDocument(documentId, "Place Symbol Instance (Разместить экземпляр символа)", (state) => Boolean(placeSymbolInstance(state, symbolId, x, y)));
}
