/** Minimal ref shape shared by React and the deterministic scheduler test. */
type RefCell<T> = { current: T };

export interface TransientFrameEntry {
  frame: number | null;
}

export interface TransientFrameRefs {
  readonly preview: RefCell<TransientFrameEntry | null>;
  readonly layeredPreview: RefCell<TransientFrameEntry | null>;
  readonly workFrame: RefCell<number | null>;
  readonly pendingWork: RefCell<(() => void) | null>;
}

/**
 * Makes every queued raster canvas write ineligible before a canonical
 * commit/cancel/tool switch. It is intentionally independent from React so
 * the lifecycle contract can be tested without mounting the full workspace.
 */
export function cancelTransientCanvasFrames(refs: TransientFrameRefs, cancelFrame: (frame: number) => void = cancelAnimationFrame): void {
  for (const ref of [refs.preview, refs.layeredPreview]) {
    const entry = ref.current;
    if (entry?.frame !== null && entry) cancelFrame(entry.frame);
    ref.current = null;
  }
  if (refs.workFrame.current !== null) cancelFrame(refs.workFrame.current);
  refs.workFrame.current = null;
  refs.pendingWork.current = null;
}
