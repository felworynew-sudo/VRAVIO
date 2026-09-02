import { AssetStore, AutosaveManager, CommandRegistry, DocumentSnapshotStore, DocumentStore, GPUContext, HistoryManager, KeymapManager, MemoryStorageAdapter, OpfsStorageAdapter } from "@vravio/kernel";
import { createWebPlatform } from "./webPlatform";

const assetStorage = OpfsStorageAdapter.isSupported() ? new OpfsStorageAdapter("vravio-assets") : new MemoryStorageAdapter();
const sessionStorage = OpfsStorageAdapter.isSupported() ? new OpfsStorageAdapter("vravio-session") : new MemoryStorageAdapter();
const assets = new AssetStore(assetStorage);
const gpu = new GPUContext();
const platform = createWebPlatform(gpu);
const documents = new DocumentStore();
const autosave = new AutosaveManager(documents, new DocumentSnapshotStore(sessionStorage));
const sessionReady = autosave.restore().finally(() => autosave.start());

export const kernel = {
  documents,
  commands: new CommandRegistry(),
  keymap: new KeymapManager(),
  assets,
  assetsReady: assets.initialize(),
  gpu,
  platform,
  gpuReady: gpu.initialize(),
  autosave,
  sessionReady,
  historyByDocument: new Map<string, HistoryManager>(),
};
