import { describe, expect, it } from "vitest";
import { srgb } from "@vravio/kernel";
import { addPaletteColor, removePaletteColor, renamePaletteColor, reseedPaletteIdCounter, updatePaletteColor } from "./palette-ops";
import { createVectorDocument } from "./document";

describe("palette-ops", () => {
  it("adds a colour with a plain default name when none is given", () => {
    const document = createVectorDocument();
    const entry = addPaletteColor(document, srgb(91, 224, 179));
    expect(document.palette).toHaveLength(1);
    expect(document.palette[0]).toBe(entry);
    expect(entry.name).toContain("1");
    expect(entry.color).toEqual(srgb(91, 224, 179));
  });

  it("adds a colour with a caller-supplied name", () => {
    const document = createVectorDocument();
    const entry = addPaletteColor(document, srgb(0, 0, 0), "Brand Black");
    expect(entry.name).toBe("Brand Black");
  });

  it("removes a colour by id, leaving the rest untouched", () => {
    const document = createVectorDocument();
    const a = addPaletteColor(document, srgb(255, 0, 0));
    const b = addPaletteColor(document, srgb(0, 255, 0));
    removePaletteColor(document, a.id);
    expect(document.palette).toEqual([b]);
  });

  it("renames a colour without touching its actual colour value", () => {
    const document = createVectorDocument();
    const entry = addPaletteColor(document, srgb(10, 20, 30), "Old Name");
    renamePaletteColor(document, entry.id, "New Name");
    expect(document.palette[0]!.name).toBe("New Name");
    expect(document.palette[0]!.color).toEqual(srgb(10, 20, 30));
  });

  it("updates a colour's value without touching its name", () => {
    const document = createVectorDocument();
    const entry = addPaletteColor(document, srgb(10, 20, 30), "Stays Named");
    updatePaletteColor(document, entry.id, srgb(200, 200, 200));
    expect(document.palette[0]!.name).toBe("Stays Named");
    expect(document.palette[0]!.color).toEqual(srgb(200, 200, 200));
  });

  it("reseeds the id counter past a restored document's own palette ids, so a fresh session's next entry cannot collide", () => {
    const persisted = createVectorDocument();
    persisted.palette = [{ id: "palette-7", name: "Existing", color: srgb(1, 2, 3) }];
    reseedPaletteIdCounter(persisted);

    const created = addPaletteColor(persisted, srgb(4, 5, 6));
    expect(created.id).not.toBe("palette-7");
  });
});
