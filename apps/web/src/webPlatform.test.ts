import { describe, expect, it } from "vitest";
import { storedWorkerCount } from "./webPlatform";

/**
 * `createOnnxRuntime` used to be called with no `workerCount` at all — Settings' "Worker
 * threads" slider wrote to `store.preferences.workerCount` and nothing anywhere ever read it
 * back. `storedWorkerCount` is the fix: read straight from storage at platform-init time,
 * since `createWebPlatform` runs once before any store subscriber exists to react later.
 *
 * There is no `localStorage` outside a browser, so each test supplies the smallest thing that
 * behaves like one (same pattern as `toolbar/layout.test.ts`).
 */
function withLocalStorage(entries: Record<string, string>, run: () => void): void {
  const store = new Map(Object.entries(entries));
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  };
  try { run(); } finally { delete (globalThis as { localStorage?: unknown }).localStorage; }
}

describe("storedWorkerCount", () => {
  it("reads a positive integer from the persisted preferences", () => {
    withLocalStorage({ "vravio.preferences": JSON.stringify({ workerCount: 6 }) }, () => {
      expect(storedWorkerCount()).toBe(6);
    });
  });

  it("rounds a non-integer value", () => {
    withLocalStorage({ "vravio.preferences": JSON.stringify({ workerCount: 3.7 }) }, () => {
      expect(storedWorkerCount()).toBe(4);
    });
  });

  it("falls back to undefined when nothing is stored", () => {
    withLocalStorage({}, () => {
      expect(storedWorkerCount()).toBeUndefined();
    });
  });

  it("falls back to undefined for zero, negative, or non-numeric values", () => {
    withLocalStorage({ "vravio.preferences": JSON.stringify({ workerCount: 0 }) }, () => {
      expect(storedWorkerCount()).toBeUndefined();
    });
    withLocalStorage({ "vravio.preferences": JSON.stringify({ workerCount: -2 }) }, () => {
      expect(storedWorkerCount()).toBeUndefined();
    });
    withLocalStorage({ "vravio.preferences": JSON.stringify({ workerCount: "eight" }) }, () => {
      expect(storedWorkerCount()).toBeUndefined();
    });
  });

  it("falls back to undefined on corrupt JSON rather than throwing", () => {
    withLocalStorage({ "vravio.preferences": "{not json" }, () => {
      expect(storedWorkerCount()).toBeUndefined();
    });
  });

  it("falls back to undefined outside a browser (no localStorage at all)", () => {
    expect(storedWorkerCount()).toBeUndefined();
  });
});
