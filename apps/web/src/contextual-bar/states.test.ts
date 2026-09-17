import { describe, expect, it } from "vitest";
import { createRasterDocument, createRasterLayerMask, selectAllPixels, type RasterDocumentState } from "@vravio/env-raster";
import { commandDefinitionById } from "../commands/registry";
import { kernel } from "../kernel";
import { contextualBarStates, resolveContextualBar, type ContextualBarContext } from "./states";

/**
 * The Contextual Task Bar is a table of states → catalogue commands
 * (docs/master-plan.md §11). What this holds true:
 *
 * - every command a row names exists — a renamed command would otherwise make
 *   a button silently vanish (CLAUDE.md §3/§4);
 * - each raster state is reached by the document shape it describes, and
 *   offers the commands Photoshop's bar offers there that VRAVIO backs.
 *
 * `isEnabled` of the commands reads the kernel's document store, so each
 * fixture is a real document opened there — not a state object the commands
 * would never see.
 */

let counter = 0;
function open(mutate: (state: RasterDocumentState) => void = () => {}): { id: string; state: RasterDocumentState } {
  const state = createRasterDocument(16, 12);
  mutate(state);
  const document = kernel.documents.create("raster", `contextual-${counter += 1}`, state);
  return { id: document.id, state: kernel.documents.get<RasterDocumentState>(document.id)!.state };
}

const context = (document: { id: string; state: unknown }, extra: Partial<ContextualBarContext> = {}): ContextualBarContext =>
  ({ documentId: document.id, state: document.state, editingMaskLayerId: null, selectedLayerIds: [], ...extra });

const resolved = (ctx: ContextualBarContext) => {
  const bar = resolveContextualBar(ctx);
  return bar ? { state: bar.state.id, actions: bar.actions.map((action) => action.id) } : null;
};

describe("contextual task bar states", () => {
  it("names only commands that exist in the catalogue", () => {
    for (const state of contextualBarStates) {
      for (const action of state.actions) {
        if (action.kind === "command") expect(commandDefinitionById.has(action.command), `${state.id} → ${action.command}`).toBe(true);
      }
    }
  });

  it("gives every state an id of its own and at least one action", () => {
    const ids = contextualBarStates.map((state) => state.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const state of contextualBarStates) expect(state.actions.length, state.id).toBeGreaterThan(0);
  });

  it("offers Select Subject and Remove Background on a pixel layer with nothing selected", () => {
    const document = open();
    expect(resolved(context(document))).toEqual({ state: "raster.pixelLayer", actions: ["select.subject", "layer.removeBackground"] });
  });

  it("switches to the selection actions once there is a selection", () => {
    const document = open((state) => { state.selection = selectAllPixels(state.width, state.height); });
    expect(resolved(context(document))).toEqual({ state: "raster.selection", actions: ["select.feather", "select.invert", "layer.addMask", "edit.fillForeground", "select.none"] });
  });

  it("drops Create Mask, not the whole bar, when the layer already has a mask", () => {
    const document = open((state) => {
      state.selection = selectAllPixels(state.width, state.height);
      const layer = state.layers.find((item) => item.id === state.activeLayerId)!;
      layer.mask = createRasterLayerMask(state.width, state.height);
    });
    expect(resolved(context(document))?.actions).toEqual(["select.feather", "select.invert", "edit.fillForeground", "select.none"]);
  });

  it("offers Invert on a mask being edited", () => {
    const document = open((state) => {
      const layer = state.layers.find((item) => item.id === state.activeLayerId)!;
      layer.mask = createRasterLayerMask(state.width, state.height);
    });
    expect(resolved(context(document, { editingMaskLayerId: document.state.activeLayerId }))).toEqual({ state: "raster.mask", actions: ["image.adjustment.invert", "layer.toggleMaskEnabled", "layer.applyMask", "layer.deleteMask"] });
  });

  it("offers Group for a multi-layer selection", () => {
    const document = open();
    expect(resolved(context(document, { selectedLayerIds: [document.state.activeLayerId, "b"] }))).toEqual({ state: "raster.layers", actions: ["layer.group"] });
    // A multi-selection the active layer is not part of is stale (grouping
    // just made the group active) and does not decide the bar.
    expect(resolved(context(document, { selectedLayerIds: ["a", "b"] }))?.state).toBe("raster.pixelLayer");
  });

  it("shows nothing when nothing applies", () => {
    const document = open((state) => { for (const layer of state.layers) (layer as { kind: string }).kind = "text"; });
    expect(resolved(context(document))).toBeNull();
  });
});
