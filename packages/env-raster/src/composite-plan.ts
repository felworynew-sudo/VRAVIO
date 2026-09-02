import { flattenRasterLayers, isLayerEffectivelyVisible } from "./layer-tree";
import type { RasterBlendMode, RasterDocumentState, RasterLayer } from "./types";

export type PixelDepth = 8 | 16 | 32;

/**
 * Where the compositing arithmetic runs.
 *
 * `canvas2d` hands the work to the browser, which does it on the GPU in
 * premultiplied 8-bit sRGB. `precise` runs our own per-channel maths over the
 * layer buffers, which is the only path that survives 16- and 32-bit documents
 * and the eleven blend modes the canvas specification never defined.
 */
export type CompositeBackend = "canvas2d" | "precise";

/**
 * Blend modes the browser compositor implements.
 *
 * The canvas specification defines the separable Porter-Duff set plus the four
 * non-separable HSL modes. Everything Photoshop added on top of that —
 * linear burn, vivid/linear/pin light, hard mix, subtract, divide, dissolve,
 * darker/lighter colour — has no canvas equivalent and must be computed.
 */
export const canvasBlendModes: ReadonlySet<RasterBlendMode> = new Set<RasterBlendMode>([
  "normal", "darken", "multiply", "colorBurn", "lighten", "screen", "colorDodge",
  "overlay", "softLight", "hardLight", "difference", "exclusion",
  "hue", "saturation", "color", "luminosity",
]);

export interface CompositePlan {
  readonly backend: CompositeBackend;
  /** Why this backend was chosen. Surfaced in the performance overlay. */
  readonly reason: string;
  /** The layer that forced the precise path, when one did. */
  readonly blockedBy?: string;
}

const fastPlan: CompositePlan = { backend: "canvas2d", reason: "8-bit layers with canvas-native blending" };

/**
 * Chooses how a document is composited.
 *
 * Two paths exist because they answer different questions. Painting needs the
 * fast one: a stroke recomposites its region many times a second, and per-pixel
 * JavaScript over a 4K region costs more than the frame budget allows. Colour
 * work needs the precise one: 16- and 32-bit documents, and the blend modes the
 * canvas never got, cannot be expressed as a `globalCompositeOperation` at all.
 *
 * The rule they share is that both must produce the same picture for the same
 * 8-bit input. A mode only belongs in {@link canvasBlendModes} once its two
 * implementations have been shown to agree; otherwise switching depth or
 * inserting an adjustment layer would visibly shift colours that the user never
 * touched.
 */
export function planComposite(state: RasterDocumentState): CompositePlan {
  if (state.bitDepth !== 8) {
    return {
      backend: "precise",
      reason: `${state.bitDepth}-bit document: canvas compositing is 8-bit only`,
    };
  }

  for (const layer of flattenRasterLayers(state.layers)) {
    if (!isLayerEffectivelyVisible(layer, state.layers)) continue;

    const blocker = blockingFeature(layer);
    if (blocker) {
      return { backend: "precise", reason: blocker, blockedBy: layer.id };
    }
  }

  return fastPlan;
}

/** What about this layer the browser compositor cannot reproduce. */
function blockingFeature(layer: RasterLayer): string | null {
  if (!canvasBlendModes.has(layer.blendMode)) {
    return `blend mode "${layer.blendMode}" has no canvas equivalent`;
  }
  // An adjustment reads back everything already composited underneath it,
  // which the browser compositor cannot express.
  if (layer.kind === "adjustment" || layer.adjustment) return "adjustment layer";
  if (layer.fillOpacity !== layer.opacity) return "fill opacity differs from layer opacity";
  if (hasEnabledEffect(layer)) return "layer effects";
  return null;
}

function hasEnabledEffect(layer: RasterLayer): boolean {
  const effects = layer.effects as Record<string, unknown> | undefined;
  if (!effects) return false;
  return Object.values(effects).some(
    (effect) => typeof effect === "object" && effect !== null && (effect as { enabled?: boolean }).enabled === true,
  );
}
