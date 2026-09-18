import { imageToTensor, tensorToImage } from "@vravio/env-raster";
import { throwIfAborted, type MLSession } from "@vravio/kernel";
import { kernel } from "../../kernel";
import { diagnostic } from "../../diagnostics";
import { accumulateTileOutput, createTileAccumulator, cropRgba, finishTileAccumulator, planTiles } from "../upscale/prepare";
import type { DenoiseModelDefinition } from "./types";

/**
 * Runs a whole-image RGB denoiser and returns pixels the same size as the
 * input — the "one engine" half of docs/master-plan.md §52.6's "one engine,
 * two entry points": `NeuralFiltersDialog`'s own Filter → Noise → AI Denoise
 * entry and Camera Raw's Detail panel both call this, neither reimplements
 * it.
 *
 * Tiles through `ml/upscale/prepare.ts`'s own `planTiles`/`cropRgba`/
 * `placeTileOutput` with `scale: 1` rather than a second copy of the same
 * math: found necessary live (`definitions/realplksr-denoise.ts`'s own doc
 * comment) after a full 1920×1080 frame threw `std::bad_alloc` in the WASM
 * backend — every fully-convolutional net's intermediate activations scale
 * with pixel count the same way, denoiser or upscaler.
 */

export interface DenoiseOutcome {
  readonly pixels: Uint8ClampedArray | null;
  readonly error: string | null;
}

/** Same reasoning as `ml/inpaint/run.ts`'s `verifyAgainstSession`: the spec is
 * written from reading the model's own export, but the file is the truth. */
export function verifyDenoiseSession(model: DenoiseModelDefinition, session: Pick<MLSession, "inputNames" | "outputNames">): string | null {
  if (session.inputNames.length !== 1) return `expects exactly one input, the model has ${session.inputNames.length} (${session.inputNames.join(", ")})`;
  if (session.outputNames.length !== 1) return `expects exactly one output, the model has ${session.outputNames.length} (${session.outputNames.join(", ")})`;
  return null;
}

export async function runDenoise(
  model: DenoiseModelDefinition,
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  options: { signal?: AbortSignal; onConsent?: (spec: DenoiseModelDefinition["spec"]) => boolean | Promise<boolean> } = {},
): Promise<DenoiseOutcome> {
  if (width < 1 || height < 1) return { pixels: null, error: null };
  diagnostic("info", "ml.denoise", `${model.id}: denoising ${width}×${height}`);

  let session: MLSession;
  try {
    session = await kernel.platform.ml.load(model.spec, {
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.onConsent ? { onConsent: options.onConsent } : {}),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") return { pixels: null, error: null };
    return { pixels: null, error: error instanceof Error ? error.message : String(error) };
  }

  const mismatch = verifyDenoiseSession(model, session);
  if (mismatch) {
    diagnostic("error", "ml.denoise", `${model.id} ${mismatch}`);
    return { pixels: null, error: `${model.id}: ${mismatch}` };
  }

  try {
    const tile = model.spec.tile ?? { size: Math.max(width, height), overlap: 0 };
    const plans = planTiles(width, height, tile);
    // Blended over the overlap rather than butted together: this network looks further than its
    // context margin, so a hard join showed as a grid (see `accumulateTileOutput`).
    const accumulator = createTileAccumulator(width, height);
    for (const plan of plans) {
      throwIfAborted(options.signal);
      const cropped = cropRgba(pixels, width, { x: plan.padX, y: plan.padY, width: plan.padWidth, height: plan.padHeight });
      const tensor = imageToTensor(cropped, plan.padWidth, plan.padHeight, { channels: 3 });
      const outputs = await session.run({ [session.inputNames[0]!]: tensor }, options.signal ? { signal: options.signal } : {});
      const outTensor = outputs[session.outputNames[0]!];
      if (!outTensor) return { pixels: null, error: `${model.id}: output "${session.outputNames[0]}" missing from the result` };
      const [, , outTileHeight, outTileWidth] = outTensor.dims;
      if (outTileWidth !== plan.padWidth || outTileHeight !== plan.padHeight) {
        return { pixels: null, error: `${model.id} returned ${outTileWidth}×${outTileHeight} for a ${plan.padWidth}×${plan.padHeight} tile — expected the same size back` };
      }
      const tileImage = tensorToImage(outTensor, plan.padWidth, plan.padHeight, { channels: 3 });
      accumulateTileOutput(accumulator, tileImage, plan, 1);
    }
    const output = finishTileAccumulator(accumulator);
    for (let pixel = 0; pixel < width * height; pixel += 1) output[pixel * 4 + 3] = pixels[pixel * 4 + 3]!;
    return { pixels: output, error: null };
  } catch (error) {
    if (error instanceof Error && (error.name === "AbortError" || error.name === "InferenceCancelledError")) return { pixels: null, error: null };
    return { pixels: null, error: error instanceof Error ? error.message : String(error) };
  }
}
