import { flattenRasterLayers, isRasterDocumentState, TileStore, type RasterLayer } from "@vravio/env-raster";
import type { BinaryStorageAdapter, Disposable, DocumentStore } from "@vravio/kernel";
import { diagnostic } from "./diagnostics";

/**
 * docs/master-plan.md §37.3 item 6 — the actual eviction/restore orchestration, following
 * `AutosaveManager`'s exact shape (debounced `schedule()` on every document change, one background
 * sweep per firing) for the same reason: it is the one existing "idle background pass over every
 * open document" this app already has, proven and tested, not a second one invented alongside it.
 *
 * Scope, deliberately narrow: only `kind: "pixel"` layers, only hidden AND not the active layer.
 * Text/adjustment/group/smart/shape/3D layers and masks are left alone — they either hold far less
 * data, or (groups) have no pixels of their own to evict at all. A layer becomes eligible again the
 * moment it is shown or selected — `restore()` is the other half of this file, called from the two
 * UI actions that can make either true (`DockLayout.tsx`'s `toggleVisible`/`selectLayer`) and from
 * `raster-commit.ts`'s undo/redo rectangle-swap, the one path proven able to reach a layer that is
 * neither visible nor active (docs/master-plan.md §37.13's own audit).
 */

const DEFAULT_DELAY_MS = 4000;

/**
 * Deterministic from data every layer already carries — no separate bookkeeping (a `WeakMap` from
 * layer object to storage key, the first version of this) needed to find a given layer's bytes
 * again. This matters more than it looks: a session reload (`document-snapshot-store.ts`'s own
 * `TileStore.toJSON()`/`fromJSON()` round trip) rebuilds every layer as a brand new object, which
 * would silently orphan a `WeakMap`-based key — this layer's real bytes would still be sitting in
 * storage, unreachable, while `restore()` had no way to find them and had to fabricate an empty
 * layer instead. `pixelsRevision` does not change while a layer is evicted (nothing writes to a
 * hidden, inactive layer), so the same key `#evict` computed is still exactly right whenever
 * `restore()` computes it again later — same session or a fresh one.
 */
function swapKey(documentId: string, layerId: string, pixelsRevision: number): string {
  return `${documentId}/${layerId}/${pixelsRevision}`;
}

/**
 * A `TileStore.toJSON()` snapshot, packed as one `Uint8Array` for `BinaryStorageAdapter` — a tiny
 * fixed header (three `Uint32`s, little-endian) followed by the raw pixel bytes, not JSON: the
 * pixels are already bytes, and this is the same "flat typed buffers, no serialisation ceremony for
 * the hot payload" trade `TileStore` itself is built on (CLAUDE.md §5).
 */
function encodeTileSnapshot(snapshot: { width: number; height: number; channels: number; pixels: Uint8ClampedArray }): Uint8Array {
  const out = new Uint8Array(12 + snapshot.pixels.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, snapshot.width, true);
  view.setUint32(4, snapshot.height, true);
  view.setUint32(8, snapshot.channels, true);
  out.set(snapshot.pixels, 12);
  return out;
}

function decodeTileSnapshot(bytes: Uint8Array): { width: number; height: number; channels: number; pixels: Uint8ClampedArray } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, 12);
  const width = view.getUint32(0, true), height = view.getUint32(4, true), channels = view.getUint32(8, true);
  const pixels = new Uint8ClampedArray(bytes.buffer, bytes.byteOffset + 12, bytes.byteLength - 12);
  return { width, height, channels, pixels };
}

export interface LayerSwapManagerOptions {
  readonly delayMs?: number;
}

export class LayerSwapManager {
  readonly #documents: DocumentStore;
  readonly #storage: BinaryStorageAdapter;
  readonly #delayMs: number;
  #subscription: Disposable | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  /** Prevents a second concurrent sweep from racing the first — `AutosaveManager.flush()`'s own
   *  `#flushPromise` guard, the identical shape for the identical reason. */
  #sweeping: Promise<void> | null = null;

