import { diagnostic } from "../diagnostics";
import { startupStages, type StartupStage } from "./stages";

export interface StageOutcome {
  readonly id: string;
  readonly stage: StartupStage;
  readonly status: "done" | "failed";
  readonly detail: string;
  readonly ms: number;
}

/**
 * Runs the startup stages in order, and never lets one of them stop the
 * application from opening.
 *
 * A stage that throws is recorded and stepped over. Startup is exactly the
 * wrong place to be strict: a font enumeration that the user declined, an
 * asset store that a private window will not open, a restored session written
 * by a newer build — none of those are reasons to leave someone staring at a
 * blank page with no way in. The editor opens; the failure is on the screen
 * they were just looking at and in the diagnostics log.
 *
 * In order rather than in parallel, because the order is real: the session
 * restore needs the asset store's documents, and running them together would
 * turn a legible sequence into a race whose timings mean nothing.
 */
export async function runStartup(onProgress: (outcomes: readonly StageOutcome[]) => void): Promise<readonly StageOutcome[]> {
  const outcomes: StageOutcome[] = [];

  for (const stage of startupStages) {
    const started = performance.now();
    try {
      const detail = await stage.run();
      outcomes.push({ id: stage.id, stage, status: "done", detail, ms: Math.round(performance.now() - started) });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      diagnostic("error", `startup.${stage.id}`, detail, error);
      outcomes.push({ id: stage.id, stage, status: "failed", detail, ms: Math.round(performance.now() - started) });
    }
    onProgress([...outcomes]);
  }

  const total = outcomes.reduce((sum, outcome) => sum + outcome.ms, 0);
  const failed = outcomes.filter((outcome) => outcome.status === "failed");
  diagnostic(failed.length ? "warn" : "info", "startup", `Started in ${total}ms${failed.length ? `, ${failed.length} stage(s) failed` : ""}`,
    Object.fromEntries(outcomes.map((outcome) => [outcome.id, `${outcome.status} ${outcome.ms}ms: ${outcome.detail}`])));
  return outcomes;
}
