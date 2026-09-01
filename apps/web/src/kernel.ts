import { AssetStore, CommandRegistry, DocumentStore, HistoryManager, KeymapManager, MemoryStorageAdapter, OpfsStorageAdapter } from "@vravio/kernel";

const assetStorage = OpfsStorageAdapter.isSupported() ? new OpfsStorageAdapter("vravio-assets") : new MemoryStorageAdapter();
const assets = new AssetStore(assetStorage);

export const kernel = {
  documents: new DocumentStore(),
  commands: new CommandRegistry(),
  keymap: new KeymapManager(),
  assets,
  assetsReady: assets.initialize(),
  historyByDocument: new Map<string, HistoryManager>(),
};
