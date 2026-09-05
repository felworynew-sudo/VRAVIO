import { duplicateShape, groupShapes, moveShapeInStack, removeShapes, ungroupShapes, type VectorDocumentState, type VectorShape, type ZOrderMove } from "@vravio/env-vector";
import { kernel } from "./kernel";

export interface VectorSnapshot { shapes: VectorShape[]; activeShapeId: string | null; selection: readonly string[] }

export function snapshotVector(state: VectorDocumentState): VectorSnapshot {
  return { shapes: structuredClone(state.shapes), activeShapeId: state.activeShapeId, selection: state.selection };
}

function assignVectorSnapshot(documentId: string, snapshot: VectorSnapshot): void {
  kernel.documents.update<VectorDocumentState>(documentId, (state) => {
    state.shapes = structuredClone(snapshot.shapes);
    state.activeShapeId = snapshot.activeShapeId;
    state.selection = snapshot.selection;
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

  const before = { shapes: structuredClone(document.state.shapes), activeShapeId: document.state.activeShapeId, selection: document.state.selection };
  const working: VectorDocumentState = { ...document.state, shapes: structuredClone(document.state.shapes) };
  if (!mutate(working)) return;
  const after = { shapes: working.shapes, activeShapeId: working.activeShapeId, selection: working.selection };

  const assign = (snapshot: typeof before): void => {
    kernel.documents.update<VectorDocumentState>(documentId, (state) => {
      state.shapes = structuredClone(snapshot.shapes);
      state.activeShapeId = snapshot.activeShapeId;
      state.selection = snapshot.selection;
    });
  };
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
