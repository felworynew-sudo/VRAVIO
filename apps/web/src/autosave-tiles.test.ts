import { describe, expect, it } from "vitest";
import { DocumentSnapshotStore, DocumentStore, MemoryStorageAdapter } from "@vravio/kernel";
import { TileStore } from "@vravio/env-raster";

/**
 * Autosave against a real `TileStore` (docs/master-plan.md §63).
 *
 * This file exists because of what its absence cost. The kernel's own snapshot tests use plain
 * buffers — the kernel cannot import the raster package — and the raster package's tests never
 * involve the snapshot store. Everything each side tested was true, and the thing between them
 * was not: chunked, content-named persistence let one edited chunk reach disk and silently drop
 * another. Only a test that owns both halves can see that, and this app already depends on both.
 */

const fixture = (width: number, height: number, seed = 1): Uint8ClampedArray => {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < pixels.length; index += 4) {
    pixels[index] = (index * seed) % 251; pixels[index + 1] = (index * 7) % 253; pixels[index + 2] = seed; pixels[index + 3] = 255;
  }
  return pixels;
};

const roundTrip = async (store: DocumentSnapshotStore, documents: DocumentStore) => {
  await store.saveSession(documents.list());
  const restored = await store.loadSession();
  const state = restored[0]?.state as { tiles: unknown };
  // The restored store comes back as the plain shape `JSON.parse` leaves; rebuilding it is what
  // `migrateRasterDocumentState` does for a real document.
  return TileStore.fromJSON(state.tiles as never);
};

describe("content names are unique across runs, not just within one", () => {
  it("never re-issues a name that was adopted from a snapshot", () => {
    // The live failure: names were a bare counter, a restored store adopted `t57` from disk, the
    // next run's counter reached 57 on its own, and autosave decided a different chunk's content
    // was already saved. Names now carry a per-run prefix, so an adopted one can never be
    // re-issued; anything that reintroduces a global counter fails here.
    const restored = TileStore.fromPixels(new Uint8ClampedArray(4), 1, 1);
    restored.adoptContentKey("t57");
    const issued = new Set<string>();
    for (let index = 0; index < 200; index += 1) {
      const store = TileStore.fromPixels(new Uint8ClampedArray(4), 1, 1);
      store.writeLocalRegion({ x: 0, y: 0, width: 1, height: 1 }, new Uint8ClampedArray([index, 0, 0, 255]));
      issued.add(store.contentKey);
    }

    expect(issued.has("t57")).toBe(false);
    expect(issued.size).toBe(200);
  });
});

describe("autosave keeps a tiled layer byte-for-byte", () => {
  const WIDTH = 2400, HEIGHT = 1200;      // more than one chunk across and down

  it("restores every chunk of a layer that was saved once", async () => {
    const documents = new DocumentStore();
    const snapshots = new DocumentSnapshotStore(new MemoryStorageAdapter());
    const source = fixture(WIDTH, HEIGHT);
    documents.create("raster", "Doc", { tiles: TileStore.fromPixels(source, WIDTH, HEIGHT) });

    const restored = await roundTrip(snapshots, documents);
    // Sampled, not element-by-element: `toEqual` on eleven million numbers takes longer than the
    // whole rest of this file, and a stride that is coprime with the chunk grid still visits every
    // chunk many times.
    const pixels = restored.toPixels();
    expect(pixels.length).toBe(source.length);
    for (let index = 0; index < source.length; index += 997) expect(pixels[index], `byte ${index}`).toBe(source[index]);
  });

  it("restores edits made in several different chunks between saves", async () => {
    // The failure this was written for: two marks written in one edit, saved, and only one of them
    // came back — found live, by reloading the session and reading the pixels back.
    const documents = new DocumentStore();
    const snapshots = new DocumentSnapshotStore(new MemoryStorageAdapter());
    const document = documents.create("raster", "Doc", { tiles: TileStore.fromPixels(fixture(WIDTH, HEIGHT), WIDTH, HEIGHT) });
    await snapshots.saveSession(documents.list());

    documents.update<{ tiles: TileStore }>(document.id, (state) => {
      const tiles = state.tiles.clone();
      tiles.writeLocalRegion({ x: 50, y: 50, width: 4, height: 4 }, new Uint8ClampedArray(64).fill(211));
      tiles.writeLocalRegion({ x: 2100, y: 1100, width: 4, height: 4 }, new Uint8ClampedArray(64).fill(37));
      state.tiles = tiles;
    });

    const restored = await roundTrip(snapshots, documents);
    expect(Array.from(restored.readLocalRegion({ x: 50, y: 50, width: 1, height: 1 })), "first chunk").toEqual([211, 211, 211, 211]);
    expect(Array.from(restored.readLocalRegion({ x: 2100, y: 1100, width: 1, height: 1 })), "second chunk").toEqual([37, 37, 37, 37]);
  });

  it("survives repeated save/edit cycles, each touching a different chunk", async () => {
    const documents = new DocumentStore();
    const snapshots = new DocumentSnapshotStore(new MemoryStorageAdapter());
    const document = documents.create("raster", "Doc", { tiles: TileStore.fromPixels(fixture(WIDTH, HEIGHT), WIDTH, HEIGHT) });
    const marks: Array<[number, number, number]> = [[10, 10, 101], [1100, 10, 102], [2100, 10, 103], [10, 1100, 104]];

    for (const [x, y, value] of marks) {
      documents.update<{ tiles: TileStore }>(document.id, (state) => {
        const tiles = state.tiles.clone();
        tiles.writeLocalRegion({ x, y, width: 2, height: 2 }, new Uint8ClampedArray(16).fill(value));
        state.tiles = tiles;
      });
      await snapshots.saveSession(documents.list());
    }

    const restored = await roundTrip(snapshots, documents);
    for (const [x, y, value] of marks) {
      expect(Array.from(restored.readLocalRegion({ x, y, width: 1, height: 1 })), `mark at ${x},${y}`).toEqual([value, value, value, value]);
    }
  });

  it("keeps a 16-bit layer at 16 bits through the round trip", async () => {
    const documents = new DocumentStore();
    const snapshots = new DocumentSnapshotStore(new MemoryStorageAdapter());
    const deep = TileStore.fromPixels(fixture(1200, 600), 1200, 600, 4, 16);
    documents.create("raster", "Deep", { tiles: deep });

    const restored = await roundTrip(snapshots, documents);
    const before = deep.toPixels(), after = restored.toPixels();
    expect(restored.depth).toBe(16);
    expect(after.length).toBe(before.length);
    for (let index = 0; index < before.length; index += 997) expect(after[index], `byte ${index}`).toBe(before[index]);
  });
});
