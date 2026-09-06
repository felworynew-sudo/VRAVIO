import type { SnapContext, SnapLine, SnapSource } from "../types";

/**
 * Stage 5 of docs/vector-plan.md: deferred at the time because "there is no
 * ruler/guide model for vector at all yet" — stage 15's rulers/guides work
 * (`guide-ops.ts`, `vector-ruler-guides.tsx`) closed that prerequisite, so
 * this source was added rather than left stubbed once it existed.
 *
 * A `VectorGuide`'s own `orientation` already names the axis it constrains,
 * the same convention `vector-ruler-guides.tsx`'s own `guidePointer` uses
 * when it *creates* one: a `"vertical"` guide is a vertical *line*, drawn
 * at one `x`, so it constrains a dragged shape's `x` — `axis: "x"`, not
 * `"vertical"`. `context.guides` is already the caller's resolved,
 * scope-filtered list (`visibleGuides`) — this source does not re-filter
 * by artboard itself, the same "handed the right slice" contract every
 * other source here already has for `shapes`/`excludeIds`.
 */
const guides: SnapSource = {
  id: "guides",
  collect(context: SnapContext): readonly SnapLine[] {
    if (!context.guides?.length) return [];
    return context.guides.map((guide) => ({ axis: guide.orientation === "vertical" ? "x" : "y", value: guide.position, kind: "guide" }));
  },
};

export default guides;
