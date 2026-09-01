import { beforeEach, describe, expect, it } from "vitest";
import { useShellStore } from "./store";
import { kernel } from "./kernel";

describe("shell store", () => {
  beforeEach(() => {
    for (const document of kernel.documents.list()) kernel.documents.close(document.id);
    useShellStore.setState({ documentIds: [], activeDocumentId: null, mruOrder: [], activeToolByDocument: {}, viewports: {}, foregroundColor: "#000000", backgroundColor: "#ffffff", toolOptions: {}, paletteOpen: false, newDocumentKind: null, theme: "dark" });
  });

  it("opens all environment kinds as independent document tabs", () => {
    for (const kind of ["raster", "vector", "audio", "video"] as const) useShellStore.getState().openDocument(kind);
    expect(kernel.documents.list().map((document) => document.kind)).toEqual(["raster", "vector", "audio", "video"]);
    expect(useShellStore.getState().activeDocumentId).toBe(kernel.documents.list().at(-1)?.id);
  });

  it("falls back to the most recent remaining tab when closing active", () => {
    useShellStore.getState().openDocument("raster");
    useShellStore.getState().openDocument("audio");
    const active = useShellStore.getState().activeDocumentId;
    if (!active) throw new Error("Expected an active document");
    useShellStore.getState().closeDocument(active);
    expect(kernel.documents.list()).toHaveLength(1);
    expect(useShellStore.getState().activeDocumentId).toBe(kernel.documents.list()[0]?.id);
  });

  it("updates shared performance and appearance preferences without replacing unrelated values", () => {
    const before = useShellStore.getState().preferences;
    useShellStore.getState().updatePreferences({ renderer: "webgl2", rasterColor: "#123456" });
    const after = useShellStore.getState().preferences;
    expect(after.renderer).toBe("webgl2");
    expect(after.rasterColor).toBe("#123456");
    expect(after.audioColor).toBe(before.audioColor);
  });

  it("creates a raster document from exact dialog parameters", () => {
    useShellStore.getState().requestNewDocument("raster");
    useShellStore.getState().openDocument("raster", { name: "Poster", width: 2480, height: 3508, resolution: 300, resolutionUnit: "ppi", backgroundColor: "#ffffff", pixelAspectRatio: 1 });
    const document = kernel.documents.list()[0];
    expect(document?.name).toBe("Poster");
    expect(document?.state).toMatchObject({ width: 2480, height: 3508, resolution: 300, backgroundColor: "#ffffff" });
    expect(useShellStore.getState().newDocumentKind).toBeNull();
  });

  it("keeps independent viewport transforms per document and removes them on close", () => {
    useShellStore.getState().openDocument("raster");
    const first = useShellStore.getState().activeDocumentId!;
    useShellStore.getState().setViewport(first, { zoom: 2, rotation: 15, mode: "custom" });
    useShellStore.getState().openDocument("raster");
    const second = useShellStore.getState().activeDocumentId!;
    expect(useShellStore.getState().viewports[first]).toMatchObject({ zoom: 2, rotation: 15 });
    expect(useShellStore.getState().viewports[second]).toMatchObject({ zoom: 1, rotation: 0, mode: "fit" });
    useShellStore.getState().closeDocument(first);
    expect(useShellStore.getState().viewports[first]).toBeUndefined();
  });

  it("swaps and resets foreground/background colors", () => {
    useShellStore.getState().setForegroundColor("#123456");
    useShellStore.getState().swapColors();
    expect(useShellStore.getState()).toMatchObject({ foregroundColor: "#ffffff", backgroundColor: "#123456" });
    useShellStore.getState().resetColors();
    expect(useShellStore.getState()).toMatchObject({ foregroundColor: "#000000", backgroundColor: "#ffffff" });
  });
});
