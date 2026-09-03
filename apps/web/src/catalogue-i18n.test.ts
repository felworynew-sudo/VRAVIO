import { describe, expect, it } from "vitest";

/**
 * Stage 1 of docs/migration-plan.md: catalogue definitions (tools, commands,
 * environments) must carry `label`/`category`/`title` as structured
 * `LocalizedText` data, not a hand-typed "English (Русский)" literal for
 * `localized()` to regex-parse back apart.
 *
 * That shape was fragile in a way that already produced a real bug: joining
 * several such strings together (registerToolShortcuts' per-shortcut-letter
 * tool switch, before this stage) let `localized()`'s regex match the
 * *last* parenthesised pair in the joined string and silently drop every
 * other language segment. A definition with no such literal at all cannot
 * repeat that failure.
 *
 * This reads the source files as text (via Vite's `?raw` import, the same
 * mechanism the panel registries' `import.meta.glob` already relies on —
 * not Node's `fs`, which would need `@types/node` added to a browser app
 * for the sake of one test) rather than importing and inspecting the
 * runtime values, because the failure mode is "someone typed a bilingual
 * string" — a source-level habit — not a runtime shape a type-level check
 * would catch once the literal has already been assigned to a field typed
 * `LocalizedText | string` by a wider signature somewhere.
 */

const catalogueSources = import.meta.glob<string>(
  ["./tools.ts", "./commands.ts", "./environment.ts"],
  { eager: true, query: "?raw", import: "default" },
);

// `label`/`category`/`title` followed by a string literal that contains a
// parenthesised group with a Cyrillic character in it — the exact shape
// every converted definition used to have. Restricted to a single line
// (JS string literals here never span lines) so it cannot accidentally
// bridge two unrelated string literals separated by other code.
const BILINGUAL_LITERAL = /\b(?:label|category|title)\s*:\s*"[^"\n]*\([^)\n]*[а-яёА-ЯЁ][^)\n]*\)[^"\n]*"/;

describe("catalogue definitions carry structured labels, not bilingual literals", () => {
  const entries = Object.entries(catalogueSources);
  it("found the catalogue files this test is supposed to check", () => {
    expect(entries.length).toBe(3);
  });

  for (const [path, source] of entries) {
    it(`${path} has no hand-typed "English (Русский)" label/category/title`, () => {
      const match = source.match(BILINGUAL_LITERAL);

      // Reporting the match itself, not just pass/fail: this is exactly the
      // kind of failure that is annoying to hunt down from "test failed"
      // alone once the file has grown to hundreds of definitions.
      expect(match?.[0] ?? null).toBeNull();
    });
  }
});
