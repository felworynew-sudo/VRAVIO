import { describe, expect, it } from "vitest";
import { appendLayer, createRasterDocument, createRasterLayer, setLayerPixels, type RasterDocumentState } from "@vravio/env-raster";
import { rasterTools } from "./registry";
import { toolById } from "../../../tools";
import type { RasterToolDefinition, ToolContext, ToolPointer } from "./types";

/**
 * Stage 4 of docs/migration-plan.md: one test every tool in the catalogue has
 * to pass, written before the other twenty-nine move over so that it is the
 * thing catching their mistakes rather than a formality added afterwards.
 *
 * The point is that a tool cannot quietly escape the rules the editor is
 * built on. It gets its document through a context and puts pixels back
 * through `commit`; anything else — reaching into the state object it was
 * handed, holding on to a buffer and writing through it later — is what these
 * checks are looking for.
 *
 * A caveat stated plainly, because a test that passes for the wrong reason is
 * worse than no test: the catalogue currently holds one tool, and it reads
 * rather than writes. So the checks about *what* a tool commits have nothing
 * to bite on yet. They are written to fail loudly the moment a writing tool
 * arrives and gets it wrong, and the checks that do have something to bite on
 * today — no direct mutation, state reset on deactivate, every option
 * changing the outcome — were each confirmed to fail when deliberately broken
 * (see "the checks themselves" at the bottom).
 */

/** Everything a tool did during a driven gesture. */
interface Effects {
  readonly commits: { before: Uint8ClampedArray; after: Uint8ClampedArray; label: string }[];
  readonly foreground: string[];
  readonly captured: number[];
  /** Every state the tool passed through, not only the one it ended on. */
  readonly stateHistory: unknown[];
  state: unknown;
}

/**
 * A value that can be compared and printed, with pixel buffers reduced to a
 * length and a checksum.
 *
 * Serialising a tool's state directly would mean serialising the megabyte of
 * image it is holding, which is both unreadable in a failure message and slow
 * enough to matter across every tool times every option.
 */
function summarise(value: unknown): unknown {
  if (ArrayBuffer.isView(value)) {
    const view = value as unknown as { length: number; [index: number]: number };
    let checksum = 0;
    for (let index = 0; index < view.length; index += 997) checksum = (checksum + view[index]!) % 1_000_003;
    return `buffer(${view.length},${checksum})`;
  }
  if (Array.isArray(value)) return value.map(summarise);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, summarise(inner)]));
  }
  return value;
}

function documentFixture(): RasterDocumentState {
  const state = createRasterDocument(64, 48);
  const base = state.layers[0]!;
  const pixels = new Uint8ClampedArray(64 * 48 * 4);
  // Two halves, so a tool whose behaviour depends on where it reads shows it.
  for (let y = 0; y < 48; y += 1) for (let x = 0; x < 64; x += 1) {
    const index = (y * 64 + x) * 4;
    const left = x < 32;
    pixels[index] = left ? 210 : 20; pixels[index + 1] = left ? 40 : 190;
    pixels[index + 2] = left ? 50 : 70; pixels[index + 3] = 255;
  }
  setLayerPixels(base, pixels, 64, 48);

  // A second layer, so "sample all layers" and "sample this layer" differ —
  // also two-toned across the same seam, because a fixture with no edge in it
  // cannot show whether a tool that averages a neighbourhood is averaging
  // anything. A uniform fixture is the degenerate case, not the neutral one.
  const top = createRasterLayer(64, 48, "Top");
  const topPixels = new Uint8ClampedArray(64 * 48 * 4);
  for (let y = 0; y < 48; y += 1) for (let x = 0; x < 64; x += 1) {
    const index = (y * 64 + x) * 4;
    const left = x < 32;
    topPixels[index] = left ? 250 : 15; topPixels[index + 1] = left ? 205 : 60;
    topPixels[index + 2] = left ? 15 : 240; topPixels[index + 3] = 255;
  }
  setLayerPixels(top, topPixels, 64, 48);
  appendLayer(state, top);
  state.activeLayerId = base.id;
  return state;
}

function pointerAt(x: number, y: number, pointerId = 1): ToolPointer {
  return {
    point: { x, y }, screenX: x, screenY: y, pointerId,
    shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, button: 0, pressure: 0.5,
  };
}

/**
 * Runs a tool against a real document and records what it reached for.
 *
 * The document handed over is a deep copy, and it is compared against an
 * untouched original afterwards: that is how "did this tool write pixels
 * without going through commit" is detected, rather than by trusting the tool
 * to say so.
 */
