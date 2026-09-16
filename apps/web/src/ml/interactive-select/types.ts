import type { ModelSpec } from "@vravio/kernel";
import type { LocalizedText } from "../../i18n";

/**
 * How an interactive segmentation model (Segment Anything and its distillations) wants to be
 * fed — two models, not one: a heavy image encoder run once per image, and a light prompt
 * decoder run once per click/box against that same cached embedding.
 *
 * Point/box prompt semantics and the encoder's own preprocessing (resize the long side to
 * `encoderInputSize`, pad to a square, ImageNet mean/std baked into the graph itself) come from
 * Meta's own reference `segment-anything` ONNX export (`scripts/export_onnx_model.py` and
 * `SamOnnxModel` in that same repo) — this is the de facto standard contract every SAM
 * distillation's own ONNX export (MobileSAM included) reuses verbatim, not something guessed per
 * model. `ml/interactive-select/definitions/mobile-sam.ts` documents what was actually confirmed
 * against the loaded graph rather than assumed from that convention.
 */
export interface InteractiveSelectModelDefinition {
  readonly id: string;
  readonly label: LocalizedText;
  readonly encoderSpec: ModelSpec;
  readonly decoderSpec: ModelSpec;
  /** The square the encoder resizes/pads its input to — 1024 for every public SAM export so far. */
  readonly encoderInputSize: number;
  readonly note?: LocalizedText;
}

export type InteractiveSelectModelModule = { default: InteractiveSelectModelDefinition };

/** A single click (foreground/background) or one corner of a box, in the *original* image's own
 * pixel coordinates — `run.ts` rescales into the encoder's resized space, not the caller. */
export interface SamPoint {
  readonly x: number;
  readonly y: number;
  /** 1 = include (foreground click), 0 = exclude (background click/Alt-click), 2/3 = a box's
   * own top-left/bottom-right corner — Meta's own `point_labels` convention, not invented here. */
  readonly label: 0 | 1 | 2 | 3;
}
