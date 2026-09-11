import type { SegmentModelDefinition } from "../types";

/**
 * U²-Net-P ("portable"), Qin et al., 2020 — the lightweight salient-object
 * segmentation model docs/master-plan.md §14 names for Select Subject /
 * Remove Background, at "~5 МБ" against MobileSAM/MODNet's tens.
 *
 * Weights: the `danielgatis/rembg` project's own GitHub release
 * (`u2netp.onnx`, MD5 `8e83ca70e441ab06c318d82300c84806`, matching
 * `rembg/rembg/sessions/u2netp.py`), mirrored on Hugging Face at a
 * `resolve/main` URL so it fits this project's existing fetch-not-ship
 * pattern (see `mi-gan-512.ts`'s own comment on why — `publicDir` copies
 * anything under it verbatim into `dist`, and GitHub refuses files over
 * 100 MB regardless). Confirmed byte-identical to the official release by
 * HTTP HEAD (`Content-Length` / `X-Linked-Size` both 4,574,861) before
 * relying on it — a third-party mirror silently re-encoding the weights is
 * exactly the kind of thing that would not throw, only quietly segment
 * worse.
 *
 * Input/output verified against the actual loaded ONNX graph, not
 * documentation: loaded this file in onnxruntime-web and read
 * `session.inputNames`/`outputNames` directly — one input named `input.1`,
 * shape `[1,3,320,320]`; seven outputs, all `[1,1,320,320]`, all already
 * sigmoided into 0..1 (confirmed by running a real inference and reading
 * min/max off every one of the seven tensors). The mean/std here are the
 * original U-2-Net repo's own ImageNet normalization
 * (xuebinqin/U-2-Net → `rembg`'s `normalize()`), and output index 0 is
 * `d0` — `U2NETP.forward()`'s own source returns
 * `(sigmoid(d0), sigmoid(d1), ..., sigmoid(d6))`, where `d0` is the fusion
 * of the other six side-output heads, in that order; ONNX export from a
 * traced `forward()` preserves the tuple's order as the output list's
 * order.
 */
export default {
  id: "u2netp",
  label: { en: "U²-Net-P (lightweight)", ru: "U²-Net-P (лёгкая)" },
  spec: {
    id: "u2netp-rembg",
    url: "https://huggingface.co/Heliosoph/u2net-onnx/resolve/main/u2netp.onnx",
    sizeBytes: 4_574_861,
    inputShape: [1, 3, 320, 320],
    licence: "Apache-2.0 (xuebinqin/U-2-Net)",
    commercialUse: true,
  },
  input: { mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225] },
  size: 320,
  outputIndex: 0,
} satisfies SegmentModelDefinition as SegmentModelDefinition;