  constructor(documents: DocumentStore, storage: BinaryStorageAdapter, options: LayerSwapManagerOptions = {}) {
    this.#documents = documents;
    this.#storage = storage;
    this.#delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  }

  start(): void {
    if (this.#subscription) return;
    this.#subscription = this.#documents.subscribe(() => this.schedule());
  }

  dispose(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#subscription?.dispose();
    this.#subscription = null;
  }

  schedule(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => { this.#timer = null; void this.#sweep(); }, this.#delayMs);
  }

  /** Runs a sweep now instead of waiting for the debounce — `AutosaveManager.flush()`'s own
   *  reason to exist, mirrored: a caller that needs the result settled (this file's own tests, or
   *  a future "flatten now"/"about to close the tab" hook) awaits this instead of guessing at a
   *  delay long enough to outlast `schedule()`'s timer. */
  flush(): Promise<void> {
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = null; }
    return this.#sweep();
  }

  /**
   * A resolved-memory backing (`ResilientStorageAdapter`'s own fallback when neither OPFS nor
   * IndexedDB actually accepted a write — a private window, blocked site data, or an engine that
   * only claims OPFS support) makes eviction pointless: the bytes would just move from one
   * in-memory `Map` (`TileStore`'s own) to another (`MemoryStorageAdapter`'s), holding the exact
   * same heap allocation alive under a different name while adding a serialise/deserialise cost and
   * an async round trip neither buys anything. Every sweep checks this first and does nothing at
   * all when true — not a smaller sweep, no sweep.
   *
   * Duck-typed against `.backing` rather than an `instanceof ResilientStorageAdapter` check, so
   * this class keeps taking the plain `BinaryStorageAdapter` interface — a `MemoryStorageAdapter`
   * passed directly (this file's own tests, which have no browser OPFS/IndexedDB to probe) has no
   * `.backing` at all and is treated as worth evicting to, which is exactly right for exercising the
   * evict/restore round trip in isolation from the separate "is it worthwhile" policy this checks in
   * production, where `kernel.ts` always wires a real `ResilientStorageAdapter`.
   */
  async #sweep(): Promise<void> {
    if (this.#sweeping) return this.#sweeping;
    this.#sweeping = this.#sweepNow().finally(() => { this.#sweeping = null; });
    return this.#sweeping;
  }

  async #sweepNow(): Promise<void> {
    const resilient = this.#storage as Partial<{ backing: string | null }>;
    // `.backing` resolves lazily on first real use; a `get`/`set` against a throwaway key is the
    // same probe `ResilientStorageAdapter` already runs internally, so the first sweep of a session
    // pays for it once, not this class inventing a second capability check.
    if ("backing" in resilient && resilient.backing === null) await this.#storage.list();
    if (resilient.backing === "memory") return;
    for (const document of this.#documents.list()) {
      if (!isRasterDocumentState(document.state)) continue;
      const state = document.state;
      for (const layer of flattenRasterLayers(state.layers)) {
        if (layer.kind !== "pixel" || layer.visible || layer.id === state.activeLayerId) continue;
        if (layer.tiles.evicted) continue;
        await this.#evict(document.id, layer);
      }
    }
  }

  async #evict(documentId: string, layer: RasterLayer): Promise<void> {
    const key = swapKey(documentId, layer.id, layer.pixelsRevision);
    const { width, height, channels } = layer.tiles;
    let bytes: Uint8Array;
    try {
      // `toPixels()`, not `toJSON()`: the sweep above already checked `!layer.tiles.evicted`
      // immediately before this call, so this is always the real-bytes branch — `toJSON()`'s wider,
      // evicted-or-not return type would need narrowing here for no benefit.
      bytes = encodeTileSnapshot({ width, height, channels, pixels: layer.tiles.toPixels() });
    } catch (error) {
      // A layer already mid-way through something this sweep did not anticipate (its own
      // `toPixels()` failing for a reason unrelated to eviction) is left alone rather than risking
      // a half-written swap entry — the layer simply stays resident until the next sweep.
      diagnostic("warn", "layer-swap.encode-failed", "Skipping eviction for a layer whose tiles could not be read", { documentId, layerId: layer.id, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    try {
      await this.#storage.set(key, bytes);
    } catch (error) {
      diagnostic("warn", "layer-swap.write-failed", "Skipping eviction — storage write failed", { documentId, layerId: layer.id, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    // The write is durable before the in-memory copy is dropped — the opposite order would mean a
    // storage failure between the two leaves a layer with no real pixels anywhere.
    layer.tiles = TileStore.placeholder(layer.tiles.width, layer.tiles.height, layer.tiles.channels);
  }

  /**
   * Restores `layer`'s real tiles if (and only if) they are currently evicted — a no-op otherwise,
   * so every call site that might touch a possibly-evicted layer can call this unconditionally
   * first, the same "ask, don't assume" shape `canDirectRasterPreviewBlit` already established for
   * the preview fast path.
   */
  async restore(documentId: string, layer: RasterLayer): Promise<void> {
    if (!layer.tiles.evicted) return;
    const key = swapKey(documentId, layer.id, layer.pixelsRevision);
    const bytes = await this.#storage.get(key);
    if (!bytes) {
      // Should be unreachable — `#evict` always writes before replacing `layer.tiles` with a
      // placeholder — but surfacing it as a loud, recoverable warning (an empty layer, not a thrown
      // exception deep in whatever just tried to show or edit this layer) is a far better failure
      // than crashing the caller for a lost swap entry.
      diagnostic("error", "layer-swap.restore-failed", "Evicted layer's bytes were not found in storage; replacing with an empty layer", { documentId, layerId: layer.id, key });
      layer.tiles = TileStore.empty(layer.tiles.width, layer.tiles.height, layer.tiles.channels);
      return;
    }
    layer.tiles = TileStore.fromJSON(decodeTileSnapshot(bytes));
    void this.#storage.remove(key);
  }
}
