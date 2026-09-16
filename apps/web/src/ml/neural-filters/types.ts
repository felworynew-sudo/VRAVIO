import type { ModelSpec } from "@vravio/kernel";
import type { LocalizedText } from "../../i18n";

/**
 * Filter → Neural Filters (docs/master-plan.md §52.9) — a shared home for every neural filter,
 * the way the owner's own Photoshop screenshot showed: a category list on the left (each entry
 * with a cloud-download badge before its weights are cached), a live before/after preview in the
 * middle, and that filter's own settings on the right.
 *
 * Deliberately thin, not a second model-loading layer: each filter wraps whatever `ml/*` module
 * already does the real work (`ml/segment/run.ts` for this first one) — this type only adds what
 * the panel itself needs to list, badge and run a filter generically, not another copy of
 * `verifyXSession`/tensor-packing/etc., which stays where the model-specific knowledge already
 * lives.
 */
export interface NeuralFilterDefinition {
  readonly id: string;
  readonly category: LocalizedText;
  readonly label: LocalizedText;
  readonly note?: LocalizedText;
  /** Every `ModelSpec` this filter needs downloaded before it can run — usually one, two for a
   * SAM-shaped encoder/decoder pair. Summed for the panel's own size badge. */
  readonly specs: readonly ModelSpec[];
  /** Whether every spec above is already cached — the panel's cloud-download badge reads this
   * rather than assuming: a filter already used elsewhere in the app (Remove Background's own
   * Quick Action, say) should not ask again just because this is a different door to it. */
  isCached(): Promise<boolean>;
  /**
   * Runs the filter on one layer's own pixels, same width/height in and out — every filter this
   * panel hosts edits the *current layer* in place (the panel's own "Output: Current Layer"
   * picker, `docs/master-plan.md` §52.9's own note that this pass has only one target), so a
   * filter that changes canvas size (Real-ESRGAN's own standalone dialog, `GenerativeUpscaleDialog.tsx`)
   * or produces a selection rather than pixels (Object Selection) does not fit this contract and
   * is not one of this panel's entries — both already have their own, better-fitting home.
   */
  run(pixels: Uint8ClampedArray, width: number, height: number, options: { signal?: AbortSignal; onConsent?: (spec: ModelSpec) => boolean | Promise<boolean> }): Promise<{ pixels: Uint8ClampedArray; error: null } | { pixels: null; error: string }>;
}

export type NeuralFilterModule = { default: NeuralFilterDefinition };
