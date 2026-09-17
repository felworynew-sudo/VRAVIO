import { useSyncExternalStore } from "react";
import type { SelectionFrame } from "@vravio/env-raster";

/**
 * Which documents have Select ▸ Transform Selection open, and the frame each
 * one has been dragged to so far. Opened by the `select.transform` command,
 * edited and closed by `TransformSelectionOverlay` — both outside the Move
 * tool, which transforms pixels, not outlines.
 */
const frames = new Map<string, SelectionFrame>();
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };

export function startTransformSelection(documentId: string, bounds: SelectionFrame["source"]): void {
  frames.set(documentId, { source: { ...bounds }, target: { ...bounds }, rotation: 0 });
  notify();
}

export function updateTransformSelection(documentId: string, frame: SelectionFrame): void {
  if (!frames.has(documentId)) return;
  frames.set(documentId, frame);
  notify();
}

export function endTransformSelection(documentId: string): void {
  if (frames.delete(documentId)) notify();
}

export const transformSelectionFrame = (documentId: string): SelectionFrame | null => frames.get(documentId) ?? null;

export function useTransformSelection(documentId: string): SelectionFrame | null {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => frames.get(documentId) ?? null,
    () => null,
  );
}
