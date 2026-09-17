import { useSyncExternalStore } from "react";

/**
 * Uncommitted editing sessions the Contextual Task Bar offers Apply / Cancel
 * for — a crop rectangle, a Free Transform — published by whoever owns the
 * session (master-plan §11, §58.3).
 *
 * The session's state lives inside its tool; the bar lives outside the canvas
 * component and cannot see it. Rather than copy the tool's state out, the tool
 * publishes the *operations* while the session is open — the very functions its
 * own Enter / Escape handlers call — and withdraws them when it closes. The bar
 * then has nothing of its own to get wrong: pressing its "Done" is pressing
 * Enter.
 */
export interface EditSession {
  readonly kind: "transform" | "crop";
  commit(): void;
  cancel(): void;
  /** Free Transform only: turn the frame by ±90°, like Photoshop's bar buttons. */
  rotate?(degrees: 90 | -90): void;
  /** The session's frame in document pixels, read when the bar places itself — the bar sits
   * outside the crop rectangle or transform frame, not the layer behind it. */
  frame?(): { x: number; y: number; width: number; height: number } | null;
}

const sessions = new Map<string, EditSession>();
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };

/** Opens (or replaces) a document's session; returns the function that closes exactly it. */
export function publishEditSession(documentId: string, session: EditSession): () => void {
  sessions.set(documentId, session);
  notify();
  return () => {
    if (sessions.get(documentId) !== session) return;
    sessions.delete(documentId);
    notify();
  };
}

/**
 * A session's frame changed without the bar being involved in the gesture (Rotate 90° from the
 * bar itself): bumps a counter the bar re-places itself on. Pointer gestures on the canvas need
 * no call — the bar re-places itself on pointerup anyway.
 */
let frameVersion = 0;
export function touchEditSessions(): void { frameVersion += 1; notify(); }
export function useEditSessionFrameVersion(): number {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => frameVersion,
    () => 0,
  );
}

export const editSessionFor = (documentId: string): EditSession | null => sessions.get(documentId) ?? null;

export function useEditSession(documentId: string): EditSession | null {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => sessions.get(documentId) ?? null,
    () => null,
  );
}
