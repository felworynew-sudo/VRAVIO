import { beforeEach, describe, expect, it } from "vitest";
import { ensureCommandsRegistered } from "../commands";
import { isRecordable, ScriptRecorder } from "./recording";
import { commandDefinitions } from "../commands/registry";

/**
 * Stage 9 of docs/migration-plan.md, and specifically its last line: "запись
 * сценария не записывает саму себя".
 */
beforeEach(() => { ensureCommandsRegistered(); });

describe("what a recording refuses to record", () => {
  it("refuses every script command, so a recording cannot record itself", () => {
    // The failure this exists for: a script whose first step is "start
    // recording" does not do the work when played — it arms the recorder that
    // captured it, and the user watches their script record a new empty one.
    const scriptCommands = commandDefinitions.filter((definition) => definition.id.startsWith("script."));
    expect(scriptCommands.length, "no script commands to check").toBeGreaterThan(0);

    for (const definition of scriptCommands) {
      expect(isRecordable(definition.id), `${definition.id} would be recorded`).toBe(false);
    }
  });

  it("refuses a script command even if someone forgets `neverRecord`", () => {
    // Belt and braces, and the belt is the prefix: a `script.*` command added
    // later without the flag must still be refused.
    expect(isRecordable("script.somethingAddedLater")).toBe(false);
  });

  it("refuses undo and redo", () => {
    // A recorded undo replays as an undo of whatever the *playback* just did,
    // not of what the recording did — so it eats a step the user meant to keep.
    // Undos made while recording are corrections to the recording.
    expect(isRecordable("edit.undo")).toBe(false);
    expect(isRecordable("edit.redo")).toBe(false);
  });

  it("refuses every command that declares `neverRecord`", () => {
    const declared = commandDefinitions.filter((definition) => definition.neverRecord);
    expect(declared.length, "nothing declares neverRecord").toBeGreaterThan(0);
    for (const definition of declared) expect(isRecordable(definition.id), definition.id).toBe(false);
  });

  it("records an ordinary command", () => {
    // Guards the four checks above against passing because `isRecordable`
    // refuses everything.
    expect(isRecordable("layer.new")).toBe(true);
  });
});

describe("the recorder", () => {
  it("catches nothing until it is started", () => {
    const recorder = new ScriptRecorder();
    recorder.observe({ commandId: "layer.new" });

    expect(recorder.steps).toEqual([]);
  });

  it("keeps the arguments a command was given", () => {
    // Without these a replayed Smart Crop would not know which ratio, and the
    // step would be a decision with its content removed.
    const recorder = new ScriptRecorder();
    recorder.start();
    recorder.observe({ commandId: "image.smartCrop", args: { ratio: "16:9" } });

    expect(recorder.steps).toEqual([{ commandId: "image.smartCrop", args: { ratio: "16:9" } }]);
  });

  it("copies the arguments rather than holding the caller's object", () => {
    const recorder = new ScriptRecorder();
    recorder.start();
    const args = { ratio: "16:9" };
    recorder.observe({ commandId: "image.smartCrop", args });
    (args as Record<string, string>).ratio = "1:1";

    expect(recorder.steps[0]?.args).toEqual({ ratio: "16:9" });
  });

  it("drops the refused commands from a mixed recording", () => {
    const recorder = new ScriptRecorder();
    recorder.start();
    recorder.observe({ commandId: "layer.new" });
    recorder.observe({ commandId: "edit.undo" });
    recorder.observe({ commandId: "script.record" });
    recorder.observe({ commandId: "layer.duplicate" });

    expect(recorder.stop().map((step) => step.commandId)).toEqual(["layer.new", "layer.duplicate"]);
  });

  it("starts empty again after stopping", () => {
    // Otherwise the next recording opens holding the previous one's steps, and
    // the user records one thing and saves two.
    const recorder = new ScriptRecorder();
    recorder.start();
    recorder.observe({ commandId: "layer.new" });
    recorder.stop();
    recorder.start();

    expect(recorder.steps).toEqual([]);
  });
});
