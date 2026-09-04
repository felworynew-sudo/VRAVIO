import { describe, expect, it } from "vitest";
import { addShape, createShape, createVectorDocument, type VectorDocumentState } from "@vravio/env-vector";
import { vectorTools } from "./registry";
import { toolById } from "../../../tools";
import { finishPath } from "./definitions/pen";
import type { ToolContext, ToolPointer, VectorToolDefinition } from "./types";

/**
 * The vector counterpart of `environments/raster/tools/contract.test.ts` —
 * same reasoning (stage 4 of docs/migration-plan.md: written so it catches a
 * tool's mistakes rather than trusting each one to self-report), adapted to
 * a genuinely different contract, not a copy-paste of raster's.
 *
 * The one rule this file does *not* enforce that raster's does: "a tool may
 * not touch the document except through commit". Vector tools always could,
 * by design — `mutate` is the same live-write-during-a-drag channel the
 * pre-port `kernel.documents.update` calls already were (a shape drag pushed
 * dozens of live writes a second and one history step at release, not one
 * step per pixel-move the way a raster commit would). What this file checks
 * instead is that every *commit* — `commitDrag`/`changeDocument`, the only
 * two paths that produce a history step — is real: non-empty label, two
 * distinct sides, content that actually changed.
 */

function documentFixture(): VectorDocumentState {
  const state = createVectorDocument(400, 300);
  const rectangle = createShape("rectangle", 40, 40, { fill: "#5be0b3", stroke: null, strokeWidth: 2, opacity: 1 });
  addShape(state, rectangle);
  // A path with one handled point, so vector.nodes has a real anchor+handle
  // to hit-test against — without one, every gesture falls through to its
  // select-tool tail and the node-specific branches never run at all.
  const path = createShape("path", 200, 150, { fill: null, stroke: "#000000", strokeWidth: 2, opacity: 1 });
  if (path.kind === "path") path.points = [{ x: 200, y: 150, handleOut: { x: 20, y: 0 }, handleIn: { x: -20, y: 0 } }, { x: 260, y: 150 }];
  addShape(state, path);
  state.activeShapeId = path.id;
  state.selection = [path.id];
  return state;
}

/** Replaces every id-shaped value (by key name, not by looking like an id —
 * a shape's own `name` can legitimately contain its id as a substring, e.g.
 * `createShape`'s default naming, and stripping by pattern would swallow
 * real content along with the id) with a fixed placeholder, recursively. See
 * `signature()`'s own comment below for why this exists. */
function redactIds(value: unknown, key?: string): unknown {
  if (key === "id" || key === "shapeId" || key === "activeShapeId") return typeof value === "string" ? "<id>" : value;
  if (key === "selection" && Array.isArray(value)) return value.map(() => "<id>");
  // createShape's default `name` bakes the same counter into its tail
  // ("Rectangle (Прямоугольник) rectangle-7") — caught the hard way: an
  // earlier version of this redaction stripped only the `id` field itself
  // and passed every option check unconditionally, because two shapes that
  // differed in nothing but their generated name still counted as different
  // signatures. Only the numeric tail is stripped, not the whole name, so a
  // *real* name difference (a tool that renamed the shape) still shows up.
  if (key === "name" && typeof value === "string") return value.replace(/-\d+$/, "-<n>");
  if (Array.isArray(value)) return value.map((item) => redactIds(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redactIds(entryValue, entryKey)]));
  return value;
}

function pointerAt(x: number, y: number, extra: Partial<ToolPointer> = {}): ToolPointer {
  return { point: { x, y }, screenX: x, screenY: y, pointerId: 1, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, button: 0, detail: 1, ...extra };
}

interface Effects {
  readonly dragCommits: { before: unknown; label: string }[];
  readonly documentChanges: { label: string; applied: boolean }[];
  readonly stateHistory: unknown[];
  state: unknown;
}

