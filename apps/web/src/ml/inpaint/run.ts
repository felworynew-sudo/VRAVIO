import { resampleRgba } from "@vravio/env-raster";
import type { MLSession, MLTensor } from "@vravio/kernel";
import { kernel } from "../../kernel";
import { diagnostic } from "../../diagnostics";
import { buildInpaintInput, compositeInpaint, cropMask, cropRgba, readInpaintOutput, regionForMask, resampleMask } from "./prepare";
import type { InpaintModelDefinition } from "./types";

/**
 * Fills a marked region using a model.
 *
 * The whole pipeline in one place: find the region, cut it out, scale it to
 * the model's square, run, scale back, and paste only what was marked. Each
 * step is a tested pure function in `prepare.ts`; this arranges them and
 * handles the parts that touch the world — loading the model, cancelling, and
 * saying clearly when the file does not match what the spec claims.
 */

export interface InpaintOutcome {
  readonly pixels: Uint8ClampedArray | null;
  readonly error: string | null;
}

/**
 * Checks the spec's claims against the model that actually loaded.
 *
 * The spec is written from documentation and from reading other people's
 * pipelines; the file is the truth. Feeding a model tensors under names it
 * does not have fails loudly at `run`, but feeding it the *right* names with
 * the wrong polarity or range does not fail at all — it returns a confidently
 * wrong picture. Names are what can be checked cheaply, so they are, and a
 * mismatch is reported with both sides named rather than left to surface as
 * "the brush does nothing useful".
 */
export function verifyAgainstSession(model: InpaintModelDefinition, session: Pick<MLSession, "inputNames">): string | null {
  const expected = model.input.kind === "packed-mask-first" ? [model.input.name] : [model.input.imageName, model.input.maskName];
  const missing = expected.filter((name) => !session.inputNames.includes(name));
  if (!missing.length) return null;
  return `expects input(s) ${missing.map((name) => `"${name}"`).join(", ")}, but the model has ${session.inputNames.map((name) => `"${name}"`).join(", ")}`;
}

/** The only output, or the one the spec names. */
function outputTensor(model: InpaintModelDefinition, outputs: Record<string, MLTensor>): MLTensor | null {
  if (model.output.name) return outputs[model.output.name] ?? null;
  const values = Object.values(outputs);
  return values.length === 1 ? values[0]! : null;
}

export async function runInpaint(
  model: InpaintModelDefinition,
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  mask: Uint8ClampedArray,
  options: { signal?: AbortSignal; onConsent?: (spec: InpaintModelDefinition["spec"]) => boolean | Promise<boolean> } = {},
): Promise<InpaintOutcome> {
  const region = regionForMask(mask, width, height);
  // Nothing marked is not a failure; it is a gesture that touched nothing. Said
  // out loud all the same: a brush that does nothing and explains nothing is
  // indistinguishable from a broken one, which is exactly how this looked the
  // first time it was tried.
  if (!region) { diagnostic("info", "ml.inpaint", "Nothing was marked, so there was nothing to fill"); return { pixels: null, error: null }; }
  diagnostic("info", "ml.inpaint", `${model.id}: filling ${region.width}×${region.height} at ${region.x},${region.y}`);

  let session: MLSession;
  try {
    // `platform.ml.load` rather than `models.load`: the latter fetches the
    // weights, this prepares a session on whatever accelerator was probed.
    session = await kernel.platform.ml.load(model.spec, {
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.onConsent ? { onConsent: options.onConsent } : {}),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") return { pixels: null, error: null };
    return { pixels: null, error: error instanceof Error ? error.message : String(error) };
  }

  const mismatch = verifyAgainstSession(model, session);
  if (mismatch) {
    diagnostic("error", "ml.inpaint", `${model.id} ${mismatch}`);
    return { pixels: null, error: `${model.id}: ${mismatch}` };
  }

  try {
    const cropped = cropRgba(pixels, width, region);
    const croppedMask = cropMask(mask, width, region);
    const scaled = resampleRgba(cropped, region.width, region.height, model.size, model.size);
    const scaledMask = resampleMask(croppedMask, region.width, region.height, model.size);

    const outputs = await session.run(buildInpaintInput(scaled, scaledMask, model), options.signal ? { signal: options.signal } : {});
    const tensor = outputTensor(model, outputs);
    if (!tensor) return { pixels: null, error: `returned ${Object.keys(outputs).length} outputs and the spec names none` };

    const filledSquare = readInpaintOutput(tensor, model, scaled);
    const filledRegion = resampleRgba(filledSquare, model.size, model.size, region.width, region.height);
    return { pixels: compositeInpaint(pixels, width, height, filledRegion, mask, region), error: null };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") return { pixels: null, error: null };
    return { pixels: null, error: error instanceof Error ? error.message : String(error) };
  }
}
