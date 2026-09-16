import type { ModelSpec } from "@vravio/kernel";
import type { LocalizedText } from "../../i18n";

/**
 * How an upscaling model wants to be fed, and what it hands back.
 *
 * Same reasoning as `ml/inpaint/types.ts`'s `InpaintInputContract` and
 * `ml/segment/types.ts`'s `SegmentModelDefinition`: written from reading the
 * model's own graph (`docs/master-plan.md` §52.3's own closure notes name the
 * exact nodes read), not from a general impression of how a super-resolution
 * network "usually" works.
 *
 * Unlike segmentation and inpainting, there is no fixed input square here —
 * every model in this family so far (`SRVGGNetCompact`, the architecture
 * behind Real-ESRGAN's "general" checkpoints) is fully convolutional and
 * accepts whatever height/width the image already has, which is also why
 * tiling (`spec.tile`) is what keeps a large photo from needing one gigantic
 * allocation in a browser tab.
 */
export interface UpscaleModelDefinition {
  readonly id: string;
  readonly label: LocalizedText;
  /** What the model store needs to fetch, cache and ask consent for —
   * `spec.tile` is load-bearing here, see `run.ts`'s tiling. */
  readonly spec: ModelSpec;
  /** How many times larger the output is in each dimension. */
  readonly scale: number;
  /** Shown next to the model in the dialog, because a licence is something
   * to know before downloading. */
  readonly note?: LocalizedText;
}

export type UpscaleModelModule = { default: UpscaleModelDefinition };
