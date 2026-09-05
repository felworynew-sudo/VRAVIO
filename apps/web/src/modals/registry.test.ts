import { describe, expect, it } from "vitest";
import { modalById, modalDefinitions } from "./registry";

/**
 * Stage 7 of docs/migration-plan.md: `modals/` with a registry, and a modal
 * opened by id rather than by importing its component.
 */
describe("the modal catalogue", () => {
  it("found the definition files", () => {
    expect(modalDefinitions.length).toBeGreaterThan(0);
  });

  it("gives every modal its own id and a component to render", () => {
    const ids = modalDefinitions.map((definition) => definition.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const definition of modalDefinitions) expect(typeof definition.component, definition.id).toBe("function");
  });

  it("holds the modals the shell opens by id", () => {
    // These three ids are written as strings at their call sites — a rename
    // here with no rename there produces a modal that never appears, and the
    // caller waiting on the answer simply never continues.
    for (const id of ["confirm", "error", "new-document"]) expect(modalById.has(id), `nothing registered as "${id}"`).toBe(true);
  });
});
