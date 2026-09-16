import type { UpscaleModelDefinition } from "../types";

/**
 * Real-ESRGAN "general-x4v3" — the `SRVGGNetCompact` checkpoint the owner
 * named directly (docs/master-plan.md §52.3), chosen over the heavier
 * `RRDBNet` checkpoints in the same project specifically for being small and
 * fast enough to run in a browser tab: "~4.7–5 МБ", "лёгкое
 * восстановление/шумодав", not the highest possible fidelity.
 *
 * Weights: mirrored on Hugging Face (`OwlMaster/AllFilesRope`, a public
 * re-upload of the original `xinntao/Real-ESRGAN` release conversion) —
 * fetch-not-ship, the same reasoning `mi-gan-512.ts`'s own comment gives
 * (this project's `publicDir` is `icons/`, and GitHub Pages refuses files
 * over 100 MB regardless). Confirmed byte-identical across two independent
 * mirrors before relying on either (`Content-Length` / `X-Linked-ETag` both
 * 4,871,181 bytes, SHA-256 `09b757accd747d7e423c1d352b3e8f23e77cc5742d04bae958d4eb8082b76fa4`,
 * matching `OwlMaster/AllFilesRope` and `MonsterMMORPG/Wan_GGUF`) — a silent
 * re-encode of the weights on one mirror would not throw, it would just
 * upscale worse.
 *
 * Contract read from the loaded graph, not documentation (`onnx` Python
 * package, this session — no onnxruntime-web available outside a browser to
 * check the same thing from Node): one input named `input`, one output named
 * `output`, both `[batch, 3, height, width]` with symbolic (dynamic) spatial
 * dims — the network is fully convolutional (34 `Conv`+`PRelu` pairs, no
 * fixed-size layer), so it takes whatever height/width it is given rather
 * than a fixed square the way U²-Net-P or the inpainting models do. The
 * final three nodes are `DepthToSpace` (`blocksize=4`, confirming the ×4
 * scale), `Resize`+`Add` (the architecture's own nearest-neighbour-upsampled
 * residual shortcut, `SRVGGNetCompact.forward()`'s `out += base`), and a
 * `Clip(0, 1)` — so input and output are both plain 0..1, no ImageNet-style
 * mean/std, and the output needs no rescaling beyond clamping before
 * converting back to bytes.
 *
 * `tile`: this model has no fixed input size, so nothing stops a request for
 * one enormous tensor on a multi-megapixel photo — exactly the kind of
 * allocation that reliably kills a WASM/WebGPU session in a browser tab.
 * 256 with 16 pixels of overlap keeps a single tile's output (`(256+32)²×3`
 * floats in, `1024²×3` out) inside a few megabytes; `run.ts`'s tiling
 * follows `xinntao/Real-ESRGAN`'s own `RealESRGANer.tile_process` — pad each
 * tile with context, run it, then keep only the untainted centre of its
 * output — so tiles butt together with no seam to blend.
 */
export default {
  id: "real-esrgan-general-x4v3",
  label: { en: "Real-ESRGAN general x4v3 (fast)", ru: "Real-ESRGAN general x4v3 (быстрая)" },
  spec: {
    id: "real-esrgan-general-x4v3",
    url: "https://huggingface.co/OwlMaster/AllFilesRope/resolve/main/realesr-general-x4v3.onnx",
    sizeBytes: 4_871_181,
    inputShape: [1, 3, 256, 256],
    tile: { size: 256, overlap: 16 },
    licence: "BSD-3-Clause (xinntao/Real-ESRGAN)",
    commercialUse: true,
  },
  scale: 4,
} satisfies UpscaleModelDefinition as UpscaleModelDefinition;
