import type { InteractiveSelectModelDefinition } from "../types";

/**
 * MobileSAM (Zhang et al., 2023) — a distilled, ~10x-smaller encoder trained to match the
 * original Segment Anything's own encoder output, paired with SAM's own unchanged, already-tiny
 * prompt decoder. The owner named this model directly (docs/master-plan.md §52.5, "~38.8 МБ,
 * 9.66M параметров") over MobileSAM/MODNet-style whole-image saliency models specifically because
 * it takes a click/box, not just "find the one obvious subject" (`ml/segment/definitions/u2netp.ts`
 * already covers that case).
 *
 * Weights: `Acly/MobileSAM` on Hugging Face — the image encoder and the decoder are two separate
 * files (`ml/inpaint`'s own two-model shape, not one file). Confirmed real by HTTP HEAD before
 * relying on either (`Content-Length`/`X-Linked-Size` 28,157,093 and 16,501,323 bytes). No second
 * independent mirror came back byte-identical (unlike every other model this project has sourced
 * so far) — the ONNX conversions of MobileSAM circulating publicly are re-exports from several
 * different scripts/opset versions rather than one canonical file everyone mirrors verbatim, so
 * this is the one model definition in this codebase relying on a single source's own HTTP HEAD
 * rather than a cross-check — worth knowing if this ever needs re-verifying.
 *
 * Contract read from the loaded graphs (`onnx` Python package), not documentation, which the
 * repository's own README does not provide at all:
 * - Encoder: one input `input_image`, shape `[image_height, image_width, 3]` — no batch
 *   dimension, HWC, and the *caller* resizes the long side to `encoderInputSize` (a `1024`
 *   literal appears twice in the graph, matching Meta's own SAM preprocessing) — the graph's own
 *   first four nodes are `Sub`/`Div` by `[123.675,116.28,103.53]`/`[58.395,57.12,57.375]` (exactly
 *   ImageNet mean/std × 255, confirming raw 0..255 RGB in, not 0..1) followed by a `Transpose`
 *   (HWC→CHW) and a `Pad` to the 1024×1024 square — no `Resize` node anywhere in the graph, so the
 *   long-side resize itself is the caller's job, only the padding is baked in. Output
 *   `image_embeddings`, `[1,256,64,64]`.
 * - Decoder ("single", not "multi" — one mask per call, not three ranked candidates; the owner
 *   asked for "клик → выделение", not a picker): inputs `image_embeddings` (the encoder's own
 *   output, fed straight through), `point_coords` `[1,num_points,2]`, `point_labels`
 *   `[1,num_points]`, `mask_input` `[1,1,256,256]`, `has_mask_input` `[1]`, `orig_im_size` `[2]` —
 *   exactly Meta's own reference `SamOnnxModel` export shape, which is why point labels follow its
 *   convention (1 = include, 0 = exclude, 2/3 = a box's own top-left/bottom-right corner) rather
 *   than something invented for this project. `orig_im_size` is read by the graph itself to
 *   upsample `masks` back to the original image's own resolution — `run.ts` never resizes the
 *   mask by hand.
 */
export default {
  id: "mobile-sam",
  label: { en: "MobileSAM", ru: "MobileSAM" },
  encoderSpec: {
    id: "mobile-sam-encoder",
    url: "https://huggingface.co/Acly/MobileSAM/resolve/main/mobile_sam_image_encoder.onnx",
    sizeBytes: 28_157_093,
    inputShape: [1024, 1024, 3],
    licence: "Apache-2.0 (ChaoningZhang/MobileSAM)",
    commercialUse: true,
  },
  decoderSpec: {
    id: "mobile-sam-decoder-single",
    url: "https://huggingface.co/Acly/MobileSAM/resolve/main/sam_mask_decoder_single.onnx",
    sizeBytes: 16_501_323,
    inputShape: [1, 256, 64, 64],
    licence: "Apache-2.0 (ChaoningZhang/MobileSAM)",
    commercialUse: true,
  },
  encoderInputSize: 1024,
} satisfies InteractiveSelectModelDefinition as InteractiveSelectModelDefinition;
