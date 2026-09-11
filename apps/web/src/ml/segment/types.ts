import type { ModelSpec } from "@vravio/kernel";
import type { LocalizedText } from "../../i18n";

/**
 * How a salient-object segmentation model wants to be fed, and where to find
 * its answer.
 *
 * Declarative, same reasoning as `ml/inpaint/types.ts`'s `InpaintInputContract`:
 * these numbers come from reading the model's own preprocessing code (or, for
 * u2netp, from the `rembg` project's actual `normalize()`/`predict()`), not
 * from a general impression of "how ONNX vision models usually work" — and a
 * model that returns several output heads (u2net's architecture fuses six
 * side outputs into a seventh) has a specific one that is the real answer,
 * not necessarily the one an export happens to name first.
 *
 * `outputIndex` is positional rather than by name on purpose: u2netp's own
 * ONNX export (traced from PyTorch, not hand-authored) names its seven
 * outputs as opaque graph-node ids ("1959".."1965") that mean nothing and
 * are not guaranteed stable across a re-export or a different mirror of the
 * same weights — verified directly against the loaded file this session, not
 * assumed. Reading `session.outputNames[outputIndex]` at run time, the way
 * `run.ts` does, survives that; a literal name would not.
 */
export interface SegmentModelDefinition {
  readonly id: string;
  readonly label: LocalizedText;
  /** What the model store needs to fetch, cache and ask consent for. */
  readonly spec: ModelSpec;
  /** Per-channel ImageNet-style normalization, applied after scaling 0..255 to 0..1. */
  readonly input: { readonly mean: readonly number[]; readonly std: readonly number[] };
  /** The model runs at a fixed square; the image is resampled to it and the mask resampled back. */
  readonly size: number;
  /** Which of the model's output tensors, by position, is the final fused mask. */
  readonly outputIndex: number;
  /** Shown next to the action, because a licence is something to know before downloading. */
  readonly note?: LocalizedText;
}

export type SegmentModelModule = { default: SegmentModelDefinition };
