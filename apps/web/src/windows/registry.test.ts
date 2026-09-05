import { describe, expect, it } from "vitest";
import { environmentsWithWindows, windowsFor } from "./registry";

/**
 * Stage 7 of docs/migration-plan.md: `raster-core-panels/` and
 * `vector-core-panels/` — two copies of one catalogue — became
 * `environments/<kind>/windows/`, read by one registry.
 */
describe("window catalogues", () => {
  it("finds a catalogue for each environment that has one", () => {
    // Audio and video have no dockable panels yet; their absence here is the
    // fact, not a glob that matched nothing.
    expect(environmentsWithWindows).toEqual(["raster", "vector"]);
  });

  it("discovers unique raster panels with components and themeable icons", () => {
    const panels = windowsFor("raster");
    expect(panels.map((panel) => panel.id)).toEqual(["properties", "layers", "history", "assets", "color", "navigator", "effects", "scripts"]);
    expect(new Set(panels.map((panel) => panel.component)).size).toBe(panels.length);
    expect(panels.every((panel) => panel.icon.endsWith(".svg"))).toBe(true);
  });

  it("discovers the vector panels", () => {
    expect(windowsFor("vector").map((panel) => panel.id)).toEqual(["properties", "layers", "history", "color", "scripts"]);
  });

  it("keeps each environment's panels to itself", () => {
    // The environment comes from the file's directory, so a raster panel
    // cannot turn up in the vector list however its fields are written.
    const raster = new Set(windowsFor("raster").map((panel) => panel.id));
    expect(windowsFor("vector").some((panel) => panel.id === "navigator" || panel.id === "assets")).toBe(false);
    expect(raster.has("navigator")).toBe(true);
  });

  it("has environments that reuse each other's panel ids", () => {
    // Not a problem in itself — every environment wants a "layers" panel — but
    // it is a trap for anything that tries to work out which environment a
    // panel belongs to by asking each catalogue whether it knows the id. That
    // is what the dock's layout persistence did: a vector document's four
    // panels matched raster's catalogue too, so switching to a vector document
    // and hiding its Colour panel deleted raster's remembered Colour panel as
    // well. The environment has to come from the document, not from the id.
    const shared = windowsFor("raster").map((panel) => panel.id).filter((id) => windowsFor("vector").some((panel) => panel.id === id));
    // "scripts" joined them in stage 9 — scripts are shell-level work, but the
    // window catalogue is per environment, so the panel is declared in both.
    expect(shared).toEqual(["properties", "layers", "history", "color", "scripts"]);
  });

  it("answers for an environment that has no panels at all", () => {
    expect(windowsFor("audio")).toEqual([]);
  });

  it("orders each catalogue by `order`, which is what the Window list shows", () => {
    for (const kind of environmentsWithWindows) {
      const orders = windowsFor(kind).map((panel) => panel.order);
      expect([...orders], `${kind} panels are out of order`).toEqual([...orders].sort((a, b) => a - b));
    }
  });
});