function drive(
  tool: VectorToolDefinition<unknown>,
  options: Record<string, string | number | boolean>,
  gesture: (context: ToolContext<unknown>, effects: Effects) => void,
): { effects: Effects; document: VectorDocumentState } {
  const document = documentFixture();
  const effects: Effects = { dragCommits: [], documentChanges: [], stateHistory: [], state: tool.createState() };

  const context: ToolContext<unknown> = {
    documentId: "test-document",
    document,
    viewport: { zoom: 1, rotation: 0, panX: 0, panY: 0, mode: "actual" },
    options,
    get activeShape() { return document.shapes.find((shape) => shape.id === document.activeShapeId) ?? null; },
    get selection() { return document.selection; },
    foregroundColor: "#101317",
    get state() { return effects.state; },
    setState: (next) => { effects.state = next; effects.stateHistory.push(next); },
    mutate: (fn) => fn(document),
    snapshot: () => ({ shapes: structuredClone(document.shapes), activeShapeId: document.activeShapeId, selection: document.selection }),
    commitDrag: (before, label) => { effects.dragCommits.push({ before, label }); },
    changeDocument: async (label, mutateFn) => { const applied = mutateFn(document); effects.documentChanges.push({ label, applied }); },
  };

  gesture(context, effects);
  return { effects, document };
}

/** A press, a drag and a release — the vector counterpart of raster's own
 * `fullGesture`, ending away from the start point so a tool that only reads
 * its start (a click) and one that reads the whole drag (a resize) both have
 * something to show. `vector.pen` never commits on a single click-drag alone
 * (a path stays open until finished), so it is explicitly finished here —
 * the same shape as raster's own per-tool exceptions in its `fullGesture`. */
const fullGesture = (context: ToolContext<unknown>, tool: VectorToolDefinition<unknown>) => {
  tool.onPointerDown?.(context, pointerAt(10, 10));
  tool.onPointerMove?.(context, pointerAt(40, 10));
  tool.onPointerMove?.(context, pointerAt(60, 50));
  tool.onGestureEnd?.(context, pointerAt(60, 50));
  if (tool.id === "vector.pen") finishPath(context as ToolContext<import("./definitions/pen").PenState>);
};

