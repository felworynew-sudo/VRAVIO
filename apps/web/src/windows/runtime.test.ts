import { describe, expect, it } from "vitest";
import { readVisiblePanelIds } from "./runtime";
import { windowsFor } from "./registry";

/**
 * `DockLayout.tsx`'s own restored-layout branch once claimed panel *presence* was "already
 * reconciled against the live catalogue elsewhere (readVisiblePanelIds)" — true of what this
 * function computes, false of whether anything downstream acted on it: a serialized dockview
 * layout was trusted whole, so a panel the catalogue gained after that layout was last saved
 * (`environments/audio/windows/definitions/properties.ts`, added alongside this test) never
 * actually appeared on screen no matter what this function returned. That half of the fix lives
 * in `DockLayout.tsx`'s `onReady`; this file is the half that was actually testable without a
 * running dockview instance — the same "known ids" reconciliation `toolbar/layout.test.ts`
 * already proves out for the tool palette, applied to panel visibility instead of tool order.
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

const audioIds = () => windowsFor("audio").map((panel) => panel.id);

describe("readVisiblePanelIds reconciling a stored layout against a catalogue that moved", () => {
  it("falls back to the catalogue's own defaults with nothing stored at all", () => {
    withLocalStorage({}, () => {
      expect([...readVisiblePanelIds("audio")].sort()).toEqual([...audioIds()].sort());
    });
  });

  it("adopts a panel the catalogue gained since this browser last saw it — the properties panel this test was written for", () => {
    // A pre-Inspector install: only "history" was ever stored, and (an older build, or one run
    // before the "known" bookkeeping existed at all) nothing recorded what the catalogue held
    // back then either — audio's real catalogue now has "properties" too, and it must be adopted
    // rather than treated as a panel the user once hid.
    withLocalStorage({ "vravio.audio-panels.visible": JSON.stringify(["history"]) }, () => {
      const reconciled = readVisiblePanelIds("audio");
      expect(reconciled.has("properties")).toBe(true);
      expect(reconciled.has("history")).toBe(true);
    });
  });

  it("does not resurrect a panel the user deliberately hid", () => {
    // "properties" is in `known` (this browser has seen it before) but missing from the visible
    // list — a real hide, not a gap left by a catalogue that has not caught up yet.
    withLocalStorage({
      "vravio.audio-panels.visible": JSON.stringify(["history"]),
      "vravio.audio-panels.known": JSON.stringify(audioIds()),
    }, () => {
      const reconciled = readVisiblePanelIds("audio");
      expect(reconciled.has("properties")).toBe(false);
      expect(reconciled.has("history")).toBe(true);
    });
  });

  it("drops a panel the catalogue no longer declares", () => {
    withLocalStorage({
      "vravio.audio-panels.visible": JSON.stringify(["history", "properties", "a-panel-nobody-declares-any-more"]),
      "vravio.audio-panels.known": JSON.stringify(["history", "properties", "a-panel-nobody-declares-any-more"]),
    }, () => {
      const reconciled = readVisiblePanelIds("audio");
      expect(reconciled.has("a-panel-nobody-declares-any-more")).toBe(false);
      expect([...reconciled].sort()).toEqual([...audioIds()].sort());
    });
  });

  it("persists the reconciled result, so the same gap is not rediscovered on every read", () => {
    withLocalStorage({ "vravio.audio-panels.visible": JSON.stringify(["history"]) }, () => {
      readVisiblePanelIds("audio");
      expect(JSON.parse(localStorage.getItem("vravio.audio-panels.visible")!).sort()).toEqual([...audioIds()].sort());
      expect(JSON.parse(localStorage.getItem("vravio.audio-panels.known")!).sort()).toEqual([...audioIds()].sort());
    });
  });

  it("leaves an already-reconciled layout alone", () => {
    withLocalStorage({
      "vravio.audio-panels.visible": JSON.stringify(["history"]),
      "vravio.audio-panels.known": JSON.stringify(audioIds()),
    }, () => {
      expect([...readVisiblePanelIds("audio")]).toEqual(["history"]);
    });
  });
});
