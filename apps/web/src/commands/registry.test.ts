import { describe, expect, it } from "vitest";
import { commandDefinitions } from "./registry";
import type { CommandSurface } from "./types";

/**
 * Stage 7 of docs/migration-plan.md. What the catalogue itself has to hold
 * true, as opposed to `catalogue.test.ts`, which checks that the move into it
 * changed nothing.
 */
describe("the command catalogue", () => {
  it("found the definition files", () => {
    // A glob that matches nothing would make every other check here pass.
    expect(commandDefinitions.length).toBe(80);
  });

  it("gives every command its own id", () => {
    const ids = commandDefinitions.map((definition) => definition.id);
    expect(new Set(ids).size, `duplicate ids: ${ids.filter((id, index) => ids.indexOf(id) !== index).join(", ")}`).toBe(ids.length);
  });

  it("says where every command belongs", () => {
    // A command with nowhere to appear is unreachable except by shortcut, and
    // one that says nothing is a command the menus cannot place. Either is a
    // definition someone forgot to finish rather than a decision.
    const known: readonly CommandSurface[] = ["menu", "palette", "layer-context", "canvas-context", "toolbar"];
    for (const definition of commandDefinitions) {
      expect(definition.surfaces.length, `${definition.id} declares no surface`).toBeGreaterThan(0);
      for (const surface of definition.surfaces) expect(known, `${definition.id}: unknown surface "${surface}"`).toContain(surface);
    }
  });

  it("does not put two commands on the same key in the same scope", () => {
    // Two commands sharing a shortcut means one of them silently never runs,
    // and which one depends on registration order.
    const seen = new Map<string, string>();
    for (const definition of commandDefinitions) {
      if (!definition.shortcut) continue;
      const key = `${definition.scope ?? "global"}:${definition.shortcut}`;
      expect(seen.get(key), `${definition.id} takes ${key}, already held by ${seen.get(key)}`).toBeUndefined();
      seen.set(key, definition.id);
    }
  });

});
