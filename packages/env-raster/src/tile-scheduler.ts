/**
 * docs/master-plan.md §37.3 item 4 — job-admission control, donor Krita's own
 * `KisStrokesQueue::checkSequentialProperty`/`checkExclusiveProperty`
 * (`libs/image/kis_strokes_queue.cpp`) and the `Sequentiality`/`Exclusivity` enums in
 * `libs/image/kis_stroke_job_strategy.h`. Pure planning/state logic only — no Worker, no DOM,
 * same convention `filter-tiling.ts` already established for this item.
 *
 * Krita's real scheduler has two independent axes: a job's *category* (`MERGE` — background
 * recomposition from `setDirty()` — vs. `STROKE` — an in-progress tool action, vs. `SPONTANEOUS`)
 * and a *stroke job*'s `Sequentiality` (`CONCURRENT`/`SEQUENTIAL`/`BARRIER`/`UNIQUELY_CONCURRENT`).
 * VRAVIO's own painting pipeline never routes interactive strokes through a scheduler at all —
 * `paint-stroke.ts` computes and previews every dab synchronously on the main thread, matching
 * Krita's own reality that dab jobs are SEQUENTIAL and never parallelised — so this port collapses
 * to Krita's single `Sequentiality` axis, applied uniformly to whatever category of background tile
 * work a caller schedules (composite recompute, in the first real consumer). This is a deliberate
 * simplification, not a missing feature: nothing in this codebase needs the MERGE/STROKE category
 * split, because "STROKE" jobs in Krita's sense stay off this scheduler entirely.
 *
 * The four `Sequentiality` values, and what each means for admission, quoted almost verbatim from
 * `checkSequentialProperty`'s real logic (not paraphrased into something that sounds plausible):
 *
 * - `"concurrent"` — may start whenever no `"sequential"`/`"barrier"` job is currently running.
 *   Not gated against other `"concurrent"` or `"uniquelyConcurrent"` jobs at all — this is the
 *   normal case for independent tile work (two different tiles' composites never depend on each
 *   other, Krita's own rationale for why Scale Image scales each layer as its own concurrent job).
 * - `"uniquelyConcurrent"` — concurrent with everything else, except another job sharing the same
 *   `uniqueKey` already running (e.g. "only one thumbnail recompute in flight at a time," while
 *   ordinary tile composites keep running alongside it).
 * - `"sequential"` — refused while any `"concurrent"`/`"uniquelyConcurrent"` job is running, and,
 *   like every job once a `"sequential"` job is active, blocked entirely until it finishes.
 * - `"barrier"` — the strictest: refused while *anything* is running (`"concurrent"`,
 *   `"uniquelyConcurrent"`, or another already-active `"sequential"`/`"barrier"`), and — the same
 *   top-of-function guard applying to every next job — nothing else may start while it runs either.
 *   This is Krita's real mechanism for "the whole batch of tile work must fully drain before this
 *   runs" (Scale Image's own completion signal is emitted from a barrier job for exactly this
 *   reason), not an invented one.
 */

export type TileJobSequentiality = "concurrent" | "sequential" | "barrier" | "uniquelyConcurrent";

export interface TileJobDescriptor {
  readonly id: string;
  readonly sequentiality: TileJobSequentiality;
  /** Required for, and only meaningful on, `"uniquelyConcurrent"` jobs — see the class doc comment. */
  readonly uniqueKey?: string;
}

/**
 * Admission control only: this class does not run anything itself, mirroring `filter-tiling.ts`'s
 * own "planning, not dispatch" split — `apps/web` owns the actual Worker pool and calls `admit`/
 * `release` around real work. Keeping the two separate is what makes the gating logic here testable
 * without a Worker, a `postMessage`, or even a Promise in sight.
 */
export class TileJobScheduler<T extends TileJobDescriptor = TileJobDescriptor> {
  readonly #running = new Map<string, T>();

  get runningCount(): number { return this.#running.size; }
  isRunning(id: string): boolean { return this.#running.has(id); }

  #hasSequentiality(sequentiality: TileJobSequentiality): boolean {
    for (const job of this.#running.values()) if (job.sequentiality === sequentiality) return true;
    return false;
  }

  #hasUniqueKey(uniqueKey: string): boolean {
    for (const job of this.#running.values()) if (job.uniqueKey === uniqueKey) return true;
    return false;
  }

  /**
   * Can `job` start right now, given what is already running? Ports `checkSequentialProperty`'s
   * real gating exactly (see the class doc comment for the source quote this mirrors) — this does
   * not itself reserve the job; call `admit` to actually do that, or check-then-admit racily if the
   * caller is single-threaded JS (it always is here — this class has no concurrency of its own).
   */
  canStart(job: T): boolean {
    // The top guard in Krita's own function applies unconditionally to *every* next job, not only
    // to the next sequential/barrier one — a running sequential or barrier job blocks everything.
    if (this.#hasSequentiality("sequential") || this.#hasSequentiality("barrier")) return false;
    if (job.sequentiality === "uniquelyConcurrent") {
      return job.uniqueKey === undefined || !this.#hasUniqueKey(job.uniqueKey);
    }
    if (job.sequentiality === "sequential") {
      return !this.#hasSequentiality("concurrent") && !this.#hasSequentiality("uniquelyConcurrent");
    }
    if (job.sequentiality === "barrier") {
      return !this.#hasSequentiality("concurrent") && !this.#hasSequentiality("uniquelyConcurrent");
    }
    return true; // "concurrent" — never gated beyond the top guard above.
  }

  /** Reserves `job` as running. Throws if `canStart(job)` was false — callers are expected to
   *  check first (typically inside a dispatch loop that re-checks as slots free up), and an
   *  unconditional admit here would silently corrupt the very invariant this class exists to hold. */
  admit(job: T): void {
    if (!this.canStart(job)) throw new Error(`Tile job "${job.id}" is not admissible right now`);
    if (this.#running.has(job.id)) throw new Error(`Tile job "${job.id}" is already running`);
    this.#running.set(job.id, job);
  }

  /** Marks `id` finished, freeing whatever its sequentiality was blocking. Safe to call for an id
   *  that was never admitted (a no-op) — cleanup code should not have to track admission separately. */
  release(id: string): void {
    this.#running.delete(id);
  }
}
