import { describe, expect, it } from "vitest";
import { DocumentSnapshotStore } from "./document-snapshot-store";
import { DocumentStore } from "./document-store";
import { MemoryStorageAdapter } from "./storage-adapter";

/**
 * Stage 0 of docs/migration-plan.md — see the sibling file in env-raster for
 * the full rationale. This one covers the kernel-side half of the numbers
 * the migration must not regress: autosave.
 */


/** A 21-layer document at 1920x1080, matching the shape realisticDocument()
 * builds in env-raster's performance.bench.test.ts, so the two halves of the
 * pipeline (edit, then persist) are measured against comparable documents. */
function realisticDocument(store: DocumentStore, layerCount = 21) {
  const layers: Record<string, Uint8ClampedArray> = {};
  for (let index = 0; index < layerCount; index += 1) {
    const pixels = new Uint8ClampedArray(1920 * 1080 * 4);
    for (let byte = 0; byte < pixels.length; byte += 4) {
      pixels[byte] = (byte * 7) % 255; pixels[byte + 1] = (byte * 13) % 255;
      pixels[byte + 2] = (byte * 31) % 255; pixels[byte + 3] = 255;
    }
    layers[`layer${index}`] = pixels;
  }
  return store.create("raster", "Bench Document", layers);
}

describe("performance floor (stage 0 of the catalogue migration)", () => {
  it("autosaves a 21-layer 1920x1080 document after one layer changed", async () => {
    const adapter = new MemoryStorageAdapter();
    const snapshots = new DocumentSnapshotStore(adapter);
    const documents = new DocumentStore();
    const document = realisticDocument(documents);
    await snapshots.saveSession(documents.list());

    let best = Infinity;
    for (let index = 0; index < 5; index += 1) {
      documents.update<Record<string, Uint8ClampedArray>>(document.id, (state) => {
        state.layer0 = new Uint8ClampedArray(state.layer0.length).fill(index);
      });
      const started = performance.now();
      // eslint-disable-next-line no-await-in-loop -- sequential timing samples
      await snapshots.saveSession(documents.list());
      best = Math.min(best, performance.now() - started);
    }

    // Measured on this fixture: under 1ms. MemoryStorageAdapter is a bare Map,
    // so this is not a claim about real IndexedDB or disk latency — those are
    // outside this code's control and belong to the adapter, not to this
    // test. What this isolates is the serialization work this code does on
    // every save: whether it re-encodes all 21 buffers or, as intended, only
    // the one that changed. A floor of 5ms (rather than a multiple of a
    // sub-millisecond number that timer jitter could trip on its own) still
    // catches that regression — re-encoding all 21 would cost roughly 21x
    // this, nowhere near the floor.
    expect(best).toBeLessThan(5);
  });
});