function drive(
  tool: RasterToolDefinition<unknown>,
  options: Record<string, string | number | boolean>,
  gesture: (context: ToolContext<unknown>, effects: Effects) => void,
): { effects: Effects; document: RasterDocumentState; untouched: RasterDocumentState } {
  const document = documentFixture();
  const untouched = documentFixture();
  const effects: Effects = { commits: [], foreground: [], captured: [], stateHistory: [], state: tool.createState() };

  const context: ToolContext<unknown> = {
    documentId: "test-document",
    document,
    viewport: { zoom: 1, rotation: 0, panX: 0, panY: 0, mode: "actual" },
    options,
    activeLayer: document.layers.find((layer) => layer.id === document.activeLayerId) ?? null,
    selection: document.selection,
    get state() { return effects.state; },
    setState: (next) => { effects.state = next; effects.stateHistory.push(next); },
    capturePointer: (pointerId) => { effects.captured.push(pointerId); },
    layerPixels: () => {
      const layer = document.layers.find((item) => item.id === document.activeLayerId)!;
      const out = new Uint8ClampedArray(document.width * document.height * 4);
      for (let y = 0; y < layer.bounds.height; y += 1) {
        const from = y * layer.bounds.width * 4;
        out.set(layer.pixels.subarray(from, from + layer.bounds.width * 4), ((layer.bounds.y + y) * document.width + layer.bounds.x) * 4);
      }
      return out;
    },
    compositePixels: () => {
      // Top layer is opaque, so the composite is simply the top layer.
      const top = document.layers[document.layers.length - 1]!;
      const out = new Uint8ClampedArray(document.width * document.height * 4);
      for (let y = 0; y < top.bounds.height; y += 1) {
        const from = y * top.bounds.width * 4;
        out.set(top.pixels.subarray(from, from + top.bounds.width * 4), ((top.bounds.y + y) * document.width + top.bounds.x) * 4);
      }
      return out;
    },
    commit: async (before, after, label) => { effects.commits.push({ before, after, label }); },
    setForegroundColor: (color) => { effects.foreground.push(color); },
  };

  gesture(context, effects);
  return { effects, document, untouched };
}

/**
 * A press, a drag and a release — the shape of every gesture a tool sees.
 *
 * The drag ends on the seam at x=32 rather than in the middle of a flat
 * region: a tool whose options change how wide a neighbourhood it reads can
 * only demonstrate that where there is something to read across.
 */
const fullGesture = (context: ToolContext<unknown>, tool: RasterToolDefinition<unknown>) => {
  tool.onPointerDown?.(context, pointerAt(10, 10));
  tool.onPointerMove?.(context, pointerAt(32, 24));
  tool.onGestureEnd?.(context, pointerAt(32, 24));
};

/** Compares two documents by the only thing a tool could have changed. */
function pixelsOf(state: RasterDocumentState): string {
  return state.layers.map((layer) => `${layer.id.length}:${layer.bounds.x},${layer.bounds.y},${layer.bounds.width},${layer.bounds.height}:${layer.pixels.join(",")}`).join("|");
}

