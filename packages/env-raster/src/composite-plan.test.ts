import { describe, expect, it } from "vitest";
import { canvasBlendModes, planComposite } from "./composite-plan";
import { createRasterDocument, createRasterLayer } from "./document";
import { appendLayer } from "./layer-tree";
import type { RasterBlendMode, RasterDocumentState } from "./types";

const document = (): RasterDocumentState => createRasterDocument(16, 16);

const addLayer = (state: RasterDocumentState, mutate: (layer: ReturnType<typeof createRasterLayer>) => void) => {
  const layer = createRasterLayer(state.width, state.height, "Extra");
  mutate(layer);
  appendLayer(state, layer);
  return layer;
};

describe("composite plan", () => {
  it("sends plain 8-bit layers to the browser compositor", () => {
    const state = document();

    expect(planComposite(state)).toMatchObject({ backend: "canvas2d" });
  });

  it("keeps 16- and 32-bit documents on the precise path", () => {
    for (const bitDepth of [16, 32] as const) {
      const state = document();
      state.bitDepth = bitDepth;

      const plan = planComposite(state);

      // Canvas compositing is defined on 8-bit premultiplied sRGB; there is no
      // way to ask it for more precision.
      expect(plan.backend).toBe("precise");
      expect(plan.reason).toContain(`${bitDepth}-bit`);
    }
  });

  it("accepts every blend mode the canvas specification defines", () => {
    for (const blendMode of canvasBlendModes) {
      const state = document();
      addLayer(state, (layer) => { layer.blendMode = blendMode; });

      expect(planComposite(state).backend).toBe("canvas2d");
    }
  });

  it("falls back for the blend modes the canvas never got", () => {
    const beyondCanvas: RasterBlendMode[] = [
      "linearBurn", "linearDodge", "vividLight", "linearLight",
      "pinLight", "hardMix", "subtract", "divide", "dissolve",
      "darkerColor", "lighterColor",
    ];

    for (const blendMode of beyondCanvas) {
      const state = document();
      const layer = addLayer(state, (item) => { item.blendMode = blendMode; });

      const plan = planComposite(state);

      expect(plan.backend).toBe("precise");
      expect(plan.blockedBy).toBe(layer.id);
      expect(plan.reason).toContain(blendMode);
    }
  });

  it("falls back for an adjustment layer", () => {
    const state = document();
    addLayer(state, (layer) => {
      layer.kind = "adjustment";
      layer.adjustment = { kind: "levels", blackInput: 0, gamma: 1, whiteInput: 255, blackOutput: 0, whiteOutput: 255 };
    });

    // An adjustment reads back everything composited below it, which a
    // globalCompositeOperation cannot express.
    expect(planComposite(state)).toMatchObject({ backend: "precise", reason: "adjustment layer" });
  });

  it("falls back when fill opacity is separate from layer opacity", () => {
    const state = document();
    addLayer(state, (layer) => { layer.opacity = 1; layer.fillOpacity = 0.5; });

    expect(planComposite(state).backend).toBe("precise");
  });

  it("falls back for an enabled layer effect", () => {
    const state = document();
    addLayer(state, (layer) => {
      layer.effects = { ...layer.effects, dropShadow: { enabled: true, color: "#000", opacity: 1, offsetX: 2, offsetY: 2 } };
    });

    expect(planComposite(state)).toMatchObject({ backend: "precise", reason: "layer effects" });
  });

  it("ignores a disabled effect", () => {
    const state = document();
    addLayer(state, (layer) => {
      layer.effects = { ...layer.effects, dropShadow: { enabled: false, color: "#000", opacity: 1, offsetX: 2, offsetY: 2 } };
    });

    expect(planComposite(state).backend).toBe("canvas2d");
  });

  it("ignores hidden layers", () => {
    const state = document();
    addLayer(state, (layer) => { layer.visible = false; layer.blendMode = "vividLight"; });

    // A hidden layer contributes nothing, so it must not drag the whole
    // document onto the slow path.
    expect(planComposite(state).backend).toBe("canvas2d");
  });
});
