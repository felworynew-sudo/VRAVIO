import { AssetStore, CommandRegistry, DocumentStore, GPUContext, HistoryManager, KeymapManager, MemoryStorageAdapter, OpfsStorageAdapter } from "@vravio/kernel";

const assetStorage = OpfsStorageAdapter.isSupported() ? new OpfsStorageAdapter("vravio-assets") : new MemoryStorageAdapter();
const assets = new AssetStore(assetStorage);
const gpu = new GPUContext();

export const kernel = {
  documents: new DocumentStore(),
  commands: new CommandRegistry(),
  keymap: new KeymapManager(),
  assets,
  assetsReady: assets.initialize(),
  gpu,
  gpuReady: gpu.initialize(),
  historyByDocument: new Map<string, HistoryManager>(),
};
