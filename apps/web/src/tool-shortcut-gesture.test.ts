import { describe, expect, it } from "vitest";
import { keepsZoomAfterShortcut, TOOL_SHORTCUT_TAP_MS, zoomToolForShortcutCommand } from "./tool-shortcut-gesture";

describe("temporary Zoom shortcut", () => {
  it("recognises Zoom by command identity, not specifically the Z physical key", () => {
    expect(zoomToolForShortcutCommand("tool.raster.z", "raster", "raster.brush", false)).toBe("raster.zoom");
    // The keymap can bind this same command to any key; the command id is the
    // stable source of truth, so a custom binding keeps the same behaviour.
    expect(zoomToolForShortcutCommand("tool.vector.z", "vector", "vector.select", false)).toBe("vector.zoom");
  });

  it("does not turn another shortcut group into a temporary Zoom gesture", () => {
    expect(zoomToolForShortcutCommand("tool.raster.b", "raster", "raster.brush", false)).toBeNull();
    expect(zoomToolForShortcutCommand("view.zoomIn", "raster", "raster.brush", false)).toBeNull();
  });

  it("keeps Zoom after a quick tap and restores the previous tool after a hold or drag", () => {
    expect(keepsZoomAfterShortcut(TOOL_SHORTCUT_TAP_MS, false)).toBe(true);
    expect(keepsZoomAfterShortcut(TOOL_SHORTCUT_TAP_MS + 1, false)).toBe(false);
    expect(keepsZoomAfterShortcut(1, true)).toBe(false);
  });
});
