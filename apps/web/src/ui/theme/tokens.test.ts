import { describe, expect, it } from "vitest";

/**
 * Vite hands a CSS import back as an empty string under the test transform —
 * stylesheets are stubbed there rather than parsed — so `?raw` finds the file
 * but returns nothing. The stylesheet is therefore read off disk.
 *
 * Only the one function that needs is declared, rather than adding
 * `@types/node` to a browser app: those types would also replace
 * `setTimeout`'s browser return type with Node's `Timeout` object across
 * every file here, which is a large change to make for one test's sake.
 */
declare function require(id: "node:fs"): { readFileSync(path: string, encoding: "utf-8"): string };

const styles = require("node:fs").readFileSync(new URL("../../styles.css", import.meta.url).pathname, "utf-8");

/**
 * Stage 2 of docs/migration-plan.md: the palette is one set of tokens, and a
 * colour written straight into a rule is the exception that has to justify
 * itself.
 *
 * The plan's own wording for this stage was "styles.css contains no colours
 * outside tokens". Held to the letter that is the wrong goal, and measuring
 * it showed why: a transparency checkerboard, the hue strip in the colour
 * picker, the red/green/blue channel indicators and the marching-ants
 * overlays are all fixed by meaning, not by theme. Worse, the canvas
 * overlays *must not* follow the theme — a cursor ring drawn in the light
 * theme's ink disappears against light artwork, which is exactly why they
 * are painted as a dark halo under a light pen (see CLAUDE.md on borrowing
 * Patchy's cursor treatment).
 *
 * So the rule this test actually enforces is the useful half: interface
 * chrome — dialogs, panels, buttons, fields — goes through tokens, and
 * everything else is listed below with the reason it is not chrome. A new
 * literal colour in a dialog fails; a new checkerboard has to be added here
 * deliberately, with a reason, which is the point.
 */

/** Selector fragments whose literal colours are deliberate, and why. */
const ALLOWED: readonly { readonly match: string; readonly reason: string }[] = [
  { match: "cursor-ring", reason: "canvas overlay: legible over any artwork, not over a theme" },
  { match: "cursor-crosshair", reason: "canvas overlay: dark halo under a light pen" },
  { match: "selection-overlay", reason: "marching ants: fixed black/white pair over artwork" },
  { match: "selection-hard-edge", reason: "marching ants over artwork" },
  { match: "selection-soft-edge", reason: "marching ants over artwork" },
  { match: "liquify-brush-cursor", reason: "canvas overlay over artwork" },
  { match: "eyedropper-loupe", reason: "canvas overlay over artwork" },
  { match: "eyedropper-chip", reason: "canvas overlay over artwork" },
  { match: "transform-", reason: "canvas handles drawn over artwork" },
  { match: "guide-overlay", reason: "canvas overlay over artwork" },
  { match: "patch-source-path", reason: "canvas overlay over artwork" },
  { match: "text-frame-draft", reason: "canvas overlay over artwork" },
  { match: "vector-handle", reason: "canvas overlay over artwork" },
  { match: "vector-node", reason: "canvas overlay over artwork" },
  { match: "curve-line", reason: "plotted data over its own graph" },
  { match: "curve-baseline", reason: "plotted data over its own graph" },
  { match: "brush-cursor", reason: "canvas overlay over artwork" },
  { match: "clone-source-cursor", reason: "canvas overlay over artwork" },

  { match: "raster-stage", reason: "transparency checkerboard: a fixed convention, not a theme colour" },
  { match: "vector-stage", reason: "transparency checkerboard" },
  { match: "navigator-stage", reason: "transparency checkerboard" },
  { match: "export-preview", reason: "transparency checkerboard" },
  { match: "layer-thumb", reason: "transparency checkerboard" },
  { match: "vector-image-placeholder", reason: "transparency checkerboard" },

  { match: "color-picker-hue", reason: "the hue strip is the spectrum itself" },
  { match: "color-picker-marker", reason: "marker over arbitrary colour" },
  { match: "color-wells", reason: "shows the chosen colour" },
  { match: "reset-colors", reason: "the default black and white swatches" },
  { match: "blend-gradient", reason: "a black-to-white ramp is the control" },
  { match: "gradient-map-preview", reason: "shows the gradient itself" },
  { match: "preset-shape", reason: "brush preset silhouette" },
  { match: "layer-color-label", reason: "Photoshop's layer label colours: red means red" },
  { match: "layer-mask-thumb", reason: "a mask is drawn in black and white" },
  { match: "layer-kind-icon", reason: "badge over an arbitrary thumbnail" },
  { match: "timeline-clip", reason: "badge over arbitrary clip artwork" },
  { match: "nle-track", reason: "badge over arbitrary clip artwork" },

  { match: "diagnostics-list", reason: "severity colours: error is red in every theme" },
  { match: "camera-raw-status", reason: "severity colour" },
  { match: "workspace-error", reason: "severity colour" },
  { match: "context-menu button.danger", reason: "severity colour" },
  { match: "shortcut-conflict", reason: "severity colour" },
  { match: "layer-actions", reason: "armed-to-delete warning colour" },

  { match: "media-editor", reason: "media surround stays dark like a player, independent of chrome" },
  { match: "media-workspace", reason: "media surround stays dark like a player" },
  { match: "camera-raw-preview", reason: "image surround stays dark so the photo is judged fairly" },
  { match: "camera-raw-filter-preview", reason: "image surround stays dark" },
  { match: "filter-preview", reason: "image surround stays dark" },
  { match: "liquify-canvas-wrap", reason: "image surround stays dark" },
  { match: "navigator-frame", reason: "viewport frame over the thumbnail" },
  { match: "canvas", reason: "canvas surround" },
  { match: "performance-overlay", reason: "a fixed dark HUD, deliberately not themed" },
];

