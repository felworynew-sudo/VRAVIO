import { beforeEach, describe, expect, it, vi } from "vitest";
import { IndexedDbStorageAdapter, MemoryStorageAdapter, ResilientStorageAdapter } from "./index";
import type { BinaryStorageAdapter } from "./storage-adapter";

const bytes = (text: string) => new TextEncoder().encode(text);

/** Contract every backing store has to satisfy. */
function behavesLikeStorage(name: string, build: () => BinaryStorageAdapter) {
  describe(name, () => {
    it("round-trips a value", async () => {
      const store = build();
      await store.set("a/b.bin", bytes("hello"));

      expect(new TextDecoder().decode((await store.get("a/b.bin"))!)).toBe("hello");
    });

    it("returns null for a key it never held", async () => {
      expect(await build().get("missing.bin")).toBeNull();
    });

    it("reports whether a removal did anything", async () => {
      const store = build();
      await store.set("x.bin", bytes("x"));

      expect(await store.remove("x.bin")).toBe(true);
      expect(await store.remove("x.bin")).toBe(false);
      expect(await store.get("x.bin")).toBeNull();
    });

    it("lists by prefix, sorted", async () => {
      const store = build();
      await store.set("b/2.bin", bytes("2"));
      await store.set("b/1.bin", bytes("1"));
      await store.set("c/1.bin", bytes("1"));

      expect(await store.list("b/")).toEqual(["b/1.bin", "b/2.bin"]);
    });

    it("does not alias the caller's buffer", async () => {
      const store = build();
      const source = bytes("original");
      await store.set("k.bin", source);
      source.fill(0);

      expect(new TextDecoder().decode((await store.get("k.bin"))!)).toBe("original");
    });
  });
}

behavesLikeStorage("memory storage", () => new MemoryStorageAdapter());

describe("resilient storage selection", () => {
  const original = { indexedDB: globalThis.indexedDB, navigator: globalThis.navigator };

  beforeEach(() => {
    vi.stubGlobal("indexedDB", undefined);
    vi.stubGlobal("navigator", { ...original.navigator, storage: undefined });
  });

  it("falls back to memory when no browser store is usable", async () => {
    const store = new ResilientStorageAdapter("probe");

    await store.set("a.bin", bytes("a"));

    // A browser with nothing writable still has to run; losing persistence is
    // survivable, refusing to start is not.
    expect(new TextDecoder().decode((await store.get("a.bin"))!)).toBe("a");
    expect(store.backing).toBe("memory");
  });

  it("rejects a store that claims to write and then reads back nothing", async () => {
    // This is the shape of the Safari failure: the file system API is present,
    // so a feature check passes, but writing through it throws.
    const broken = { getDirectory: () => Promise.reject(new Error("read-only")) };
    vi.stubGlobal("navigator", { ...original.navigator, storage: broken });

    const store = new ResilientStorageAdapter("probe");
    await store.set("a.bin", bytes("a"));

    expect(store.backing).toBe("memory");
    expect(await store.get("a.bin")).not.toBeNull();
  });

  it("probes once however many calls follow", async () => {
    const store = new ResilientStorageAdapter("probe");

    await Promise.all([store.set("a.bin", bytes("a")), store.set("b.bin", bytes("b")), store.list()]);

    expect(store.backing).toBe("memory");
    expect((await store.list()).length).toBe(2);
  });
});

describe("indexeddb storage availability", () => {
  it("reports itself unsupported where there is no indexedDB", () => {
    vi.stubGlobal("indexedDB", undefined);

    expect(IndexedDbStorageAdapter.isSupported()).toBe(false);
  });
});
