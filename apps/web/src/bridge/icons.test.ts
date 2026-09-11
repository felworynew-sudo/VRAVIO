import { describe, expect, it } from "vitest";
import { bridgeIcon } from "./icons";

describe("bridgeIcon", () => {
  it("leaves folders to SVAR's own default", () => {
    expect(bridgeIcon({ type: "folder", ext: "" })).toBe(false);
  });

  it("leaves anything SVAR's own built-in set already covers alone", () => {
    for (const ext of ["png", "jpg", "pdf", "zip", "mp3", "svg", "doc"]) {
      expect(bridgeIcon({ type: "file", ext })).toBe(false);
    }
  });

  it("gives VRAVIO's own project file its app icon, not a generic one", () => {
    const icon = bridgeIcon({ type: "file", ext: "vravio" });
    expect(icon).toContain("логотип цветная плашка.svg");
  });

  it("categorizes formats SVAR does not know about instead of falling through to generic for all of them", () => {
    const categorized = (ext: string) => bridgeIcon({ type: "file", ext });
    // Different categories must not collapse into the same icon — that would defeat the point.
    const distinctExtensions = ["exr", "cr2", "flac", "mkv", "gz", "rs", "ttf"];
    const icons = distinctExtensions.map(categorized);
    expect(new Set(icons).size).toBe(distinctExtensions.length);
    for (const icon of icons) expect(icon).not.toBe(false);
  });

  it("falls back to the generic badge for a genuinely unknown extension, not nothing", () => {
    const icon = bridgeIcon({ type: "file", ext: "xyz123nonsense" });
    expect(icon).toBeTruthy();
    expect(typeof icon).toBe("string");
  });

  it("every returned icon is a well-formed data or asset URL", () => {
    for (const ext of ["exr", "cr2", "flac", "mkv", "gz", "rs", "ttf", "vravio", "unknownformat"]) {
      const icon = bridgeIcon({ type: "file", ext });
      if (icon === false) continue;
      expect(icon.startsWith("data:image/svg+xml") || icon.includes(".svg")).toBe(true);
    }
  });

  it("is case-insensitive on the extension", () => {
    expect(bridgeIcon({ type: "file", ext: "CR2" })).toBe(bridgeIcon({ type: "file", ext: "cr2" }));
  });
});
