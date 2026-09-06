import { describe, expect, it } from "vitest";
import { importedShapesFromJson } from "@vravio/env-vector";
import { importSvgToJson } from "./vector-svg-wasm";

// No `node:fs`/`node:path` static imports here — this is a browser-only
// app with no `@types/node` anywhere in it (see vector-geometry-wasm.ts's
// own doc comment for why: it pulls in Node's ambient setTimeout/Timeout
// overrides, which broke unrelated DOM code the one time this was tried).
// This test file only ever runs under Vitest's Node environment, never
// bundled for a browser, so the untyped-dynamic-import escape hatch is
// safe to reuse here too.
interface NodeFs { readdirSync(path: string): string[]; readFileSync(path: string, encoding: string): string }
interface NodePath { join(...parts: string[]): string }
const nodeImport = (specifier: string) => import(/* @vite-ignore */ specifier) as Promise<unknown>;
const fs = (await nodeImport("node:fs")) as NodeFs;
const path = (await nodeImport("node:path")) as NodePath;
const currentDir = new URL(".", import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1");

/**
 * Stage 10 of docs/vector-plan.md's regression set: "a dozen real foreign
 * SVGs, not ones drawn to fit." These sixteen come from
 * simple-icons (github.com/simple-icons/simple-icons, CC0) — real,
 * independently-authored, minified single-path icon SVGs, exactly what
 * "not drawn to fit our own needs" is asking for.
 *
 * They're single flat-colour paths (no gradients, no groups) — simple-
 * icons' whole format. Real-world gradient- and group-bearing SVG fixtures
 * under a clearly permissive license weren't sourced in the time this
 * stage had; gradient and group *handling* is covered by
 * `vector-svg-import.test.ts`'s hand-authored fixtures instead, which is a
 * narrower guarantee than "a real file with a gradient parses correctly."
 * Recorded here rather than silently substituted.
 *
 * The check itself: every fixture parses without throwing and produces at
 * least one shape with a non-trivial `d` — a smoke test, not a pixel-exact
 * one (that's `vector-svg.crosscheck.test.ts`'s job, and only for shapes
 * this app itself constructs, not arbitrary imported ones). What makes it
 * a *regression* test is that these fixture files are committed: a change
 * that starts crashing or empty-importing any of them fails this test
 * without anyone needing to remember to write a new case for it.
 */
const fixturesDir = path.join(currentDir, "svg-regression-fixtures");
const fixtures = fs.readdirSync(fixturesDir).filter((name) => name.endsWith(".svg"));

describe("SVG import regression set — real foreign files", () => {
  it("found at least a dozen fixture files", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(12);
  });

  for (const fixture of fixtures) {
    it(`imports ${fixture} without throwing, producing at least one shape`, async () => {
      const svgText = fs.readFileSync(path.join(fixturesDir, fixture), "utf8");
      const json = await importSvgToJson(svgText);
      const shapes = importedShapesFromJson(json);
      expect(shapes.length).toBeGreaterThan(0);
      for (const shape of shapes) {
        expect(shape.kind).toBe("path");
        if (shape.kind === "path") expect(shape.points.length).toBeGreaterThan(1);
      }
    });
  }
});