/** Colours in these properties are what the rule is about. */
const PAINT_PROPERTY = /(?:^|;)\s*(?:background|background-color|color|border|border-[a-z]+|outline|box-shadow|fill|stroke|text-shadow)\s*:[^;]*/g;
const LITERAL_COLOUR = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/;
/** Black at low alpha is a shadow in every theme; it is not a palette choice. */
const SHADOW_BLACK = /^#0{3,6}[0-9a-f]{0,2}$|^rgba?\(\s*0[\s,]+0[\s,]+0/i;

interface Rule { readonly selector: string; readonly body: string }

function rulesOf(css: string): Rule[] {
  const out: Rule[] = [];
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    out.push({ selector: (match[1] ?? "").split(/\s+/).join(" ").trim(), body: match[2] ?? "" });
  }
  return out;
}

describe("theme tokens", () => {
  const rules = rulesOf(styles);

  it("found the stylesheet it is supposed to be checking", () => {
    expect(typeof styles).toBe("string");
    expect(rules.length).toBeGreaterThan(300);
  });

  it("defines every token that a rule reads", () => {
    const defined = new Set<string>();
    for (const match of styles.matchAll(/(--[a-z0-9-]+)\s*:/gi)) defined.add(match[1]!);
    // Per-element values React sets as an inline style — a mask URL, a
    // swatch colour, a row's indent depth, a clip's width. These are not
    // palette entries and have no business being declared in a theme; each
    // one below was checked to have a writer in a .tsx file.
    for (const runtime of ["--tool-mask", "--panel-mask", "--icon-mask", "--accent", "--swatch", "--layer-depth", "--clip-width"]) defined.add(runtime);

    const missing = new Set<string>();
    for (const match of styles.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) {
      if (!defined.has(match[1]!)) missing.add(match[1]!);
    }

    // A token nothing defines silently falls back, or renders as nothing at
    // all — the kind of failure that looks like a styling mistake rather
    // than a missing declaration.
    expect([...missing]).toEqual([]);
  });

  it("gives every theme the same tokens to work with", () => {
    const themeBlock = (name: string) => rules.find((rule) => rule.selector.includes(`[data-theme="${name}"]`))?.body ?? "";
    const base = rules.find((rule) => rule.selector === ".app")?.body ?? "";
    const namesIn = (body: string) => new Set([...body.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((match) => match[1]!));

    const baseNames = namesIn(base);
    expect(baseNames.size).toBeGreaterThan(10);
    for (const theme of ["light", "contrast"]) {
      // A theme may override a subset — what it must not do is introduce a
      // token the base has never heard of, which would exist in that theme
      // alone and be undefined everywhere else.
      const extra = [...namesIn(themeBlock(theme))].filter((name) => !baseNames.has(name));
      expect(extra, `theme "${theme}" defines tokens the base does not`).toEqual([]);
    }
  });

  it("keeps interface chrome on tokens, with every exception justified", () => {
    const offenders: string[] = [];
    for (const rule of rules) {
      if (rule.selector.startsWith(".app")) continue;
      if (ALLOWED.some((entry) => rule.selector.includes(entry.match))) continue;
      for (const declaration of rule.body.match(PAINT_PROPERTY) ?? []) {
        for (const colour of declaration.match(new RegExp(LITERAL_COLOUR, "g")) ?? []) {
          if (SHADOW_BLACK.test(colour)) continue;
          offenders.push(`${rule.selector} → ${colour}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
