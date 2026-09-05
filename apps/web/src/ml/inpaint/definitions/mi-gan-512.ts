import type { InpaintModelDefinition } from "../types";

/**
 * MI-GAN 512, trained on Places2 (Picsart, ICCV 2023).
 *
 * The cheap one: 29 MB against LaMa's 208, designed to run on a phone. Good
 * for small removals; on large holes it invents less convincingly than LaMa.
 *
 * Its input is one packed tensor, not two — mask in channel 0 biased by -0.5,
 * RGB in channels 1..3 scaled to -1..1 and multiplied by the mask so the hole
 * arrives as zero. And its mask is the opposite way round from LaMa's: here 1
 * means *keep*. Getting that backwards does not fail; it repaints everything
 * you did not select.
 */
export default {
  id: "mi-gan-512",
  label: { en: "MI-GAN 512 (fast)", ru: "MI-GAN 512 (быстрая)" },
  spec: {
    id: "mi-gan-512-places2",
    // Fetched rather than shipped. `ModelStore` was built for this: it asks
    // consent before pulling tens of megabytes, reports progress, and caches
    // the result in Cache Storage so it happens once per browser.
    //
    // Not a preference — a constraint. Anything in `publicDir` is copied
    // verbatim into `dist`, which took the build from 78 MB to 315 MB; and
    // GitHub refuses any file over 100 MB, so the 208 MB LaMa weights could
    // never be served from Pages at all. A desktop build can bundle them and
    // point this at a local path instead.
    url: "https://huggingface.co/lxfater/inpaint-web/resolve/main/migan.onnx",
    sizeBytes: 29_541_096,
    inputShape: [1, 4, 512, 512],
    licence: "MIT (Picsart AI Research)",
    commercialUse: true,
  },
  input: {
    kind: "packed-mask-first",
    name: "input",
    maskBias: -0.5,
    maskMeans: "one-is-keep",
    imageRange: "-1..1",
    premultiply: true,
  },
  // Verified against the file rather than taken on trust: the loaded session
  // reports one input named `input` and one output `1x3x512x512`, and a real
  // run came back min -1.278, max 0.677 — a tanh-ish -1..1, not 0..255.
  output: { range: "-1..1" },
  size: 512,
} satisfies InpaintModelDefinition as InpaintModelDefinition;
