import { describe, expect, it } from "vitest";
import { applyDrop } from "./ToolbarEditor";
import type { ToolbarLayout } from "./layout";

/**
 * Stage 8 of docs/migration-plan.md: what a drag actually does to the
 * arrangement. Kept apart from the component so the rules can be stated as
 * arithmetic rather than acted out through a pointer.
 */
const layout = (): ToolbarLayout => ({ groups: [["a"], ["b", "c"], ["d"]], hidden: ["x"] });

describe("dropping a tool", () => {
  it("groups it with the tools already in that slot", () => {
    expect(applyDrop(layout(), "a", { kind: "into", group: 2 })).toEqual({ groups: [["b", "c"], ["d", "a"]], hidden: ["x"] });
  });

  it("gives it a slot of its own when dropped between two", () => {
    expect(applyDrop(layout(), "d", { kind: "between", index: 1 })).toEqual({ groups: [["a"], ["d"], ["b", "c"]], hidden: ["x"] });
  });

  it("lands where the user aimed when dragged downward past its own slot", () => {
    // The off-by-one this exists for: the drop index is read against the list
    // as the user sees it, but the tool has to be removed before it is
    // reinserted, and removing it shifts every index after it up by one. A
    // tool dragged to the end would otherwise stop one place short.
    expect(applyDrop(layout(), "a", { kind: "between", index: 3 })).toEqual({ groups: [["b", "c"], ["d"], ["a"]], hidden: ["x"] });
  });

  it("takes it out of the group it shared when it moves", () => {
    // "b" and "c" shared a slot; moving "b" out must leave "c" holding it
    // alone, not leave a phantom copy behind.
    expect(applyDrop(layout(), "b", { kind: "between", index: 0 })).toEqual({ groups: [["b"], ["a"], ["c"], ["d"]], hidden: ["x"] });
  });

  it("hides it, and stops drawing it in the palette", () => {
    expect(applyDrop(layout(), "b", { kind: "hidden" })).toEqual({ groups: [["a"], ["c"], ["d"]], hidden: ["x", "b"] });
  });

  it("brings a hidden tool back when dropped into the palette", () => {
    expect(applyDrop(layout(), "x", { kind: "into", group: 0 })).toEqual({ groups: [["a", "x"], ["b", "c"], ["d"]], hidden: [] });
  });

  it("leaves no empty slot behind when the last tool leaves it", () => {
    const after = applyDrop(layout(), "a", { kind: "into", group: 1 });
    expect(after.groups.every((group) => group.length > 0)).toBe(true);
  });

  it("changes nothing when the drag ended over no target at all", () => {
    // Releasing the pointer outside every drop zone is a cancelled drag, not a
    // move to position zero.
    expect(applyDrop(layout(), "a", null)).toEqual(layout());
  });
});
