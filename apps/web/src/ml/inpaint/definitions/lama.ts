import type { InpaintModelDefinition } from "../types";

/**
 * LaMa — resolution-robust large-mask inpainting (WACV 2022), the Carve ONNX
 * export of `big-lama`.
 *
 * The good one, and the big one: 208 MB. Where MI-GAN smears a large hole,
 * LaMa's Fourier convolutions carry structure across it — straight edges stay
 * straight, repeating texture keeps repeating.
 *
 * Two separate tensors, image scaled to 0..1, and a mask where **1 means
 * fill** — the opposite of MI-GAN's.
 */
export default {
  id: "lama",
  label: { en: "LaMa (better, 208 MB)", ru: "LaMa (лучше, 208 МБ)" },
  spec: {
    id: "lama-fp32",
    url: "/models/lama-fp32.onnx",
    sizeBytes: 208_044_816,
    inputShape: [1, 3, 512, 512],
    licence: "Apache-2.0 (export); big-lama weights are non-commercial",
    commercialUse: false,
  },
  input: {
    kind: "separate",
    imageName: "image",
    maskName: "mask",
    maskMeans: "one-is-fill",
    imageRange: "0..1",
  },
  // The standard LaMa export returns 0..255 rather than a normalised range,
  // and this one does: the session reports inputs `image`, `mask`, and a real
  // run came back min 98, max 200 — plainly bytes, not a normalised range.
  output: { range: "0..255" },
  size: 512,
} satisfies InpaintModelDefinition as InpaintModelDefinition;
