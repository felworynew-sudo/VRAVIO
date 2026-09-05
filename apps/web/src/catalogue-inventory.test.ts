import { describe, expect, it } from "vitest";
import { commandDefinitions } from "./commands/registry";
import { rasterTools } from "./environments/raster/tools/registry";
import { rasterRules } from "./environments/raster/rules/registry";
import { modalDefinitions } from "./modals/registry";
import { brushPresets } from "./assets-library/brushes/registry";
import { inpaintModels } from "./ml/inpaint/registry";
import { environmentsWithWindows, windowsFor } from "./windows/registry";

/**
 * Stage 11 of docs/migration-plan.md: "инвентаризация каталогов на старте
 * кэшируется, а не пересчитывается".
 *
 * Every registry here is an `import.meta.glob(..., { eager: true })` evaluated
 * once at module scope, so the inventory is taken once per page load and never
 * again. That is a property of how they are written rather than of a cache,
 * and it is easy to lose: turning a registry into a function — to take a
 * parameter, to filter, to sort differently — quietly moves the work to every
 * call site, and nothing fails. The palette rebuilding its list on each render
 * would still *work*.
 *
 * Identity is what shows the difference. A value built once is the same object
 * every time; one rebuilt per call is not.
 */
describe("the catalogues are taken once, not rebuilt per call", () => {
  it("hands back the same array every time", () => {
    for (const [name, read] of [
      ["commands", () => commandDefinitions],
      ["raster tools", () => rasterTools],
      ["raster rules", () => rasterRules],
      ["modals", () => modalDefinitions],
      ["brush presets", () => brushPresets],
      ["inpainting models", () => inpaintModels],
    ] as const) {
      expect(read(), `${name} is rebuilt on every read`).toBe(read());
    }
  });

  it("hands back the same window list for an environment every time", () => {
    // `windowsFor` takes an argument, which is exactly the shape that tempts
    // someone to filter on each call.
    for (const kind of environmentsWithWindows) {
      expect(windowsFor(kind), `${kind} windows are rebuilt on every read`).toBe(windowsFor(kind));
    }
  });

  it("has something in every catalogue", () => {
    // Guards the identity checks above: two empty arrays could otherwise be
    // the same frozen empty value and pass for the wrong reason.
    expect(commandDefinitions.length).toBeGreaterThan(0);
    expect(rasterTools.length).toBeGreaterThan(0);
    expect(rasterRules.length).toBeGreaterThan(0);
    expect(modalDefinitions.length).toBeGreaterThan(0);
    expect(brushPresets.length).toBeGreaterThan(0);
    expect(inpaintModels.length).toBeGreaterThan(0);
    for (const kind of environmentsWithWindows) expect(windowsFor(kind).length, kind).toBeGreaterThan(0);
  });
});
