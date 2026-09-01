import { applyRasterFilter, type RasterFilterDefinition } from "@vravio/env-raster";

interface RenderRequest {
  type: "render";
  requestId: number;
  pixels: ArrayBuffer;
  width: number;
  height: number;
  filterId: string;
  settings: Record<string, number>;
}

interface ThumbnailsRequest {
  type: "thumbnails";
  requestId: number;
  pixels: ArrayBuffer;
  width: number;
  height: number;
  filters: RasterFilterDefinition[];
}

type FilterWorkerRequest = RenderRequest | ThumbnailsRequest;
interface FilterWorkerScope {
  onmessage: ((event: MessageEvent<FilterWorkerRequest>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}
const workerScope = self as unknown as FilterWorkerScope;
const transferableBuffer = (pixels: Uint8ClampedArray): ArrayBuffer =>
  pixels.buffer instanceof ArrayBuffer ? pixels.buffer : pixels.slice().buffer;

workerScope.onmessage = (event: MessageEvent<FilterWorkerRequest>) => {
  const request = event.data;
  const source = new Uint8ClampedArray(request.pixels);

  try {
    if (request.type === "render") {
      const result = applyRasterFilter(source, request.width, request.height, request.filterId, request.settings);
      const pixels = transferableBuffer(result);
      workerScope.postMessage({ type: "rendered", requestId: request.requestId, pixels }, [pixels]);
      return;
    }

    const results = request.filters.map((filter) => {
      const defaults = Object.fromEntries(filter.parameters.map((parameter) => [parameter.id, parameter.value]));
      const pixels = applyRasterFilter(source, request.width, request.height, filter.id, defaults);
      return { filterId: filter.id, pixels: transferableBuffer(pixels) };
    });
    workerScope.postMessage(
      { type: "thumbnails-rendered", requestId: request.requestId, results },
      results.map((result) => result.pixels),
    );
  } catch (error) {
    workerScope.postMessage({
      type: "error",
      requestId: request.requestId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
