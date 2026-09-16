import { imageToTensor, maskToRgba, resampleRgba, rgbaToMaskChannel, tensorToImage } from "@vravio/env-raster";
import { throwIfAborted, type MLSession } from "@vravio/kernel";
import { kernel } from "../../kernel";
import { diagnostic } from "../../diagnostics";
import { cropRgba, placeTileOutput, planTiles } from "./prepare";
import type { UpscaleModelDefinition } from "./types";

/**
 * Runs a super-resolution model over a whole image and returns it enlarged.
 *
 * Structurally `ml/segment/run.ts`'s sibling: load the model, verify the file
 * actually has the input/output the spec claims, run, convert back. What
 * differs is the shape of the work — no fixed square to resample into, and
 * a result too big to risk computing in one allocation, so `prepare.ts`'s
 * tiling sits between load and convert.
 */

export interface UpscaleOutcome {
  readonly pixels: Uint8ClampedArray | null;
  readonly width: number;
  readonly height: number;
  readonly error: string | null;
}

/** Same reasoning as `ml/inpaint/run.ts`'s `verifyAgainstSession`: the spec is
 * written from reading the model's own export, but the file is the truth. */
export function verifyUpscaleSession(model: UpscaleModelDefinition, session: Pick<MLSession, "inputNames" | "outputNames">): string | null {
  if (session.inputNames.length !== 1) return `expects exactly one input, the model has ${session.inputNames.length} (${session.inputNames.join(", ")})`;
  if (session.outputNames.length !== 1) return `expects exactly one output, the model has ${session.outputNames.length} (${session.outputNames.join(", ")})`;
  return null;
}

export async function runUpscale(
  model: UpscaleModelDefinition,
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  options: { signal?: AbortSignal; onConsent?: (spec: UpscaleModelDefinition["spec"]) => boolean | Promise<boolean> } = {},
): Promise<UpscaleOutcome> {
  if (width < 1 || height < 1) return { pixels: null, width: 0, height: 0, error: null };
  const scale = model.scale;
  const outWidth = width * scale, outHeight = height * scale;
  diagnostic("info", "ml.upscale", `${model.id}: upscaling ${width}×${height} to ${outWidth}×${outHeight}`);

  let session: MLSession;
  try {
    session = await kernel.platform.ml.load(model.spec, {
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.onConsent ? { onConsent: options.onConsent } : {}),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") return { pixels: null, width: 0, height: 0, error: null };
    return { pixels: null, width: 0, height: 0, error: error instanceof Error ? error.message : String(error) };
  }

  const mismatch = verifyUpscaleSession(model, session);
  if (mismatch) {
    diagnostic("error", "ml.upscale", `${model.id} ${mismatch}`);
    return { pixels: null, width: 0, height: 0, error: `${model.id}: ${mismatch}` };
  }

  try {
    // Alpha means nothing to a network trained on opaque photographs (the
    // same reasoning `ml/inpaint/prepare.ts`'s own comment gives) — resized
    // on its own, the ordinary way every other pixel resize in this project
    // resizes, rather than run through the model as a fourth channel it was
    // never trained to expect.
    const upscaledAlpha = rgbaToMaskChannel(resampleRgba(maskToRgba(rgbaToMaskChannel(pixels, 3)), width, height, outWidth, outHeight));

    const tile = model.spec.tile ?? { size: Math.max(width, height), overlap: 0 };
    const plans = planTiles(width, height, tile);
    const output = new Uint8ClampedArray(outWidth * outHeight * 4);
    for (const plan of plans) {
      throwIfAborted(options.signal);
      const cropped = cropRgba(pixels, width, { x: plan.padX, y: plan.padY, width: plan.padWidth, height: plan.padHeight });
      const tensor = imageToTensor(cropped, plan.padWidth, plan.padHeight, { channels: 3 });
      const outputs = await session.run({ [session.inputNames[0]!]: tensor }, options.signal ? { signal: options.signal } : {});
      const outTensor = outputs[session.outputNames[0]!];
      if (!outTensor) return { pixels: null, width: 0, height: 0, error: `${model.id}: output "${session.outputNames[0]}" missing from the result` };
      const tileImage = tensorToImage(outTensor, plan.padWidth * scale, plan.padHeight * scale, { channels: 3 });
      placeTileOutput(output, outWidth, outHeight, tileImage, plan, scale);
    }

    for (let pixel = 0; pixel < outWidth * outHeight; pixel += 1) output[pixel * 4 + 3] = upscaledAlpha[pixel]!;
    return { pixels: output, width: outWidth, height: outHeight, error: null };
  } catch (error) {
    if (error instanceof Error && (error.name === "AbortError" || error.name === "InferenceCancelledError")) return { pixels: null, width: 0, height: 0, error: null };
    return { pixels: null, width: 0, height: 0, error: error instanceof Error ? error.message : String(error) };
  }
}
