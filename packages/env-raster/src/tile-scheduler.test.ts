import { describe, expect, it } from "vitest";
import { TileJobScheduler, type TileJobDescriptor } from "./tile-scheduler";

/**
 * Every case here is drawn directly from Krita's own `KisStrokesQueue::checkSequentialProperty`
 * (docs/master-plan.md §37.3 item 4's donor research), not invented — each `it` names the exact
 * rule it is checking so a mismatch points straight back to which line of the donor logic broke.
 */
describe("TileJobScheduler (Krita KisStrokesQueue::checkSequentialProperty port)", () => {
  const job = (id: string, sequentiality: TileJobDescriptor["sequentiality"], uniqueKey?: string): TileJobDescriptor =>
    uniqueKey === undefined ? { id, sequentiality } : { id, sequentiality, uniqueKey };

  it("admits a concurrent job with nothing running", () => {
    const scheduler = new TileJobScheduler();
    expect(scheduler.canStart(job("a", "concurrent"))).toBe(true);
  });

  it("admits any number of concurrent jobs alongside each other", () => {
    const scheduler = new TileJobScheduler();
    scheduler.admit(job("a", "concurrent"));
    expect(scheduler.canStart(job("b", "concurrent"))).toBe(true);
    scheduler.admit(job("b", "concurrent"));
    expect(scheduler.runningCount).toBe(2);
  });

  it("uniquelyConcurrent refuses a second job sharing the same uniqueKey", () => {
    const scheduler = new TileJobScheduler();
    scheduler.admit(job("thumb-1", "uniquelyConcurrent", "thumbnail"));
    expect(scheduler.canStart(job("thumb-2", "uniquelyConcurrent", "thumbnail"))).toBe(false);
  });

  it("uniquelyConcurrent admits a job with a different uniqueKey", () => {
    const scheduler = new TileJobScheduler();
    scheduler.admit(job("thumb-1", "uniquelyConcurrent", "thumbnail"));
    expect(scheduler.canStart(job("preview-1", "uniquelyConcurrent", "preview"))).toBe(true);
  });

  it("uniquelyConcurrent does not block, and is not blocked by, plain concurrent jobs", () => {
    const scheduler = new TileJobScheduler();
    scheduler.admit(job("tile-1", "concurrent"));
    expect(scheduler.canStart(job("thumb-1", "uniquelyConcurrent", "thumbnail"))).toBe(true);
    scheduler.admit(job("thumb-1", "uniquelyConcurrent", "thumbnail"));
    expect(scheduler.canStart(job("tile-2", "concurrent"))).toBe(true);
  });

  it("sequential is refused while a concurrent job is running", () => {
    const scheduler = new TileJobScheduler();
    scheduler.admit(job("tile-1", "concurrent"));
    expect(scheduler.canStart(job("seq-1", "sequential"))).toBe(false);
  });

  it("sequential is refused while a uniquelyConcurrent job is running", () => {
    const scheduler = new TileJobScheduler();
    scheduler.admit(job("thumb-1", "uniquelyConcurrent", "thumbnail"));
    expect(scheduler.canStart(job("seq-1", "sequential"))).toBe(false);
  });

  it("sequential is admitted when nothing is running", () => {
    const scheduler = new TileJobScheduler();
    expect(scheduler.canStart(job("seq-1", "sequential"))).toBe(true);
  });

  it("a running sequential job blocks every other job, concurrent included", () => {
    const scheduler = new TileJobScheduler();
    scheduler.admit(job("seq-1", "sequential"));
    expect(scheduler.canStart(job("tile-1", "concurrent"))).toBe(false);
    expect(scheduler.canStart(job("thumb-1", "uniquelyConcurrent", "thumbnail"))).toBe(false);
    expect(scheduler.canStart(job("seq-2", "sequential"))).toBe(false);
    expect(scheduler.canStart(job("barrier-1", "barrier"))).toBe(false);
  });

  it("barrier is refused while a concurrent job is running", () => {
    const scheduler = new TileJobScheduler();
    scheduler.admit(job("tile-1", "concurrent"));
    expect(scheduler.canStart(job("barrier-1", "barrier"))).toBe(false);
  });

  it("barrier is refused while a uniquelyConcurrent job is running", () => {
    const scheduler = new TileJobScheduler();
    scheduler.admit(job("thumb-1", "uniquelyConcurrent", "thumbnail"));
    expect(scheduler.canStart(job("barrier-1", "barrier"))).toBe(false);
  });

  it("barrier is admitted when nothing is running", () => {
    const scheduler = new TileJobScheduler();
    expect(scheduler.canStart(job("barrier-1", "barrier"))).toBe(true);
  });

  it("a running barrier job blocks every other job, concurrent included", () => {
    const scheduler = new TileJobScheduler();
    scheduler.admit(job("barrier-1", "barrier"));
    expect(scheduler.canStart(job("tile-1", "concurrent"))).toBe(false);
    expect(scheduler.canStart(job("thumb-1", "uniquelyConcurrent", "thumbnail"))).toBe(false);
    expect(scheduler.canStart(job("seq-1", "sequential"))).toBe(false);
    expect(scheduler.canStart(job("barrier-2", "barrier"))).toBe(false);
  });

  it("release frees whatever the released job was blocking", () => {
    const scheduler = new TileJobScheduler();
    scheduler.admit(job("seq-1", "sequential"));
    expect(scheduler.canStart(job("tile-1", "concurrent"))).toBe(false);
    scheduler.release("seq-1");
    expect(scheduler.canStart(job("tile-1", "concurrent"))).toBe(true);
    expect(scheduler.runningCount).toBe(0);
  });

  it("release on an id that was never admitted is a harmless no-op", () => {
    const scheduler = new TileJobScheduler();
    expect(() => scheduler.release("never-admitted")).not.toThrow();
    expect(scheduler.runningCount).toBe(0);
  });

  it("admit throws when the job is not currently admissible", () => {
    const scheduler = new TileJobScheduler();
    scheduler.admit(job("seq-1", "sequential"));
    expect(() => scheduler.admit(job("tile-1", "concurrent"))).toThrow();
  });

  it("admit throws on a duplicate id even if the sequentiality would otherwise allow it", () => {
    const scheduler = new TileJobScheduler();
    scheduler.admit(job("tile-1", "concurrent"));
    expect(() => scheduler.admit(job("tile-1", "concurrent"))).toThrow();
  });

  it("isRunning reflects admitted-but-not-released jobs", () => {
    const scheduler = new TileJobScheduler();
    expect(scheduler.isRunning("tile-1")).toBe(false);
    scheduler.admit(job("tile-1", "concurrent"));
    expect(scheduler.isRunning("tile-1")).toBe(true);
    scheduler.release("tile-1");
    expect(scheduler.isRunning("tile-1")).toBe(false);
  });

  it("a full drain-and-barrier sequence: concurrent tiles must finish before a barrier can start, matching Scale Image's own use of a barrier as a completion sync point", () => {
    const scheduler = new TileJobScheduler();
    scheduler.admit(job("tile-1", "concurrent"));
    scheduler.admit(job("tile-2", "concurrent"));
    expect(scheduler.canStart(job("export-barrier", "barrier"))).toBe(false);
    scheduler.release("tile-1");
    expect(scheduler.canStart(job("export-barrier", "barrier"))).toBe(false);
    scheduler.release("tile-2");
    expect(scheduler.canStart(job("export-barrier", "barrier"))).toBe(true);
  });
});