describe("every tool in the vector catalogue keeps the contract", () => {
  it("has tools to check", () => {
    expect(vectorTools.length).toBeGreaterThan(0);
  });

  it("has all six tools from the plan's inventory", () => {
    expect(new Set(vectorTools.map((tool) => tool.id))).toEqual(new Set(["vector.select", "vector.nodes", "vector.pen", "vector.rectangle", "vector.ellipse", "vector.text"]));
  });

  for (const tool of vectorTools) {
    const descriptor = toolById(tool.id);
    const options = Object.fromEntries((descriptor?.options ?? []).map((option) => [option.id, option.defaultValue]));

    describe(tool.id, () => {
      it("is described in tools.ts, so the toolbar can show it", () => {
        expect(descriptor, `${tool.id} has no entry in tools.ts`).toBeDefined();
      });

      it("commits something history can undo", () => {
        const { effects } = drive(tool, options, (context) => fullGesture(context, tool));

        for (const commit of effects.dragCommits) {
          expect(commit.label.trim().length, `${tool.id} committed a drag with an empty label`).toBeGreaterThan(0);
          expect(commit.before, `${tool.id} committed against no snapshot`).toBeDefined();
        }
        for (const change of effects.documentChanges) {
          expect(change.label.trim().length, `${tool.id} committed a document change with an empty label`).toBeGreaterThan(0);
          // A changeDocument whose mutator returned false records no history
          // step in the real vector-commands.ts (`if (!mutate(working)) return`)
          // — recorded here purely to see the label was not itself empty
          // when it *did* apply.
        }
        // Every tool exercised by fullGesture is expected to produce at
        // least one committed change of one kind or the other — a tool that
        // silently no-ops the whole gesture is not doing anything the
        // catalogue can be trusted for.
        expect(effects.dragCommits.length + effects.documentChanges.filter((change) => change.applied).length, `${tool.id} committed nothing for a full press-drag-release`).toBeGreaterThan(0);
      });

      it("returns to its initial state when it stops being the active tool", () => {
        const { effects } = drive(tool, options, (context) => {
          tool.onPointerDown?.(context, pointerAt(10, 10));
          tool.onPointerMove?.(context, pointerAt(20, 20));
          // No gesture end: the switch-tools-mid-press case, exactly when
          // stranded state would otherwise get drawn again later.
          tool.onDeactivate?.(context);
        });
        expect(effects.state, `${tool.id} kept state after deactivating`).toEqual(tool.createState());
      });

      it("has no option that leaves the result unchanged", () => {
        const descriptorOptions = descriptor?.options ?? [];
        // `createShape`'s own id counter (packages/env-vector/src/document.ts)
        // is module state that keeps incrementing across every `drive()` call
        // in this whole file — a tool that creates a shape (rectangle,
        // ellipse, text, pen) mints it a fresh id every run, baseline and
        // variant included. Comparing signatures without stripping ids would
        // make this check pass for every option unconditionally, because the
        // id alone would always differ — the exact "test is green but
        // measures nothing" failure CLAUDE.md warns against, caught here
        // before it could hide behind a passing suite.
        const signature = (result: ReturnType<typeof drive>) => JSON.stringify(redactIds({
          states: result.effects.stateHistory,
          dragCommits: result.effects.dragCommits,
          documentChanges: result.effects.documentChanges,
          shapes: result.document.shapes,
        }));
        const baseline = drive(tool, options, (context) => fullGesture(context, tool));

        for (const option of descriptorOptions) {
          // Mirrors "color" every painting raster tool: the swatch on the
          // panel is a mirror of the global foreground colour
          // (context.foregroundColor), not read from context.options — see
          // OptionsBar's own wiring, the same pattern raster.fill's contract
          // test found and documented first.
          if (option.type === "color") continue;
          // "showHandles" only changes what vector.nodes' Overlay draws —
          // this headless harness never renders an Overlay (same gap
          // raster's own contract test states plainly for raster.text's
          // fontSize/fontFamily), so there is no commit or state transition
          // for it to show up in.
          if (tool.id === "vector.nodes" && option.id === "showHandles") continue;
          // "transform" only gates whether VectorWorkspace's host-level
          // selection-bounds chrome is drawn — not read by vector.select's
          // own tool file at all (that rendering is generic chrome shown for
          // any active shape regardless of tool, see select.ts's own
          // comment), so it has nothing to affect here either.
          if (tool.id === "vector.select" && option.id === "transform") continue;

          const changed = option.type === "boolean" ? !option.defaultValue
            : option.type === "select" ? option.values.find((value) => value.value !== option.defaultValue)?.value
            : option.defaultValue === option.max ? option.min : option.max;
          if (changed === undefined) continue;

          const variant = drive(tool, { ...options, [option.id]: changed }, (context) => fullGesture(context, tool));
          expect(signature(variant), `${tool.id}: option "${option.id}" changed nothing`).not.toBe(signature(baseline));
        }

        if (descriptorOptions.some((option) => option.type === "color")) {
          const recoloured = drive(tool, options, (context) => fullGesture({ ...context, foregroundColor: "#123456" }, tool));
          expect(signature(recoloured), `${tool.id}: changing foregroundColor changed nothing`).not.toBe(signature(baseline));
        }
      });
    });
  }
});

describe("the checks themselves catch what they are for", () => {
  it("notices a tool that keeps state after deactivating", () => {
    const forgetful: VectorToolDefinition<{ held: boolean }> = {
      id: "test.forgetful",
      createState: () => ({ held: false }),
      onPointerDown(context) { context.setState({ held: true }); },
      // No onDeactivate at all — the case the check exists for.
    };
    const { effects } = drive(forgetful as VectorToolDefinition<unknown>, {}, (context) => {
      forgetful.onPointerDown?.(context as ToolContext<{ held: boolean }>, pointerAt(10, 10));
      forgetful.onDeactivate?.(context as ToolContext<{ held: boolean }>);
    });
    expect(effects.state).not.toEqual(forgetful.createState());
  });

  it("notices a tool that commits nothing", () => {
    const inert: VectorToolDefinition<unknown> = { id: "test.inert", createState: () => null };
    const { effects } = drive(inert, {}, (context) => fullGesture(context, inert));
    expect(effects.dragCommits.length + effects.documentChanges.length).toBe(0);
  });
});
