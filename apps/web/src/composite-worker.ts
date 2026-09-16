import { blendSimpleLayerStack } from "@vravio/env-raster";

/**
 * docs/master-plan.md §37.3 item 4 — the Worker half of the "simple layer stack" fast path.
 * Mirrors `filter-worker.ts` exactly: this script only ever sees flat `ArrayBuffer`s (never a
 * `RasterLayer`/`TileStore` — those cannot cross a `postMessage` boundary at all, see
 * docs/master-plan.md §37.6.3 finding 8) and calls straight into the pure, already-tested
 * `blendSimpleLayerStack` from `@vravio/env-raster` — no blend math is reimplemented here.
 */
interface BlendRequest {
  type: "blend";
  requestId: number;
  width: number;
  height: number;
  documentX: number;
  documentY: number;
  layers: readonly { pixels: ArrayBuffer; opacity: number; blendMode: string }[];
}

interface CompositeWorkerScope {
  onmessage: ((event: MessageEvent<BlendRequest>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}
const workerScope = self as unknown as CompositeWorkerScope;

workerScope.onmessage = (event: MessageEvent<BlendRequest>) => {
  const request = event.data;
  try {
    const layers = request.layers.map((layer) => ({
      pixels: new Uint8ClampedArray(layer.pixels),
      opacity: layer.opacity,
      blendMode: layer.blendMode,
    }));
    const result = blendSimpleLayerStack(request.width, request.height, layers, request.documentX, request.documentY);
    const pixels = result.buffer;
    workerScope.postMessage({ type: "blended", requestId: request.requestId, pixels }, [pixels]);
  } catch (error) {
    workerScope.postMessage({ type: "error", requestId: request.requestId, message: error instanceof Error ? error.message : String(error) });
  }
};
