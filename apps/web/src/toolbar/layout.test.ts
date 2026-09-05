import { describe, expect, it } from "vitest";
import { defaultLayout, reconcileLayout, sameLayout, type ToolbarLayout } from "./layout";
import { rasterToolGroups, toolsFor } from "../tools";

/**
 * Stage 8 of docs/migration-plan.md. The arrangement is written once and read
 * for as long as the installation lives, while the tool catalogue keeps moving
 * underneath it — so reconciliation is where this can go quietly wrong, and it
 * is most of what is checked here.
 */

const rasterTools = () => toolsFor("raster").map((tool) => tool.id);

describe("the palette's default arrangement", () => {
  it("is Photoshop's grouping for raster, taken from the catalogue", () => {
    expect(defaultLayout("raster").groups).toEqual(rasterToolGroups.map((group) => [...group]));
  });

  it("shows every raster tool and hides none", () => {
    const layout = defaultLayout("raster");
    expect([...layout.groups.flat()].sort()).toEqual([...rasterTools()].sort());
    expect(layout.hidden).toEqual([]);
  });

  it("gives every vector tool a slot of its own", () => {
    // Vector has no groups yet; one tool per slot is what the palette already
    // drew for it, so the default changes nothing anyone can see.
    const layout = defaultLayout("vector");
    expect(layout.groups).toEqual(toolsFor("vector").map((tool) => [tool.id]));
  });
});

describe("a stored arrangement against a catalogue that has moved", () => {
  const first = () => rasterTools()[0]!;

  it("shows a tool the catalogue gained since the layout was written", () => {
    // The failure this prevents: a tool that belongs to no group is drawn by
    // nothing, so a newly added tool would simply never appear for anyone who
    // had ever rearranged their palette — and would look like a bug in the
    // tool, not in the layout.
    const stale: ToolbarLayout = { groups: [[first()]], hidden: [] };

    const reconciled = reconcileLayout(stale, "raster");

    expect([...reconciled.groups.flat()].sort()).toEqual([...rasterTools()].sort());
    // Appended, not woven in: what the user arranged stays where they put it.
    expect(reconciled.groups[0]).toEqual([first()]);
  });

  it("drops a tool the catalogue no longer has", () => {
    const stale: ToolbarLayout = { groups: [[first(), "raster.gone"], ["raster.alsoGone"]], hidden: ["raster.vanished"] };

    const reconciled = reconcileLayout(stale, "raster");

    expect(reconciled.groups.flat()).not.toContain("raster.gone");
    expect(reconciled.groups.flat()).not.toContain("raster.alsoGone");
    expect(reconciled.hidden).not.toContain("raster.vanished");
  });

  it("leaves no empty group behind when its last tool goes", () => {
    // An empty group renders a slot with no glyph in it — a hole in the
    // palette that cannot be clicked and cannot be explained.
    const stale: ToolbarLayout = { groups: [["raster.gone"], [first()]], hidden: [] };

    expect(reconcileLayout(stale, "raster").groups.every((group) => group.length > 0)).toBe(true);
  });

  it("keeps a tool once when a layout names it twice", () => {
    // Drawn twice, the second copy can never be selected away from the first,
    // because both slots report the same active tool.
    const doubled: ToolbarLayout = { groups: [[first()], [first()]], hidden: [] };

    const flat = reconcileLayout(doubled, "raster").groups.flat();

    expect(flat.filter((id) => id === first())).toHaveLength(1);
  });

  it("does not resurrect a hidden tool as a visible one", () => {
    // Hiding is a decision, and reconciliation must not quietly undo it by
    // treating "not in a group" as "missing".
    const hiddenFirst: ToolbarLayout = { groups: rasterToolGroups.slice(1).map((group) => [...group]), hidden: [first()] };

    const reconciled = reconcileLayout(hiddenFirst, "raster");

    expect(reconciled.hidden).toContain(first());
    expect(reconciled.groups.flat()).not.toContain(first());
  });

  it("leaves an arrangement that already agrees with the catalogue alone", () => {
    const layout = defaultLayout("raster");

    expect(reconcileLayout(layout, "raster")).toEqual(layout);
  });
});

describe("saving an arrangement", () => {
  it("treats an arrangement identical to the default as no arrangement at all", () => {
    // Otherwise "Reset to default" stays offered after a reset — it would be
    // there to undo a customisation that is not one.
    expect(sameLayout(defaultLayout("raster"), defaultLayout("raster"))).toBe(true);
  });

  it("tells a real rearrangement apart from the default", () => {
    const moved = defaultLayout("raster");
    const swapped = { groups: [moved.groups[1]!, moved.groups[0]!, ...moved.groups.slice(2)], hidden: moved.hidden };

    expect(sameLayout(swapped, moved)).toBe(false);
  });

  it("notices a tool hidden but nothing else changed", () => {
    const base = defaultLayout("raster");

    expect(sameLayout({ groups: base.groups, hidden: ["raster.magicWand"] }, base)).toBe(false);
  });
});
