import type { CommandContext } from "@vravio/kernel";
import { commandDefinitionById } from "../commands/registry";
import { coerceArgs } from "../commands/types";
import { diagnostic } from "../diagnostics";
import { kernel } from "../kernel";
import type { Script, ScriptFailure, ScriptRun } from "./types";

/**
 * Replays a script, stopping at the first step that does not go through.
 *
 * Stopping rather than skipping, because the steps are not independent: a
 * script that selects, then fills, then deselects does the wrong thing if the
 * selection failed and the fill runs anyway — it fills the whole layer. A
 * script is a sequence of decisions that assumed the previous ones held.
 *
 * Four ways a step can fail, kept apart because they mean different things to
 * whoever has to fix the script: the command is gone (the build changed under
 * the script), it refused (`isEnabled` — the document is not in a state where
 * this makes sense), its arguments do not fit its schema (the script is older
 * than the command), or it threw.
 */
export async function playScript(script: Script, context: () => CommandContext): Promise<ScriptRun> {
  for (const [index, step] of script.steps.entries()) {
    const failure = await runStep(step.commandId, step.args, index + 1, context);
    if (failure) {
      diagnostic("warn", "script.play", `"${script.name}" stopped at step ${failure.step} (${failure.commandId}): ${failure.reason}`, failure);
      return { completed: index, failure };
    }
  }
  diagnostic("info", "script.play", `"${script.name}" ran ${script.steps.length} step(s)`);
  return { completed: script.steps.length, failure: null };
}

async function runStep(commandId: string, args: Script["steps"][number]["args"], step: number, context: () => CommandContext): Promise<ScriptFailure | null> {
  const definition = commandDefinitionById.get(commandId);
  if (!definition) return { step, commandId, reason: "unknown" };
  if (!coerceArgs(definition.args, args)) return { step, commandId, reason: "arguments" };

  // The context is asked for per step, not captured once: a script that
  // creates a document and then works on it must see the document it made.
  const now = context();
  if (definition.isEnabled?.(now) === false) return { step, commandId, reason: "refused" };

  try {
    const ran = await kernel.commands.execute(commandId, now, args);
    // `execute` also consults `isEnabled`, and the state can have moved between
    // the check above and the call.
    return ran ? null : { step, commandId, reason: "refused" };
  } catch (error) {
    return { step, commandId, reason: "threw", detail: error instanceof Error ? error.message : String(error) };
  }
}
