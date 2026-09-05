import { describe, expect, it } from "vitest";

/**
 * Stage 6 of docs/migration-plan.md: "the object that reached the screen is
 * the same object that reached storage".
 *
 * This is the property section 4.4 of the plan was written after. A
 * checkpoint existed then too — `commitPixels` confined the edit to the
 * selection and showed the confined result — but the line below it handed the
 * *unconfined* buffer to the asset revision, so the screen was honest and the
 * first redo put the escaped pixels back (fixed in `b7c1f84`). Two expressions
 * that ought to produce the same buffer are exactly how that happens; one
 * binding used twice cannot.
 *
 * Read as source text, via the same `?raw` mechanism `catalogue-i18n.test.ts`
 * uses, because the property is structural: at runtime both consumers would
 * simply receive whatever they were given, and a test that called them could
 * only re-check the arithmetic, not that there is one buffer to begin with.
 * Driving the real thing would mean mounting the React hook this lives in.
 */

const source = Object.values(
  import.meta.glob<string>("../raster-commit.ts", { eager: true, query: "?raw", import: "default" }),
)[0] ?? "";

/** The body of `commitPixels`, from its declaration to the next one. */
const commitPixels = (() => {
  const start = source.indexOf("const commitPixels = async");
  const end = source.indexOf("\n  const commitDocumentState", start);
  return start < 0 || end < 0 ? "" : source.slice(start, end);
})();

describe("one buffer reaches the screen and storage", () => {
  it("found the commit path this test is supposed to read", () => {
    expect(source.length).toBeGreaterThan(0);
    expect(commitPixels.length).toBeGreaterThan(0);
  });

  it("runs the rules before anything is written or recorded", () => {
    const rules = commitPixels.indexOf("applyRasterRules(");
    expect(rules).toBeGreaterThanOrEqual(0);
    // Showing or storing an edit the rules have not seen yet is the failure
    // this ordering exists to prevent.
    for (const consumer of ["assign(", "history.record(", "commitRevision("]) {
      expect(commitPixels.indexOf(consumer), consumer + " runs before the rules do").toBeGreaterThan(rules);
    }
  });

  it("binds the ruled edit once and hands that same binding to both consumers", () => {
    const binding = /const (\w+) = edit\.after;/.exec(commitPixels);
    expect(binding, "the ruled buffer is not bound to a single name").not.toBeNull();
    const name = binding![1]!;

    // The screen.
    expect(commitPixels).toContain("assign(" + name + ")");
    // The asset revision, which is what redo and every later reload restore from.
    expect(commitPixels).toContain("toBytes(" + name + ",");
  });

  it("repaints the canvas when a rule refuses the edit", () => {
    // A refused edit is the one case where the screen can be left saying
    // something the document never agreed to: painting tools draw straight to
    // the canvas as the gesture runs (`schedulePreview`), and a veto changes
    // no document revision, so nothing else will ever repaint over the stroke
    // that was refused. Found live: locking a layer's pixels and then dragging
    // the brush left the stroke on screen indefinitely while `layer.bounds`
    // proved nothing had been committed.
    const veto = commitPixels.indexOf("if (!outcome.edit)");
    expect(veto, "the veto branch is not where this test thinks it is").toBeGreaterThanOrEqual(0);
    const branch = commitPixels.slice(veto, commitPixels.indexOf("const edit = outcome.edit", veto));

    expect(branch, "the veto branch leaves the preview on screen").toContain("putPixels(");
    // From `state`, which is the document as it stands with the edit refused —
    // repainting from either of the edit's own buffers would put the refused
    // pixels back on screen just as surely as not repainting at all.
    expect(branch).toContain("compositeRasterDocument(state)");
  });

  it("never hands a consumer the buffer the tool submitted, before the rules", () => {
    // `after` is the raw parameter. Reaching either consumer with it is the
    // b7c1f84 regression, in the shape it actually had.
    expect(commitPixels).not.toMatch(/assign\(\s*after\s*\)/);
    expect(commitPixels).not.toMatch(/toBytes\(\s*after\s*,/);
  });
});
