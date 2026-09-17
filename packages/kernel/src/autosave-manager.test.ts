import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutosaveManager } from "./autosave-manager";
import type { DocumentSnapshotStore } from "./document-snapshot-store";
import { DocumentStore } from "./document-store";
import type { VravioDocument } from "./types";

/** A snapshot store whose writes finish only when the test says so, recording what each saw. */
function controlledStore(options: { immediate?: boolean } = {}) {
  const saves: number[][] = [];
  const pending: (() => void)[] = [];
  const store = {
    saveSession: (documents: readonly VravioDocument[]) => {
      saves.push(documents.map((document) => document.revision));
      if (options.immediate) return Promise.resolve();
      return new Promise<void>((resolve) => pending.push(resolve));
    },
    loadSession: async () => [],
  } as unknown as DocumentSnapshotStore;
  return { store, saves, finishWrite: () => pending.shift()?.() };
}

const settle = () => new Promise<void>((resolve) => queueMicrotask(resolve)).then(() => undefined);

describe("AutosaveManager", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("saves an edit made while a save was still being written", async () => {
    const documents = new DocumentStore();
    const document = documents.create("vector", "Doc", { value: 0 });
    const { store, saves, finishWrite } = controlledStore();
    const autosave = new AutosaveManager(documents, store, { delayMs: 100 });
    autosave.start();

    documents.update(document.id, () => undefined);
    await vi.advanceTimersByTimeAsync(100);
    expect(saves).toHaveLength(1);

    // Edited while the first write is still on its way to disk, and then left alone.
    documents.update(document.id, () => undefined);
    await vi.advanceTimersByTimeAsync(100);
    documents.update(document.id, () => undefined);
    await vi.advanceTimersByTimeAsync(100);
    expect(saves).toHaveLength(1);
    finishWrite();
    await settle();
    await vi.advanceTimersByTimeAsync(100);

    expect(saves).toHaveLength(2);
    expect(saves[1]).toEqual([documents.get(document.id)!.revision]);
    // Several timers firing during that one write still add up to one more save, not several.
    finishWrite();
    await settle();
    await vi.advanceTimersByTimeAsync(1000);
    expect(saves).toHaveLength(2);
    autosave.dispose();
  });

  it("still saves during a stretch of edits that never pauses as long as the delay", async () => {
    const documents = new DocumentStore();
    const document = documents.create("vector", "Doc", { value: 0 });
    const { store, saves } = controlledStore({ immediate: true });
    const autosave = new AutosaveManager(documents, store, { delayMs: 1000, maxWaitMs: 5000 });
    autosave.start();

    // An edit every half second for twenty seconds — a long painting session.
    for (let step = 0; step < 40; step += 1) {
      documents.update(document.id, () => undefined);
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(saves.length).toBeGreaterThanOrEqual(3);
    autosave.dispose();
  });
});
