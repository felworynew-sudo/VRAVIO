import { describe, expect, it } from "vitest";
import { createRasterDocument, createRasterLayerMask, selectAllPixels, TileStore, type RasterDocumentState } from "@vravio/env-raster";
import { commandDefinitionById } from "../commands/registry";
import { kernel } from "../kernel";
import { contextualAnchor, contextualBarStates, resolveContextualBar, type ContextualAction, type ContextualBarContext, type ResolvedAction } from "./states";

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

const ids = (actions: readonly ResolvedAction[]): unknown[] => actions.map((action) => action.items ? { [action.id]: ids(action.items) } : action.id);
const resolved = (ctx: ContextualBarContext) => {
  const bar = resolveContextualBar(ctx);
  return bar ? { state: bar.state.id, actions: ids(bar.actions) } : null;
};

describe("contextual task bar states", () => {
  it("names only commands that exist in the catalogue", () => {
    const check = (stateId: string, action: ContextualAction): void => {
      if (action.kind === "command") expect(commandDefinitionById.has(action.command), `${stateId} → ${action.command}`).toBe(true);
      if (action.kind === "menu") for (const item of action.items) check(stateId, item);
    };
    for (const state of contextualBarStates) for (const action of state.actions) check(state.id, action);
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
    expect(resolved(context(document))).toEqual({ state: "raster.selection", actions: ["edit.contentAwareFill", { "select.modify": ["select.feather", "select.expand", "select.contract", "select.smooth"] }, "layer.addMask", "select.invert", "select.transform", "edit.fillForeground", "select.none"] });
  });

  it("drops Create Mask, not the whole bar, when the layer already has a mask", () => {
    const document = open((state) => {
      state.selection = selectAllPixels(state.width, state.height);
      const layer = state.layers.find((item) => item.id === state.activeLayerId)!;
      layer.mask = createRasterLayerMask(state.width, state.height);
    });
    expect(resolved(context(document))?.actions).toEqual(["edit.contentAwareFill", { "select.modify": ["select.feather", "select.expand", "select.contract", "select.smooth"] }, "select.invert", "select.transform", "edit.fillForeground", "select.none"]);
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

  it("offers Rotate / Cancel / Done while a Free Transform is open, ahead of the selection state", () => {
    const calls: string[] = [];
    const session = { kind: "transform" as const, commit: () => calls.push("commit"), cancel: () => calls.push("cancel"), rotate: (degrees: 90 | -90) => { calls.push(`rotate ${degrees}`); } };
    const document = open((state) => { state.selection = selectAllPixels(state.width, state.height); });
    const bar = resolveContextualBar(context(document, { session }))!;
    expect(bar.state.id).toBe("raster.transform");
    expect(bar.actions.map((action) => action.id)).toEqual(["transform.rotateCcw", "transform.rotateCw", "session.cancel", "session.commit"]);
    for (const action of bar.actions) action.run();
    expect(calls).toEqual(["rotate -90", "rotate 90", "cancel", "commit"]);
    // A session that cannot turn (Warp, Skew) keeps only Cancel / Done.
    expect(resolved(context(document, { session: { kind: "transform", commit: () => {}, cancel: () => {} } }))?.actions).toEqual(["session.cancel", "session.commit"]);
  });

  it("offers the AI border fill toggle, Cancel and Done while a crop is open", () => {
    const document = open();
    expect(resolved(context(document, { session: { kind: "crop", commit: () => {}, cancel: () => {} } }))).toEqual({ state: "raster.crop", actions: ["crop.aiFill", "session.cancel", "session.commit"] });
  });

  it("offers nothing on an empty layer — Photoshop's Generate Image has no backend here", () => {
    const document = open((state) => {
      const layer = state.layers.find((item) => item.id === state.activeLayerId)!;
      // What `setLayerPixels`/`trimToContent` leave behind when a layer loses its last pixel.
      layer.bounds = { x: 0, y: 0, width: 1, height: 1 };
      layer.tiles = TileStore.empty(1, 1);
    });
    expect(resolved(context(document))).toBeNull();
  });

  it("follows the selected shapes in a vector document", () => {
    const shapes = [
      { id: "a", kind: "rectangle", name: "a", x: 10, y: 20, width: 30, height: 40, style: {}, parentId: null, orderKey: "0", visible: true, locked: false },
      { id: "b", kind: "rectangle", name: "b", x: 60, y: 10, width: 20, height: 20, style: {}, parentId: null, orderKey: "1", visible: true, locked: false },
    ];
    const vector = { kind: "vector", schemaVersion: 12, shapes, selection: ["a", "b"], activeShapeId: "a", artboards: [], activeArtboardId: null, palette: [], guides: [], rulerOrigin: null, rulerMode: "global", cmykProfileAssetId: null, softproof: false };
    const anchor = contextualAnchor({ documentId: "v", state: vector, editingMaskLayerId: null, selectedLayerIds: [] });
    expect(anchor).toEqual({ x: 10, y: 10, width: 70, height: 50 });
  });

  it("offers the type strip for a text layer", () => {
    const document = open((state) => {
      const layer = state.layers.find((item) => item.id === state.activeLayerId)!;
      (layer as { kind: string }).kind = "text";
      (layer as { text?: unknown }).text = { value: "hi", x: 0, y: 0, fontFamily: "Inter", fontSize: 24, align: "left", color: "#000000" };
    });
    const bar = resolveContextualBar(context(document))!;
    expect(bar.state.id).toBe("raster.text");
    expect(bar.actions.map((action) => action.id)).toEqual(["text.controls"]);
    // A widget, not a button: the bar renders its component instead of a label.
    expect(typeof bar.actions[0]!.Component).toBe("function");
  });

  it("shows nothing when nothing applies", () => {
    const document = open((state) => { for (const layer of state.layers) (layer as { kind: string }).kind = "text"; });
    expect(resolved(context(document))).toBeNull();
  });
});
