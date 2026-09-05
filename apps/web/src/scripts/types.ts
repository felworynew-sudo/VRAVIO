import type { CommandArgs } from "@vravio/kernel";

/**
 * One recorded command, with the values it was invoked with.
 *
 * A step is an id and its arguments and nothing else — no captured document
 * state, no coordinates. That is the deliberate boundary of what a script is
 * here: it replays *decisions*, not their results, so a script recorded on one
 * document does something sensible on another.
 */
export interface ScriptStep {
  readonly commandId: string;
  readonly args?: CommandArgs;
}

export interface Script {
  readonly id: string;
  readonly name: string;
  readonly steps: readonly ScriptStep[];
  /** When it was recorded, so the list can be ordered by something. */
  readonly recordedAt: string;
}

/** Why playback stopped, when it stopped early. */
export interface ScriptFailure {
  /** Which step, counting from one, as the user sees them. */
  readonly step: number;
  readonly commandId: string;
  readonly reason: "unknown" | "refused" | "arguments" | "threw";
  readonly detail?: string;
}

export interface ScriptRun {
  readonly completed: number;
  readonly failure: ScriptFailure | null;
}
