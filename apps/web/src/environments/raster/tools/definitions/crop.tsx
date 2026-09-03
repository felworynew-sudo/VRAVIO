import { cloneRasterState, cropRasterDocument, layerAccepts, type Point } from "@vravio/env-raster";
import type { RasterToolDefinition } from "../types";

/**
 * Crops the whole document to a dragged rectangle.
 *
 * Split off from the old switch's combined `move`/`crop` branch — the two
 * shared one `documentGesture` shape there, but crop only ever used a
 * handful of its fields (`from`/`current`/`before`) and had none of move's
 * own complexity (auto-select, floating selections, quad/warp/rotate
 * handles, text transforms). That complexity is deferred to its own
 * session (see docs/migration-plan.md) rather than dragged into this file
 * to keep the two nominally "together".
 */

interface CropState {
  readonly drag: { pointerId: number; from: Point; current: Point } | null;
}

const empty: CropState = { drag: null };

const crop: RasterToolDefinition<CropState> = {
  id: "raster.crop",
  createState: () => empty,

  onPointerDown(context, pointer) {
    // The old switch ran crop through the same "does this layer accept
    // being moved" gate as raster.move — cropping isn't really an edit to
    // the active layer at all (cropRasterDocument touches every layer),
    // but this is what the shared branch already checked, so it stays.
    if (context.activeLayer && !layerAccepts(context.activeLayer, "move")) return;
    context.capturePointer(pointer.pointerId);
    context.setState({ drag: { pointerId: pointer.pointerId, from: pointer.point, current: pointer.point } });
  },

  onPointerMove(context, pointer) {
    const drag = context.state.drag;
    if (!drag || drag.pointerId !== pointer.pointerId) return;
    context.setState({ drag: { ...drag, current: pointer.point } });
  },

  onGestureEnd(context, pointer) {
    const drag = context.state.drag;
    context.setState(empty);
    if (!drag || drag.pointerId !== pointer.pointerId) return;
    const rect = {
      x: Math.min(drag.from.x, drag.current.x), y: Math.min(drag.from.y, drag.current.y),
      width: Math.abs(drag.current.x - drag.from.x), height: Math.abs(drag.current.y - drag.from.y),
    };
    if (rect.width < 1 || rect.height < 1) return;
    const before = cloneRasterState(context.document);
    void context.commitDocument(before, cropRasterDocument(before, rect), "Crop (Кадрирование)");
    context.resetViewportToFit();
  },

  onDeactivate(context) {
    if (context.state.drag) context.setState(empty);
  },

  Overlay({ state, document }) {
    const drag = state.drag;
    if (!drag) return null;
    const rect = {
      x: Math.min(drag.from.x, drag.current.x), y: Math.min(drag.from.y, drag.current.y),
      width: Math.abs(drag.current.x - drag.from.x), height: Math.abs(drag.current.y - drag.from.y),
    };
    if (rect.width <= 0 || rect.height <= 0) return null;
    return <svg className="selection-overlay" viewBox={`0 0 ${document.width} ${document.height}`} preserveAspectRatio="none" aria-hidden="true">
      <rect x={rect.x} y={rect.y} width={rect.width} height={rect.height}/>
    </svg>;
  },
};

export default crop;
