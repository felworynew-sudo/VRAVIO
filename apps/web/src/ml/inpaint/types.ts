import type { ModelSpec } from "@vravio/kernel";
import type { LocalizedText } from "../../i18n";

/**
 * How an inpainting model wants to be fed.
 *
 * Declarative data rather than a branch per model, because this is exactly
 * where the knowledge is uncertain and version-dependent: two exports of the
 * *same* architecture can disagree about value range and mask polarity, and
 * getting either wrong produces a plausible-looking wrong answer rather than
 * an error. Written down here, a correction is one line in one file; written
 * into a preprocessing function, it is a bug hunt.
 *
 * `verifyAgainstSession` in `run.ts` checks these claims against the model
 * actually loaded, so a spec that has drifted from its file is a message
 * naming the mismatch instead of a silently mangled picture.
 */
export type InpaintInputContract =
  /**
   * One tensor carrying mask and image together, mask channel first.
   *
   * MI-GAN's shape: channel 0 is `mask + maskBias`, channels 1..3 are RGB
   * scaled into `imageRange` and multiplied by the mask, so the hole arrives
   * as zero rather than as whatever was there.
   */
  | {
      readonly kind: "packed-mask-first";
      readonly name: string;
      readonly maskBias: number;
      readonly maskMeans: MaskMeaning;
      readonly imageRange: ValueRange;
      readonly premultiply: boolean;
    }
  /** Two tensors, the shape LaMa and most other exports use. */
  | {
      readonly kind: "separate";
      readonly imageName: string;
      readonly maskName: string;
      readonly maskMeans: MaskMeaning;
      readonly imageRange: ValueRange;
    };

/**
 * Which way round the mask is.
 *
 * The single most common way to get inpainting wrong, and it fails silently:
 * with the polarity inverted the model faithfully repaints everything you did
 * *not* select and leaves the watermark alone. LaMa reads 1 as "fill this";
 * MI-GAN reads 1 as "keep this".
 */
export type MaskMeaning = "one-is-fill" | "one-is-keep";

export type ValueRange = "0..1" | "-1..1";
export type OutputRange = ValueRange | "0..255";

export interface InpaintModelDefinition {
  readonly id: string;
  readonly label: LocalizedText;
  /** What the model store needs to fetch, cache and ask consent for. */
  readonly spec: ModelSpec;
  readonly input: InpaintInputContract;
  readonly output: {
    /** Left unset when the export names its output something unpredictable;
     * the runner then takes the only output there is. */
    readonly name?: string;
    readonly range: OutputRange;
  };
  /**
   * The side of the square the model runs at. Every model here is fixed-size:
   * the region is cut out, scaled to this, filled, and scaled back.
   */
  readonly size: number;
  /** Shown next to the model in the brush options, because a licence that
   * forbids commercial use is something a user must know *before* choosing. */
  readonly note?: LocalizedText;
}

export type InpaintModelModule = { default: InpaintModelDefinition };