describe("every tool in the catalogue keeps the contract", () => {
  it("has tools to check", () => {
    // Guards against the whole suite passing because the registry glob
    // silently matched nothing.
    expect(rasterTools.length).toBeGreaterThan(0);
  });

  for (const tool of rasterTools) {
    const descriptor = toolById(tool.id);
    const options = Object.fromEntries((descriptor?.options ?? []).map((option) => [option.id, option.defaultValue]));

    describe(tool.id, () => {
      it("is described in tools.ts, so the toolbar can show it", () => {
        // A catalogue entry with no descriptor is a tool nobody can select.
        expect(descriptor, `${tool.id} has no entry in tools.ts`).toBeDefined();
      });

      it("writes no pixels except through commit", () => {
        const { document, untouched } = drive(tool, options, (context) => fullGesture(context, tool));

        // The document it was handed is compared with one it never saw. A
        // tool that reached into `context.document` and wrote through it —
        // or that held a buffer from `layerPixels()` and mutated it — shows
        // up here and nowhere else.
        expect(pixelsOf(document)).toBe(pixelsOf(untouched));
      });

      it("commits something history can undo", () => {
        const { effects, untouched } = drive(tool, options, (context) => fullGesture(context, tool));
        const layer = untouched.layers.find((item) => item.id === untouched.activeLayerId)!;
        const documentSized = untouched.width * untouched.height * 4;

        for (const commit of effects.commits) {
          expect(commit.label.trim().length, `${tool.id} committed with an empty label`).toBeGreaterThan(0);
          // Two sides that are the same object cannot be undone: history
          // would restore exactly the state it is trying to undo.
          expect(commit.before, `${tool.id} committed the same buffer as before and after`).not.toBe(commit.after);
          expect(commit.after.length).toBe(commit.before.length);
          expect(commit.before.length, `${tool.id} committed a buffer that is neither document- nor layer-sized`)
            .toBeOneOf([documentSized, layer.pixels.length]);
        }
      });

      it("cannot reach past commit to escape the selection", () => {
        // Not a check on the tool so much as a statement of where the rule
        // lives: `commit` routes to the workspace's commitPixels, which is
        // what applies confineToSelection. The only way around it is writing
        // to the document directly, and that is what the check above catches.
        // Stated here so the guarantee is visible where tools are reviewed.
        const { document, untouched } = drive(tool, options, (context) => fullGesture(context, tool));
        expect(pixelsOf(document)).toBe(pixelsOf(untouched));
      });

      it("returns to its initial state when it stops being the active tool", () => {
        const { effects } = drive(tool, options, (context) => {
          tool.onPointerDown?.(context, pointerAt(10, 10));
          tool.onPointerMove?.(context, pointerAt(20, 20));
          // No gesture end: this is the switch-tools-mid-press case, which is
          // exactly when stranded state gets drawn again later.
          tool.onDeactivate?.(context);
        });

        expect(effects.state, `${tool.id} kept state after deactivating`).toEqual(tool.createState());
      });

      it("has no option that leaves the result unchanged", () => {
        const descriptorOptions = descriptor?.options ?? [];
        const baseline = drive(tool, options, (context) => fullGesture(context, tool));
        // Every state the tool passed through, not just the one it ended on:
        // a tool that clears its state when the gesture finishes — as the
        // eyedropper does, so the loupe does not outlive the press — would
        // otherwise look identical whatever its options said.
        const signature = (result: ReturnType<typeof drive>) =>
          JSON.stringify(summarise({
            foreground: result.effects.foreground,
            states: result.effects.stateHistory,
            commits: result.effects.commits.map((commit) => commit.label),
          }));

        for (const option of descriptorOptions) {
          // A value that is not the default, chosen by the option's own type.
          const changed = option.type === "boolean" ? !option.defaultValue
            : option.type === "select" ? option.values.find((value) => value.value !== option.defaultValue)?.value
            : option.type === "number" ? (option.defaultValue === option.max ? option.min : option.max)
            : "#123456";
          if (changed === undefined) continue;

          const variant = drive(tool, { ...options, [option.id]: changed }, (context) => fullGesture(context, tool));

          // The rule the project already committed to: if a tool has a
          // setting, the setting affects the tool. A checkbox that changes
          // nothing is worse than an absent one.
          expect(signature(variant), `${tool.id}: option "${option.id}" changed nothing`).not.toBe(signature(baseline));
        }
      });
    });
  }
});

/**
 * The checks themselves, driven against deliberately broken tools.
 *
 * Without these, a mistake in the harness — a comparison that always passes,
 * a gesture that never runs — would make the whole suite above green and
 * meaningless. Each one here breaks a rule on purpose and asserts the
 * corresponding check notices.
 */
describe("the checks themselves catch what they are for", () => {
  it("notices a tool that writes pixels behind commit's back", () => {
    const sneaky: RasterToolDefinition<unknown> = {
      id: "test.sneaky",
      createState: () => null,
      onPointerDown(context) {
        const layer = context.document.layers[0]!;
        layer.pixels[0] = 1; layer.pixels[1] = 2; layer.pixels[2] = 3;
      },
    };
    const { document, untouched } = drive(sneaky, {}, (context) => fullGesture(context, sneaky));
    expect(pixelsOf(document)).not.toBe(pixelsOf(untouched));
  });

  it("notices a tool that keeps state after deactivating", () => {
    const forgetful: RasterToolDefinition<{ held: boolean }> = {
      id: "test.forgetful",
      createState: () => ({ held: false }),
      onPointerDown(context) { context.setState({ held: true }); },
      // No onDeactivate at all — the case the check exists for.
    };
    const { effects } = drive(forgetful as RasterToolDefinition<unknown>, {}, (context) => {
      forgetful.onPointerDown?.(context as ToolContext<{ held: boolean }>, pointerAt(10, 10));
      forgetful.onDeactivate?.(context as ToolContext<{ held: boolean }>);
    });
    expect(effects.state).not.toEqual(forgetful.createState());
  });

  it("notices an option that changes nothing", () => {
    const deaf: RasterToolDefinition<unknown> = {
      id: "test.deaf",
      createState: () => null,
      // Ignores its options entirely.
      onPointerDown(context) { context.setForegroundColor("#ffffff"); },
    };
    const run = (options: Record<string, string | number | boolean>) =>
      JSON.stringify(drive(deaf, options, (context) => fullGesture(context, deaf)).effects.foreground);

    expect(run({ anything: true })).toBe(run({ anything: false }));
  });
});
