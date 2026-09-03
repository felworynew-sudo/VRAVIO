import { useEffect, useRef } from "react";
import { sampleAverage, toHexColor, type RasterDocumentState } from "@vravio/env-raster";
import type { RasterToolDefinition, ToolContext, ToolPointer } from "../types";

/**
 * The eyedropper: reads a colour, and shows what it is reading.
 *
 * First tool moved out of RasterWorkspace's switch (stage 3 of
 * docs/migration-plan.md). Picked to go first because it is small but not
 * trivial — it holds gesture state, captures the pointer, samples either the
 * layer or the composite depending on an option, draws an overlay, and hands
 * a result back to the shell. A tool that only painted would have exercised
 * less of the contract, and the point of going first is to find out what the
 * contract is missing.
 */

const LOUPE_CELLS = 17;
const LOUPE_SIZE = 128;

type Gesture = {
  readonly pointerId: number;
  readonly source: Uint8ClampedArray;
  readonly sample: number;
  readonly loupe: boolean;
};

interface EyedropperState {
  /** The gesture in progress, with the image it is reading. */
  readonly gesture: Gesture | null;
  /** What the overlay is showing. Null between gestures, which hides it. */
  readonly view: {
    readonly x: number;
    readonly y: number;
    readonly screenX: number;
    readonly screenY: number;
    readonly color: string;
    readonly loupe: boolean;
  } | null;
}

/** Takes the colour under the pointer and tells the shell and the overlay. */
function sample(context: ToolContext<EyedropperState>, pointer: ToolPointer, gesture: Gesture): void {
  const { document } = context;
  const color = toHexColor(sampleAverage(gesture.source, document.width, document.height, pointer.point.x, pointer.point.y, gesture.sample));
  context.setForegroundColor(color);
  context.setState({
    gesture,
    view: { x: pointer.point.x, y: pointer.point.y, screenX: pointer.screenX, screenY: pointer.screenY, color, loupe: gesture.loupe },
  });
}

/**
 * The magnified neighbourhood, drawn from the same buffer the sample came
 * from rather than from the composite as it stands now — otherwise the loupe
 * would be explaining a different picture than the one the colour was taken
 * from.
 */
function Loupe({ state, document }: { state: EyedropperState; document: RasterDocumentState }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const view = state.view;
  const source = state.gesture?.source;

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context || !view || !source) return;
    const image = context.createImageData(LOUPE_CELLS, LOUPE_CELLS);
    const half = Math.floor(LOUPE_CELLS / 2);
    for (let y = 0; y < LOUPE_CELLS; y += 1) for (let x = 0; x < LOUPE_CELLS; x += 1) {
      const sourceX = Math.round(view.x) - half + x, sourceY = Math.round(view.y) - half + y;
      const to = (y * LOUPE_CELLS + x) * 4;
      if (sourceX < 0 || sourceY < 0 || sourceX >= document.width || sourceY >= document.height) continue;
      const from = (sourceY * document.width + sourceX) * 4;
      image.data[to] = source[from]!; image.data[to + 1] = source[from + 1]!;
      image.data[to + 2] = source[from + 2]!; image.data[to + 3] = source[from + 3]!;
    }
    context.putImageData(image, 0, 0);
  }, [view, source, document.width, document.height]);

  if (!view) return null;
  return <div
    className="eyedropper-loupe"
    aria-hidden="true"
    style={{ transform: `translate(${view.screenX}px, ${view.screenY}px) translate(-50%, -50%)`, borderColor: view.color, width: `${LOUPE_SIZE}px`, height: `${LOUPE_SIZE}px` }}
  >
    <canvas ref={canvasRef} width={LOUPE_CELLS} height={LOUPE_CELLS}/>
    {/* The centre cell is the pixel that will be taken; the grid is only there
        to make it countable. */}
    <span className="eyedropper-loupe-cell" style={{ width: `${LOUPE_SIZE / LOUPE_CELLS}px`, height: `${LOUPE_SIZE / LOUPE_CELLS}px` }}/>
    <span className="eyedropper-loupe-hex">{view.color.toUpperCase()}</span>
  </div>;
}

const eyedropper: RasterToolDefinition<EyedropperState> = {
  id: "raster.eyedropper",
  createState: () => ({ gesture: null, view: null }),

  onPointerDown(context, pointer) {
    context.capturePointer(pointer.pointerId);
    // The sampled image is read once for the gesture. Compositing per pointer
    // move would make the loupe lag behind the cursor it is meant to explain.
    const { options } = context;
    const gesture: Gesture = {
      pointerId: pointer.pointerId,
      source: options.allLayers === false ? context.layerPixels() : context.compositePixels(),
      sample: options.sample === "point" || options.sample === undefined ? 1 : Number(options.sample),
      loupe: options.loupe !== false,
    };
    sample(context, pointer, gesture);
  },

  onPointerMove(context, pointer) {
    const gesture = context.state.gesture;
    if (gesture?.pointerId !== pointer.pointerId) return;
    sample(context, pointer, gesture);
  },

  onGestureEnd(context, pointer) {
    if (context.state.gesture?.pointerId !== pointer.pointerId) return;
    // The loupe belongs to the press, as it does in Figma: it appears on the
    // way down and is gone on the way up, so it never sits over the work.
    context.setState({ gesture: null, view: null });
  },

  Overlay({ state, document }) {
    const view = state.view;
    if (!view) return null;
    if (view.loupe) return <Loupe state={state} document={document}/>;
    return <span
      className="eyedropper-chip"
      aria-hidden="true"
      style={{ transform: `translate(${view.screenX}px, ${view.screenY}px)`, background: view.color }}
    />;
  },
};

export default eyedropper;
