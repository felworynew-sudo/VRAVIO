import { createRasterDocument, type RasterDocumentState } from "@vravio/env-raster";
import { DocumentStore, type FileSystemPort } from "@vravio/kernel";
import { describe, expect, it, vi } from "vitest";
import { LinkedSmartObjectWatcher } from "./linked-smart-object-watcher";

const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

function linkedState(path: string): RasterDocumentState {
  const state = createRasterDocument(4, 4);
  const layer = state.layers[0]!;
  layer.kind = "smart";
  layer.smartSource = { assetId: "asset:linked", pinnedRev: null, sourceKind: "raster", mode: "linked", linkedPath: path };
  return state;
}

describe("LinkedSmartObjectWatcher", () => {
  it("uses one native watch per path and refreshes every open owner", async () => {
    const documents = new DocumentStore();
    const first = documents.create("raster", "First", linkedState("C:\\art\\logo.png"));
    const second = documents.create("raster", "Second", linkedState("C:\\art\\logo.png"));
    const callbacks = new Map<string, () => void>();
    const stop = vi.fn();
    const fs = {
      openFiles: vi.fn(), saveFile: vi.fn(),
      watchExternalFile: vi.fn(async (path: string, callback: () => void) => { callbacks.set(path, callback); return stop; }),
    } as unknown as FileSystemPort;
    const refresh = vi.fn(async () => undefined);
    const watcher = new LinkedSmartObjectWatcher(documents, fs, refresh);
    watcher.start();
    await flush();

    expect(fs.watchExternalFile).toHaveBeenCalledTimes(1);
    callbacks.get("C:\\art\\logo.png")!();
    await flush();
    expect(refresh).toHaveBeenCalledWith(first.id, "C:\\art\\logo.png");
    expect(refresh).toHaveBeenCalledWith(second.id, "C:\\art\\logo.png");

    watcher.dispose();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("releases a native watch when its final linked placement is removed", async () => {
    const documents = new DocumentStore();
    const document = documents.create("raster", "Linked", linkedState("C:\\art\\logo.png"));
    const stop = vi.fn();
    const fs = {
      openFiles: vi.fn(), saveFile: vi.fn(),
      watchExternalFile: vi.fn(async () => stop),
    } as unknown as FileSystemPort;
    const watcher = new LinkedSmartObjectWatcher(documents, fs, vi.fn(async () => undefined));
    watcher.start();
    await flush();

    documents.update<RasterDocumentState>(document.id, (state) => { state.layers[0]!.smartSource = { assetId: "asset:embedded", pinnedRev: null, sourceKind: "raster", mode: "embedded" }; });
    await flush();
    expect(stop).toHaveBeenCalledTimes(1);
    watcher.dispose();
  });
});
