import { describe, expect, it } from "vitest";
import { rasterCorePanels } from "./registry";

describe("raster core panel modules", () => {
  it("discovers unique panels with components and themeable icons", () => {
    expect(rasterCorePanels.map((panel) => panel.id)).toEqual(["properties", "layers", "history", "assets", "color", "navigator", "effects"]);
    expect(new Set(rasterCorePanels.map((panel) => panel.component)).size).toBe(rasterCorePanels.length);
    expect(rasterCorePanels.every((panel) => panel.icon.endsWith(".svg"))).toBe(true);
  });
});
