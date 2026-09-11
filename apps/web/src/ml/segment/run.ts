import { imageToTensor, maskToRgba, resampleRgba, rgbaToMaskChannel, tensorToMask } from "@vravio/env-raster";
import type { MLSession } from "@vravio/kernel";
import { kernel } from "../../kernel";
import { diagnostic } from "../../diagnostics";
import type { SegmentModelDefinition } from "./types";

/**
 * Runs a salient-object segmentation model over a whole image and returns a
 * soft alpha mask the same size as the input.
 *
 * Structurally the inpainting pipeline's sibling (`ml/inpaint/run.ts`): load
 * the model, verify the file actually has the input the spec claims, resample
 * to the model's fixed square, run, resample the answer back. The difference
 * is what goes in and what comes back — the whole image rather than a marked
 * region, and a soft mask rather than filled pixels — so this does not share
 * code with it beyond the same generic `resampleRgba`/`imageToTensor`/
 * `tensorToMask` building blocks in `@vravio/env-raster`.
 *
 * The mask comes back at bilinear-resampled quality on purpose (round-tripped
 * through `maskToRgba`/`resampleRgba`/`rgbaToMaskChannel`, the same generic
 * RGBA resizer everything else in this codebase resizes pixels with) — unlike
 * `ml/inpaint/prepare.ts`'s own `resampleMask`, which nearest-neighbour
 * thresholds on purpose because a *user-drawn* hole is a decision, not a
 * picture. A segmentation model's own output is already a picture — a soft
 * saliency map with genuine partial values at hair and fuzzy edges — and
 * thresholding it here would throw that away before "Remove Background" or
 * "Select Subject" ever got to use it.
 */

export interface SegmentOutcome {
  readonly mask: Uint8ClampedArray | null;
  readonly error: string | null;
}

/** Same reasoning as `ml/inpaint/run.ts`'s `verifyAgainstSession`: the spec is
 * written from reading the model's own export, but the file is the truth. */
export function verifySegmentSession(model: SegmentModelDefinition, session: Pick<MLSession, "inputNames" | "outputNames">): string | null {
  if (session.inputNames.length !== 1) return `expects exactly one input, the model has ${session.inputNames.length} (${session.inputNames.join(", ")})`;
  if (model.outputIndex >= session.outputNames.length) return `expects output index ${model.outputIndex}, the model has ${session.outputNames.length} output(s)`;
  return null;
}

export async function runSegmentation(
  model: SegmentModelDefinition,
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  options: { signal?: AbortSignal; onConsent?: (spec: SegmentModelDefinition["spec"]) => boolean | Promise<boolean> } = {},
): Promise<SegmentOutcome> {
  if (width < 1 || height < 1) return { mask: null, error: null };
  diagnostic("info", "ml.segment", `${model.id}: segmenting ${width}×${height}`);

  let session: MLSession;
  try {
    session = await kernel.platform.ml.load(model.spec, {
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.onConsent ? { onConsent: options.onConsent } : {}),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") return { mask: null, error: null };
    return { mask: null, error: error instanceof Error ? error.message : String(error) };
  }

  const mismatch = verifySegmentSession(model, session);
  if (mismatch) {
    diagnostic("error", "ml.segment", `${model.id} ${mismatch}`);
    return { mask: null, error: `${model.id}: ${mismatch}` };
  }

  try {
    const scaled = resampleRgba(pixels, width, height, model.size, model.size);
    const tensor = imageToTensor(scaled, model.size, model.size, { channels: 3, mean: model.input.mean, std: model.input.std });
    const outputs = await session.run({ [session.inputNames[0]!]: tensor }, options.signal ? { signal: options.signal } : {});
    const outputTensor = outputs[session.outputNames[model.outputIndex]!];
    if (!outputTensor) return { mask: null, error: `${model.id}: output "${session.outputNames[model.outputIndex]}" missing from the result` };

    const smallMask = tensorToMask(outputTensor, model.size, model.size, { normalize: true });
    const maskAtInputSize = rgbaToMaskChannel(resampleRgba(maskToRgba(smallMask), model.size, model.size, width, height));
    return { mask: maskAtInputSize, error: null };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") return { mask: null, error: null };
    return { mask: null, error: error instanceof Error ? error.message : String(error) };
  }
}
