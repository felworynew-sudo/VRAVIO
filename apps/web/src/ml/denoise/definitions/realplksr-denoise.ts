import type { DenoiseModelDefinition } from "../types";

/**
 * RealPLKSR "1x DeNoise" — docs/master-plan.md §52.6, the model the owner's
 * own PMRID pick turned out not to fit: PMRID wants raw Bayer sensor data
 * plus noise-level metadata, which this codebase's LibRaw-based RAW pipeline
 * already demosaics away before the app ever sees pixels (no code path
 * carries either back to a filter). This is the rescoped replacement — an
 * RGB-domain real-world photo denoiser, one engine behind both "Filter →
 * Noise → AI Denoise" and Camera Raw's own Detail panel, not two.
 *
 * Weights: trained by Philip Hofmann (`Phhofm/models`, GitHub) on the
 * Nomosv2 dataset with the real-esrgan-otf degradation pipeline — real-world
 * noise, not one fixed synthetic sigma, matching "AI Denoise" as a single
 * general-purpose button rather than a per-noise-level picker. Licence
 * confirmed on the model's own OpenModelDB listing
 * (openmodeldb.info/models/1x-DeNoise-realplksr-otf): CC-BY-4.0, commercial
 * use permitted with attribution. The author's own Hugging Face repo
 * (`Phips/1xDeNoise_realplksr_otf`) only holds the `.safetensors` checkpoint;
 * the ONNX export used here is a third-party conversion
 * (`notaneimu/onnx-image-models`) — no second, independently-converted ONNX
 * mirror of the same weights was found, the same single-source situation
 * `ml/interactive-select/definitions/mobile-sam.ts`'s own comment documents,
 * recorded honestly rather than assumed identical to the original.
 * Confirmed real by HTTP HEAD (`Content-Length` / `X-Linked-Size` both
 * 29,874,321 bytes) and downloaded whole to check that byte count matches on
 * disk before relying on it — and, learned the hard way in this exact
 * session (§52.7's own NAFNet finding), by `curl -H "Origin: ..."` for
 * `Access-Control-Allow-Origin`: Hugging Face's CDN reflects it, so this
 * file is actually fetchable from a browser, unlike NAFNet's Google Cloud
 * Storage bucket.
 *
 * Contract read from the loaded graph (`onnx` Python package), not
 * documentation: one input `input` `[batch,3,H,W]`, dynamic and fully
 * convolutional — no `Pad`/`Mod` node anywhere in the graph, so unlike
 * NAFNet this model has no internal-multiple requirement to pad for or
 * around, and no fixed square to resample to and back the way segmentation
 * needs. First nodes run straight into `Conv` with no `Sub`/`Div` beforehand,
 * confirming plain 0..1 RGB with no mean/std normalization — the existing
 * `imageToTensor`/`tensorToImage` helpers (already built for Real-ESRGAN and
 * reused for NAFNet's own attempt) apply here unchanged, zero new tensor
 * code. The one output `output` is the same shape as the input; its last
 * node is `DepthToSpace` with `blocksize=1` (a true no-op reshape at this
 * model's 1x scale, not an upscale) rather than a final `Clip`, so output
 * clamping stays the caller's job, already handled by `tensorToImage`.
 *
 * `tile` — found necessary live, not assumed up front: a first full-frame
 * run at 1920×1080 threw `OrtRun() ... std::bad_alloc` from the WASM
 * backend — this fully-convolutional net's intermediate activations scale
 * with pixel count same as Real-ESRGAN's own (`ml/upscale/prepare.ts`'s doc
 * comment), so it needs the same tiling, reusing that exact
 * `planTiles`/`cropRgba`/`placeTileOutput` math with `scale: 1` rather than
 * a second copy of it. Same tile size as Real-ESRGAN's own spec — a value
 * already proven not to blow the WASM heap on this machine, not a guess.
 */
export default {
  id: "realplksr-denoise",
  label: { en: "AI Denoise — RealPLKSR", ru: "ИИ подавление шума — RealPLKSR" },
  note: {
    en: "Real-world photo noise, trained by Philip Hofmann (Nomosv2 dataset) — not a fixed noise level.",
    ru: "Реальный шум фотографий, обучена Philip Hofmann (датасет Nomosv2) — не фиксированный уровень шума.",
  },
  spec: {
    id: "1x-denoise-realplksr-otf",
    url: "https://huggingface.co/notaneimu/onnx-image-models/resolve/main/1xDeNoise_realplksr_otf_fp32.onnx",
    sizeBytes: 29_874_321,
    inputShape: [1, 3, -1, -1],
    tile: { size: 256, overlap: 16 },
    licence: "CC-BY-4.0 (Philip Hofmann / Phhofm)",
    commercialUse: true,
  },
} satisfies DenoiseModelDefinition as DenoiseModelDefinition;
