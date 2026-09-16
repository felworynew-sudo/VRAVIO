import type { MLSession, MLTensor, ModelSpec } from "@vravio/kernel";
import { kernel } from "../../kernel";
import { diagnostic } from "../../diagnostics";
import { packEncoderInput, resizeLongestSide, scalePointToEncoderSpace, thresholdMask } from "./prepare";
import type { InteractiveSelectModelDefinition, SamPoint } from "./types";

/**
 * The encode-once, decode-per-click split every SAM-family tool is built around: encoding a
 * 1024-square image through MobileSAM's own encoder is the expensive part (hundreds of
 * milliseconds), and the whole point of the architecture is that the lightweight decoder can
 * then answer a fresh point/box in a few milliseconds against the *same* cached embedding —
 * re-encoding per click would make an interactive tool feel like anything but.
 */

export interface EncodedImage {
  readonly embeddings: MLTensor;
  readonly resizedWidth: number;
  readonly resizedHeight: number;
  readonly originalWidth: number;
  readonly originalHeight: number;
}

export interface InteractiveSelectSessions {
  readonly encoder: MLSession;
  readonly decoder: MLSession;
}

export function verifyEncoderSession(session: Pick<MLSession, "inputNames" | "outputNames">): string | null {
  if (!session.inputNames.includes("input_image")) return `expects input "input_image", the model has ${session.inputNames.map((name) => `"${name}"`).join(", ")}`;
  if (!session.outputNames.includes("image_embeddings")) return `expects output "image_embeddings", the model has ${session.outputNames.map((name) => `"${name}"`).join(", ")}`;
  return null;
}

export function verifyDecoderSession(session: Pick<MLSession, "inputNames" | "outputNames">): string | null {
  const expected = ["image_embeddings", "point_coords", "point_labels", "mask_input", "has_mask_input", "orig_im_size"];
  const missing = expected.filter((name) => !session.inputNames.includes(name));
  if (missing.length) return `expects input(s) ${missing.map((name) => `"${name}"`).join(", ")}, the model has ${session.inputNames.map((name) => `"${name}"`).join(", ")}`;
  if (!session.outputNames.includes("masks")) return `expects output "masks", the model has ${session.outputNames.map((name) => `"${name}"`).join(", ")}`;
  return null;
}

/**
 * `platform.ml.load` (`onnxRuntime.ts`) builds a brand new `InferenceSession` on every call —
 * the model *weights* are cached (`ModelStore`), but parsing a 28 MB graph into a running WASM/
 * WebGPU session is not free, and this tool calls into it on every click of an interactive
 * session. Cached here, once per model id, for the lifetime of the tab — the same reasoning
 * `Scene3DOrbitGizmo`'s own persistent live session exists for on the 3D side (that module's own
 * doc comment: "not create-render-readPixels-dispose on every change").
 */
const sessionCache = new Map<string, Promise<InteractiveSelectSessions | { error: string }>>();

export function loadInteractiveSelectSessions(
  model: InteractiveSelectModelDefinition,
  options: { signal?: AbortSignal; onConsent?: (spec: ModelSpec) => boolean | Promise<boolean> } = {},
): Promise<InteractiveSelectSessions | { error: string }> {
  const cached = sessionCache.get(model.id);
  if (cached) return cached;
  const loading = (async (): Promise<InteractiveSelectSessions | { error: string }> => {
    try {
      const encoder = await kernel.platform.ml.load(model.encoderSpec, options);
      const decoder = await kernel.platform.ml.load(model.decoderSpec, options);
      const encoderMismatch = verifyEncoderSession(encoder);
      if (encoderMismatch) return { error: `${model.id} encoder ${encoderMismatch}` };
      const decoderMismatch = verifyDecoderSession(decoder);
      if (decoderMismatch) return { error: `${model.id} decoder ${decoderMismatch}` };
      return { encoder, decoder };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  })();
  sessionCache.set(model.id, loading);
  // A failed load must not stay cached forever — the next click should get a fresh attempt
  // (the model store might retry a transient network failure), not the same cached rejection.
  void loading.then((result) => { if ("error" in result && result.error) sessionCache.delete(model.id); });
  return loading;
}

export async function encodeImage(
  sessions: InteractiveSelectSessions,
  model: InteractiveSelectModelDefinition,
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  signal?: AbortSignal,
): Promise<EncodedImage | { error: string }> {
  diagnostic("info", "ml.interactiveSelect", `${model.id}: encoding ${width}×${height}`);
  try {
    const resized = resizeLongestSide(pixels, width, height, model.encoderInputSize);
    const data = packEncoderInput(resized.pixels, resized.width, resized.height);
    const outputs = await sessions.encoder.run({ input_image: { data, dims: [resized.height, resized.width, 3] } }, signal ? { signal } : {});
    const embeddings = outputs.image_embeddings;
    if (!embeddings) return { error: `${model.id}: "image_embeddings" missing from the encoder's own output` };
    return { embeddings, resizedWidth: resized.width, resizedHeight: resized.height, originalWidth: width, originalHeight: height };
  } catch (error) {
    if (error instanceof Error && (error.name === "AbortError" || error.name === "InferenceCancelledError")) return { error: "" };
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export async function decodeMask(
  sessions: InteractiveSelectSessions,
  model: InteractiveSelectModelDefinition,
  encoded: EncodedImage,
  points: readonly SamPoint[],
  signal?: AbortSignal,
): Promise<Uint8ClampedArray | { error: string }> {
  if (!points.length) return new Uint8ClampedArray(encoded.originalWidth * encoded.originalHeight);
  try {
    const scaled = points.map((point) => scalePointToEncoderSpace(point, encoded.originalWidth, encoded.originalHeight, model.encoderInputSize));
    const coords = new Float32Array(scaled.length * 2);
    const labels = new Float32Array(scaled.length);
    scaled.forEach((point, index) => { coords[index * 2] = point.x; coords[index * 2 + 1] = point.y; labels[index] = point.label; });

    const outputs = await sessions.decoder.run({
      image_embeddings: encoded.embeddings,
      point_coords: { data: coords, dims: [1, scaled.length, 2] },
      point_labels: { data: labels, dims: [1, scaled.length] },
      mask_input: { data: new Float32Array(256 * 256), dims: [1, 1, 256, 256] },
      has_mask_input: { data: new Float32Array([0]), dims: [1] },
      orig_im_size: { data: new Float32Array([encoded.originalHeight, encoded.originalWidth]), dims: [2] },
    }, signal ? { signal } : {});

    const masks = outputs.masks;
    if (!masks) return { error: `${model.id}: "masks" missing from the decoder's own output` };
    return thresholdMask(masks.data, encoded.originalWidth, encoded.originalHeight);
  } catch (error) {
    if (error instanceof Error && (error.name === "AbortError" || error.name === "InferenceCancelledError")) return { error: "" };
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
