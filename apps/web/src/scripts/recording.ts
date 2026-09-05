import { commandDefinitionById } from "../commands/registry";
import type { ScriptStep } from "./types";

/**
 * Whether a command belongs in a recording.
 *
 * Three refusals, and each is the same mistake in a different coat: recording
 * something whose replay would act on the recording rather than on the
 * document.
 *
 * - `neverRecord`, declared by the command itself (stage 7's field, and this
 *   is the reader it was declared for).
 * - Everything under `script.` — a recorder that records "start recording" and
 *   "stop recording" plays back a script that starts a recording. The script
 *   would not do the work; it would arm the thing that captured it.
 * - Undo and redo. Photoshop refuses these too. A recorded undo replays as an
 *   undo of whatever the *playback* had just done, not of what the recording
 *   did — so a script that ends "…and then undo that" quietly eats a step the
 *   user meant to keep. The user's undos while recording are corrections to
 *   the recording, not part of it.
 *
 * The `script.` prefix and the two history commands are named here rather than
 * left to `neverRecord` alone so that a new `script.*` command cannot be
 * recorded by forgetting a flag.
 */
export function isRecordable(commandId: string): boolean {
  if (commandId.startsWith("script.")) return false;
  if (commandId === "edit.undo" || commandId === "edit.redo") return false;
  return commandDefinitionById.get(commandId)?.neverRecord !== true;
}

/**
 * Collects steps while recording is armed.
 *
 * Deliberately not a React store: commands run from shortcuts, menus and
 * panels, and a recorder that lived in a component would only see the ones
 * dispatched from inside it.
 */
export class ScriptRecorder {
  #steps: ScriptStep[] = [];
  #recording = false;

  get recording(): boolean { return this.#recording; }
  get steps(): readonly ScriptStep[] { return this.#steps; }

  start(): void {
    this.#steps = [];
    this.#recording = true;
  }

  /** Offers a command to the recording; ignored when not recording, or when
   * the command is one of the three kinds above. */
  observe(step: ScriptStep): void {
    if (!this.#recording || !isRecordable(step.commandId)) return;
    this.#steps.push(step.args ? { commandId: step.commandId, args: { ...step.args } } : { commandId: step.commandId });
  }

  /** Ends the recording and hands back what it caught. */
  stop(): readonly ScriptStep[] {
    this.#recording = false;
    const steps = this.#steps;
    this.#steps = [];
    return steps;
  }
}
