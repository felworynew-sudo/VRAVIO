import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CommandContext } from "@vravio/kernel";
import { kernel } from "../kernel";
import { playScript } from "./player";
import { commandDefinitionById } from "../commands/registry";
import type { CommandDefinition } from "../commands/types";
import type { Script } from "./types";

/**
 * Stage 9 of docs/migration-plan.md: "воспроизведение с остановкой на ошибке".
 *
 * The commands here are registered for the test rather than borrowed from the
 * catalogue: what is under test is the player's sequencing and its four ways
 * of giving up, and driving that through real commands would mean setting up a
 * document for each and reading the result out of it — a slower test that
 * checks less.
 */
const ran: string[] = [];
const registered: { dispose(): void }[] = [];

const define = (definition: CommandDefinition): void => {
  commandDefinitionById.set(definition.id, definition);
  registered.push(kernel.commands.register({
    id: definition.id,
    label: definition.id,
    category: "Test",
    ...(definition.isEnabled ? { isEnabled: definition.isEnabled } : {}),
    execute: (context, args) => definition.execute(context, args),
  }));
};

const script = (...ids: string[]): Script =>
  ({ id: "s", name: "Test", recordedAt: "", steps: ids.map((commandId) => ({ commandId })) });

const context = (): CommandContext => ({ activeDocumentId: null });

beforeEach(() => {
  ran.length = 0;
  define({ id: "test.one", label: { en: "" }, category: { en: "" }, surfaces: [], execute: () => { ran.push("one"); } });
  define({ id: "test.two", label: { en: "" }, category: { en: "" }, surfaces: [], execute: () => { ran.push("two"); } });
  define({ id: "test.refuses", label: { en: "" }, category: { en: "" }, surfaces: [], isEnabled: () => false, execute: () => { ran.push("refused"); } });
  define({ id: "test.throws", label: { en: "" }, category: { en: "" }, surfaces: [], execute: () => { throw new Error("boom"); } });
  define({
    id: "test.needsRatio", label: { en: "" }, category: { en: "" }, surfaces: [],
    args: { ratio: { kind: "enum", label: { en: "" }, options: ["1:1", "16:9"] } },
    execute: () => { ran.push("ratio"); },
  });
});

afterEach(() => {
  for (const entry of registered) entry.dispose();
  registered.length = 0;
  for (const id of ["test.one", "test.two", "test.refuses", "test.throws", "test.needsRatio"]) commandDefinitionById.delete(id);
});

describe("playing a script", () => {
  it("runs every step in order", async () => {
    const run = await playScript(script("test.one", "test.two"), context);

    expect(ran).toEqual(["one", "two"]);
    expect(run).toEqual({ completed: 2, failure: null });
  });

  it("stops at a step that refuses, and does not run the rest", async () => {
    // Stopping rather than skipping, because the steps are not independent: a
    // script that selects, fills and deselects fills the whole layer if the
    // selection failed and the fill runs anyway.
    const run = await playScript(script("test.one", "test.refuses", "test.two"), context);

    expect(ran).toEqual(["one"]);
    expect(run.completed).toBe(1);
    expect(run.failure).toMatchObject({ step: 2, commandId: "test.refuses", reason: "refused" });
  });

  it("stops at a step that throws, and says so", async () => {
    const run = await playScript(script("test.one", "test.throws", "test.two"), context);

    expect(ran).toEqual(["one"]);
    expect(run.failure).toMatchObject({ step: 2, reason: "threw", detail: "boom" });
  });

  it("stops at a command the build no longer has", async () => {
    // A script outlives the code that recorded it; a renamed command must not
    // be silently skipped.
    const run = await playScript(script("test.one", "test.removedInSomeLaterVersion"), context);

    expect(ran).toEqual(["one"]);
    expect(run.failure).toMatchObject({ step: 2, reason: "unknown" });
  });

  it("stops when a step's arguments do not fit the command's schema", async () => {
    // The same script, older than the command: a ratio that is no longer one of
    // the options must not reach the command as a surprise.
    const stale: Script = { id: "s", name: "Stale", recordedAt: "", steps: [{ commandId: "test.needsRatio", args: { ratio: "7:3" } }] };

    const run = await playScript(stale, context);

    expect(ran).toEqual([]);
    expect(run.failure).toMatchObject({ step: 1, reason: "arguments" });
  });

  it("passes arguments the schema accepts through to the command", async () => {
    const good: Script = { id: "s", name: "Good", recordedAt: "", steps: [{ commandId: "test.needsRatio", args: { ratio: "16:9" } }] };

    expect((await playScript(good, context)).failure).toBeNull();
    expect(ran).toEqual(["ratio"]);
  });

  it("reports an empty script as done rather than as failed", async () => {
    expect(await playScript(script(), context)).toEqual({ completed: 0, failure: null });
  });
});
