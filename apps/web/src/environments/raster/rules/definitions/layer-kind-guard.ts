import type { RasterRule } from "../types";

/**
 * A pixel edit may only land on a layer that is made of pixels.
 *
 * A text or adjustment layer carries a cached preview of what its data renders
 * to; writing into that buffer desyncs the picture from the data it is drawn
 * from, silently, and the next re-render throws the edit away. Replaces the
 * `RASTER_ONLY_TOOLS` set that used to answer this question in
 * `RasterWorkspace.tsx`'s pointer handler.
 *
 * The pointer handler still asks first — it can offer to rasterize the layer,
 * which is the useful answer, and it can do that before the stroke rather than
 * after. This is the half that holds when a tool forgets to ask: refusing at
 * the door is the guarantee, offering the dialog is the courtesy.
 *
 * A mask is pixels whatever the layer's own kind is, which is why editing one
 * is exempt — the same exemption the pointer handler's `maskTarget` already
 * made.
 */
const layerKindGuard: RasterRule = {
  id: "layer-kind-guard",
  order: 10,
  applies: (edit) => edit.target === "pixels",
  transform: (edit, context) => (context.layer && context.layer.kind !== "pixel" ? null : edit),
};

export default layerKindGuard;
