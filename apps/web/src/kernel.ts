import { AssetStore, AutosaveManager, CommandRegistry, DocumentSnapshotStore, DocumentStore, EnvironmentRegistry, GPUContext, HistoryManager, KeymapManager, ModelStore, ResilientStorageAdapter, RoundTripManager } from "@vravio/kernel";
import { RasterEnvironment } from "@vravio/env-raster";
import { createWebPlatform } from "./webPlatform";

// Which store actually works is settled by writing a byte and reading it back,
// not by asking whether the API exists: Safari reports an origin private file
// system it long refused to write to, and a private window can fail later
// still. See ResilientStorageAdapter.
const assetStorage = new ResilientStorageAdapter("vravio-assets");
const sessionStorage = new ResilientStorageAdapter("vravio-session");
const documentsStore = new DocumentStore();
const assets = new AssetStore(assetStorage);
// Pixel edits are recorded as asset revisions and released by undo history,
// which does not survive a reload. Whatever the previous session left behind
// the head is unreachable now, so it is collected before the first edit rather
// than kept for the lifetime of the profile.
const assetsReady = assets.initialize().then(() => assets.collectUnreachableRevisions()).then(() => undefined);
const historyByDocument = new Map<string, HistoryManager>();

// The registry is what makes an environment pluggable: the round-trip manager
// asks it for whichever kind a document is, and knows nothing else about them.
const environments = new EnvironmentRegistry();
environments.register(new RasterEnvironment({ documents: documentsStore, assets }));
const roundtrip = new RoundTripManager({
  documents: documentsStore, assets, environments,
  historyFor: (id) => historyByDocument.get(id),
});

const gpu = new GPUContext();
const models = new ModelStore({ cache: null });
const platform = createWebPlatform(gpu, models);
const autosave = new AutosaveManager(documentsStore, new DocumentSnapshotStore(sessionStorage));
const sessionReady = autosave.restore().finally(() => autosave.start());

export const kernel = {
  documents: documentsStore,
  environments,
  roundtrip,
  commands: new CommandRegistry(),
  keymap: new KeymapManager(),
  assets,
  assetsReady,
  gpu,
  platform,
  models,
  gpuReady: gpu.initialize(),
  autosave,
  sessionReady,
  /** Which store the probe settled on, for the diagnostics panel. */
  storage: assetStorage,
  historyByDocument,
};

// A handle for driving the kernel from the devtools console during development.
// Reaching for the module through `import('/@fs/...')` instead gives a second
// module instance once Vite has hot-reloaded the file, so the store inspected
// there is not the one the application is using.
if (import.meta.env.DEV) {
  (globalThis as Record<string, unknown>).vravio = kernel;
}
