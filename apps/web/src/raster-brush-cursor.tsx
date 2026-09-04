import { useRef, useState, type RefObject } from "react";
import type { Point, RasterDocumentState, RasterLayer } from "@vravio/env-raster";
import { pointFromNativeEvent } from "./raster-coordinates";
import type { DocumentViewport } from "./store";

/**
 * The brush cursor ring/crosshair and the clone stamp's source
 * crosshair-plus-preview — split out of `RasterWorkspace.tsx` purely to
 * bring its own line count down (docs/migration-plan.md §8), not because
 * any of this changed.
 *
 * `sourcePointRef`/`cloneOffsetRef` are passed in rather than owned here:
 * `raster.clone`'s own `ToolContext.cloneSource`/`cloneOffset` are the same
 * two refs, read and written by the tool itself — the crosshair-and-swatch
 * cursor this hook draws is chrome layered over state the tool owns, not a
 * second copy of it (see `environments/raster/tools/types.ts`'s own comment
 * on `cloneSource`).
 */
export function useBrushCursor(params: {
  state: RasterDocumentState;
  viewport: DocumentViewport;
  toolOptions: Record<string, Record<string, string | number | boolean>>;
  activeToolId: string | undefined;
  brushLike: boolean;
  canvasPixels: (layer: RasterLayer) => Uint8ClampedArray;
  workspaceRef: RefObject<HTMLDivElement | null>;
  sourcePointRef: RefObject<Point | null>;
  cloneOffsetRef: RefObject<Point | null>;
  preciseCursor: boolean;
  documentOriginX: number;
  documentOriginY: number;
}) {
  const { state, viewport, toolOptions, activeToolId, brushLike, canvasPixels, workspaceRef, sourcePointRef, cloneOffsetRef, preciseCursor, documentOriginX, documentOriginY } = params;
  const brushCursorRef = useRef<HTMLDivElement>(null);
  const cloneSourceCanvasRef = useRef<HTMLCanvasElement>(null);
  /** Where the clone is reading from right now, in document space, for the overlay. */
  const [cloneSourceView, setCloneSourceView] = useState<Point | null>(null);

  const brushOptions = toolOptions[activeToolId ?? ""] ?? {};
  const tipAngle = Number(brushOptions.angle ?? 0), tipRoundness = Number(brushOptions.roundness ?? 100);

  /**
   * Shows where the clone stamp is reading from, and what it is about to lay down.
   *
   * Without it the tool is guesswork: the source is invisible, so the only way
   * to find out what a stroke will produce is to make it and undo. Photoshop
   * answers both questions on the canvas — a crosshair at the source, and the
   * sampled area previewed inside the brush tip.
   */
  const updateCloneSourceView = (point: Point) => {
    const anchor = sourcePointRef.current;
    if (!anchor) { setCloneSourceView(null); return; }
    const offset = cloneOffsetRef.current ?? { x: anchor.x - point.x, y: anchor.y - point.y };
    const source = { x: point.x + offset.x, y: point.y + offset.y };
    setCloneSourceView(source);

    const preview = cloneSourceCanvasRef.current;
    if (!preview) return;
    const size = Math.max(2, Math.round(Number(toolOptions["raster.clone"]?.size ?? 24)));
    if (preview.width !== size) { preview.width = size; preview.height = size; }
    const context = preview.getContext("2d");
    const layer = state.layers.find((item) => item.id === state.activeLayerId);
    if (!context || !layer) return;
    context.clearRect(0, 0, size, size);
    const sampled = canvasPixels(layer);
    // Read straight out of the layer buffer: the sample is what the tool will
    // actually copy, not what the composite happens to show over it.
    const image = context.createImageData(size, size);
    const half = size / 2;
    for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
      const sourceX = Math.round(source.x - half + x), sourceY = Math.round(source.y - half + y);
      if (sourceX < 0 || sourceY < 0 || sourceX >= state.width || sourceY >= state.height) continue;
      const from = (sourceY * state.width + sourceX) * 4, to = (y * size + x) * 4;
      image.data[to] = sampled[from]!; image.data[to + 1] = sampled[from + 1]!;
      image.data[to + 2] = sampled[from + 2]!; image.data[to + 3] = sampled[from + 3]!;
    }
    context.putImageData(image, 0, 0);

    // The tip's own falloff, applied to the preview. A soft stamp does not lay
    // down a disc with a hard edge, and a preview that shows one promises an
    // edge the stroke will not produce.
    const hardness = Math.max(0, Math.min(1, Number(toolOptions["raster.clone"]?.hardness ?? 82) / 100));
    context.globalCompositeOperation = "destination-in";
    const centre = size / 2;
    const falloff = context.createRadialGradient(centre, centre, centre * hardness, centre, centre, centre);
    falloff.addColorStop(0, "rgba(0,0,0,1)");
    falloff.addColorStop(1, "rgba(0,0,0,0)");
    context.fillStyle = falloff;
    context.fillRect(0, 0, size, size);
    context.globalCompositeOperation = "source-over";
  };

  const updateBrushCursor = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!brushLike || !workspaceRef.current || !brushCursorRef.current) return;
    // Screen pixels, not document ones: the cursor is interface, drawn in a layer
    // that sits outside .raster-stage's zoom transform, so a plain client-relative
    // position is already correct — no inverse-zoom math needed to place it.
    const rect = workspaceRef.current.getBoundingClientRect();
    const screenX = event.clientX - rect.left, screenY = event.clientY - rect.top;
    brushCursorRef.current.style.transform = `translate(${screenX}px, ${screenY}px) rotate(${tipAngle}deg)`;
    brushCursorRef.current.style.opacity = "1";
    if (activeToolId === "raster.clone") {
      const point = pointFromNativeEvent(workspaceRef.current, viewport, state.width, state.height, event.nativeEvent);
      updateCloneSourceView(point);
      const preview = cloneSourceCanvasRef.current;
      if (preview) {
        // Anchored on the pointer itself, so it sits inside the brush ring
        // rather than beside it. The ring is drawn on the same centre.
        preview.style.left = `${screenX}px`;
        preview.style.top = `${screenY}px`;
      }
    }
  };

  const onPointerLeave = () => {
    if (brushCursorRef.current) brushCursorRef.current.style.opacity = "0";
    setCloneSourceView(null);
  };

  /*
    Cursors live outside .raster-stage on purpose: that element carries the zoom's CSS scale
    transform, and vector-effect:non-scaling-stroke does not reliably cancel a *CSS* transform
    on an ancestor the way it cancels an SVG viewBox/internal transform — the ring's outline
    was measurably scaling with zoom despite asking it not to. Positioned here, in an
    unscaled sibling layer, a ring's diameter is set directly in screen pixels (so it still
    shows the tool's true footprint at the current zoom) while its border is a literal CSS
    pixel value untouched by any transform — the interface, unlike the document, does not
    grow with the zoom. Same reasoning documentOriginX/Y already use for the rulers.
  */
  const overlay = <>
    {brushLike && <div ref={brushCursorRef} className="brush-cursor" style={{ opacity: 0 }}>
      {preciseCursor
        ? <span className="cursor-crosshair"/>
        : <span className="cursor-ring" style={{ width: Number(brushOptions.size ?? 24) * viewport.zoom, height: Number(brushOptions.size ?? 24) * viewport.zoom * tipRoundness / 100 }}/>}
    </div>}
    {activeToolId === "raster.clone" && (
      <>
        {/* The sample, shown inside the tip: what the next dab will lay down,
            clipped to a circle so it reads as the brush rather than a swatch. */}
        <canvas ref={cloneSourceCanvasRef} className="clone-source-preview" width={2} height={2} aria-hidden="true"
          style={cloneSourceView ? {
            width: `${Number(toolOptions["raster.clone"]?.size ?? 24) * viewport.zoom}px`,
            height: `${Number(toolOptions["raster.clone"]?.size ?? 24) * viewport.zoom}px`,
          } : { opacity: 0 }}/>
        {cloneSourceView && <div className="clone-source-cursor" style={{
          left: documentOriginX + cloneSourceView.x * viewport.zoom,
          top: documentOriginY + cloneSourceView.y * viewport.zoom,
          width: Number(toolOptions["raster.clone"]?.size ?? 24) * viewport.zoom,
          height: Number(toolOptions["raster.clone"]?.size ?? 24) * viewport.zoom,
        }}>
          <span className="cursor-ring"/>
          <span className="cursor-crosshair"/>
        </div>}
      </>
    )}
  </>;

  return { updateBrushCursor, onPointerLeave, brushOptions, tipAngle, tipRoundness, overlay };
}
