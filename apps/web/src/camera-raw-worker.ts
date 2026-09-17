import { applyCameraRawFilter, type CameraRawFilterSettings, type CameraRawFrame } from "@vravio/env-raster";

/** Camera Raw's develop pipeline off the main thread — every slider tick used to run it synchronously
 *  in the dialog, freezing it for as long as the render took (docs/master-plan.md §58.1). */
interface RenderRequest {
  readonly pixels: ArrayBuffer;
  readonly width: number;
  readonly height: number;
  readonly settings: CameraRawFilterSettings;
  readonly frame?: CameraRawFrame;
}

interface WorkerScope {
  onmessage: ((event: MessageEvent<RenderRequest>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = (event) => {
  const { pixels, width, height, settings, frame } = event.data;
  try {
    const result = applyCameraRawFilter(new Uint8ClampedArray(pixels), width, height, settings, frame);
    const buffer = result.buffer instanceof ArrayBuffer ? result.buffer : result.slice().buffer;
    scope.postMessage({ type: "rendered", pixels: buffer }, [buffer]);
  } catch (error) {
    scope.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
};
