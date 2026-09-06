import type { VectorDocumentState, VectorGuide } from "./types";

/**
 * Stage 5/15 of docs/vector-plan.md: draggable guides for vector documents —
 * the vector side of what `packages/env-raster/src/document.ts`'s
 * `RasterGuide` already has, plus `scope` (global vs one specific
 * artboard), which raster's own guides don't need since raster has no
 * concept of multiple artboards sharing one canvas.
 *
 * Guides have no id: unlike shapes/artboards/palette entries, nothing
 * outside this module ever needs to address one by a stable identifier —
 * a guide is added, dragged (removed and re-added at the new position, the
 * same "commit a fresh value" shape a color picker uses, not an in-place
 * mutation tracked by id), or removed by its own (orientation, position)
 * pair, which is already unique enough for a UI that lists them by
 * position.
 */

export function addGuide(state: VectorDocumentState, orientation: VectorGuide["orientation"], position: number, scope: string | null = null): void {
  state.guides.push({ orientation, position, scope });
}

export function removeGuide(state: VectorDocumentState, orientation: VectorGuide["orientation"], position: number): void {
  state.guides = state.guides.filter((guide) => !(guide.orientation === orientation && guide.position === position));
}

export function clearGuides(state: VectorDocumentState, scope?: string | null): void {
  state.guides = scope === undefined ? [] : state.guides.filter((guide) => guide.scope !== scope);
}

/** Every guide visible while `activeArtboardId` is the active one: global
 * guides (`scope: null`) plus any scoped specifically to that artboard.
 * A guide scoped to a *different* artboard (or to one since deleted, which
 * leaves its own scoped guides orphaned rather than destroyed — see
 * `VectorGuide`'s own doc comment) is excluded, the entire point of
 * `scope` existing at all. */
export function visibleGuides(state: VectorDocumentState, activeArtboardId: string | null): VectorGuide[] {
  return state.guides.filter((guide) => guide.scope === null || guide.scope === activeArtboardId);
}

/** Sets or clears the ruler's own zero point — dragging out of the ruler
 * corner (`"global"` mode only; `"artboard"` mode's zero point is always
 * the active artboard's own corner and isn't user-settable). */
export function setRulerOrigin(state: VectorDocumentState, origin: { x: number; y: number } | null): void {
  state.rulerOrigin = origin;
}

export function setRulerMode(state: VectorDocumentState, mode: "global" | "artboard"): void {
  state.rulerMode = mode;
}
