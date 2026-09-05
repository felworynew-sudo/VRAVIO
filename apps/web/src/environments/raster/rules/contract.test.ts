import { describe, expect, it } from "vitest";
import { appendLayer, createRasterDocument, createRasterLayer, type PixelSelection, type RasterDocumentState, type RasterLayer } from "@vravio/env-raster";
import { applyRules, type Rule } from "../../../rules/engine";
import { applyRasterRules, rasterRules } from "./registry";
import type { PixelEdit } from "./types";

/**
 * Stage 6 of docs/migration-plan.md. Two separate things are checked here:
 * that the engine sequences rules the way it promises, and that the rules
 * moved into it still say what they said while they were scattered through
 * the workspace.
 */

const W = 8, H = 8;

/** A canvas-sized buffer, every pixel the same colour. */
const filled = (r: number, g: number, b: number, a: number) => {
  const pixels = new Uint8ClampedArray(W * H * 4);
  for (let index = 0; index < pixels.length; index += 4) {
    pixels[index] = r; pixels[index + 1] = g; pixels[index + 2] = b; pixels[index + 3] = a;
  }
  return pixels;
};

const scene = (patch: Partial<RasterLayer> = {}) => {
  const state = createRasterDocument(W, H);
  state.layers = [];
  const layer = createRasterLayer(W, H, "Layer");
  Object.assign(layer, patch);
  appendLayer(state, layer);
  return { state, layer };
};

/** A hard-edged selection covering the left half of the canvas. */
const leftHalf = (): PixelSelection => {
  const mask = new Uint8ClampedArray(W * H);
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W / 2; x += 1) mask[y * W + x] = 255;
  return { mask, bounds: { x: 0, y: 0, width: W / 2, height: H } };
};

const editOf = (before: Uint8ClampedArray, after: Uint8ClampedArray, layerId: string): PixelEdit =>
  ({ before, after, label: "Test edit", target: "pixels", layerId, bounds: null });

const alphaAt = (pixels: Uint8ClampedArray, x: number, y: number) => pixels[(y * W + x) * 4 + 3]!;
const redAt = (pixels: Uint8ClampedArray, x: number, y: number) => pixels[(y * W + x) * 4]!;

describe("the engine sequences rules the way it promises", () => {
  const note = (id: string, order: number, log: string[]): Rule<string[], null> => ({
    id, order,
    applies: () => true,
    transform: (edit) => { log.push(id); return [...edit, id]; },
  });

  it("applies rules in order, not in the order they were registered", () => {
    const log: string[] = [];
    const outcome = applyRules([note("third", 30, log), note("first", 10, log), note("second", 20, log)], [], null);

    expect(log).toEqual(["first", "second", "third"]);
    expect(outcome.edit).toEqual(["first", "second", "third"]);
  });

  it("hands each rule what the previous one produced, not the original", () => {
    const log: string[] = [];
    const outcome = applyRules([note("a", 1, log), note("b", 2, log)], ["start"], null);

    // Rules compose, rather than the last one winning.
    expect(outcome.edit).toEqual(["start", "a", "b"]);
  });

  it("stops at the first veto and names the rule that refused", () => {
    const log: string[] = [];
    const refuse: Rule<string[], null> = { id: "refuse", order: 20, applies: () => true, transform: () => null };
    const outcome = applyRules([note("before", 10, log), refuse, note("after", 30, log)], [], null);

    expect(outcome.edit).toBeNull();
    expect(outcome.vetoedBy).toBe("refuse");
    // Nothing after the veto ran: a refused edit is not worth transforming.
    expect(log).toEqual(["before"]);
  });

  it("skips a rule that does not apply", () => {
    const log: string[] = [];
    const inert: Rule<string[], null> = {
      id: "inert", order: 5,
      applies: () => false,
      transform: () => { throw new Error("must not run"); },
    };

    expect(applyRules([inert, note("only", 10, log)], [], null).edit).toEqual(["only"]);
  });
});

describe("the rule catalogue", () => {
  it("has rules to check", () => {
    // Guards against the whole file passing because the glob matched nothing.
    expect(rasterRules.length).toBeGreaterThan(0);
  });

  it("gives every rule its own id and its own place in the order", () => {
    expect(new Set(rasterRules.map((rule) => rule.id)).size).toBe(rasterRules.length);
    // Two rules sharing an order sort against each other arbitrarily, which is
    // the non-determinism `order` exists to remove.
    expect(new Set(rasterRules.map((rule) => rule.order)).size).toBe(rasterRules.length);
  });

  it("has no rule that writes into the edit it was handed", () => {
    const { state, layer } = scene({ lockTransparent: true });
    state.selection = leftHalf();
    const before = filled(10, 20, 30, 0), after = filled(200, 0, 0, 255);
    const beforeCopy = before.slice(), afterCopy = after.slice();

    for (const rule of rasterRules) {
      const edit = editOf(before, after, layer.id);
      if (rule.applies(edit, { document: state, layer })) rule.transform(edit, { document: state, layer });
      // A rule returns a new edit; it does not reach into the one it was given.
      // Both of those buffers are shared with the document and with history.
      expect([...before], rule.id + " wrote into the edit's before").toEqual([...beforeCopy]);
      expect([...after], rule.id + " wrote into the edit's after").toEqual([...afterCopy]);
    }
  });
});

describe("a tool that does not know the rules still obeys them", () => {
  /** What a tool that honours no mask at all hands in: the whole canvas, painted. */
  const oblivious = (state: RasterDocumentState, layer: RasterLayer) =>
    applyRasterRules(editOf(filled(0, 0, 0, 255), filled(255, 0, 0, 255), layer.id), { document: state, layer });

  it("obeys a selection it never read", () => {
    const { state, layer } = scene();
    state.selection = leftHalf();

    const outcome = oblivious(state, layer);

    expect(outcome.edit).not.toBeNull();
    // Inside the selection the paint landed; outside it the layer is as it was.
    expect(redAt(outcome.edit!.after, 1, 1)).toBe(255);
    expect(redAt(outcome.edit!.after, 6, 1)).toBe(0);
  });

  it("is refused by a locked layer it never asked about", () => {
    const { state, layer } = scene({ lockPixels: true });

    const outcome = oblivious(state, layer);

    expect(outcome.edit).toBeNull();
    expect(outcome.vetoedBy).toBe("lock-pixels");
  });

  it("is refused when the layer is not made of pixels", () => {
    const { state, layer } = scene({ kind: "text" });

    const outcome = oblivious(state, layer);

    expect(outcome.edit).toBeNull();
    expect(outcome.vetoedBy).toBe("layer-kind-guard");
  });

  it("cannot put colour where a lock-transparency layer had none", () => {
    const { state, layer } = scene({ lockTransparent: true });
    const before = filled(0, 0, 0, 0);
    // One opaque pixel, so there is somewhere the paint may legitimately land.
    before[(2 * W + 2) * 4 + 3] = 255;

    const outcome = applyRasterRules(editOf(before, filled(255, 0, 0, 255), layer.id), { document: state, layer });

    expect(outcome.edit).not.toBeNull();
    expect(alphaAt(outcome.edit!.after, 5, 5)).toBe(0);
    expect(redAt(outcome.edit!.after, 2, 2)).toBe(255);
  });

  it("leaves a mask edit alone, whatever the layer's own kind and locks say", () => {
    // Painting a mask is how a selection becomes one, and a mask is pixels
    // whatever the layer is made of — the exemption the pointer handler's
    // maskTarget already made.
    const { state, layer } = scene({ kind: "text", lockPixels: true });
    state.selection = leftHalf();
    const after = filled(255, 255, 255, 255);

    const outcome = applyRasterRules({ ...editOf(filled(0, 0, 0, 255), after, layer.id), target: "mask" }, { document: state, layer });

    expect(outcome.edit?.after).toBe(after);
  });
});

describe("lock transparency does not charge an honest tool twice", () => {
  it("leaves a stroke the tool already faded through paintMask exactly as it is", () => {
    // The soft edge is what would break if this rule re-applied the coverage the
    // tool had already honoured: half strength applied twice is a quarter, and
    // every feathered edge would visibly thin. The rule is a floor at alpha zero
    // for that reason, and this is the pixel that proves it.
    const { state, layer } = scene({ lockTransparent: true });
    const before = filled(0, 0, 0, 128);
    const after = before.slice();
    const at = (3 * W + 3) * 4;
    after[at] = 128; after[at + 3] = 128; // painted at the coverage paintMask gave

    const outcome = applyRasterRules(editOf(before, after, layer.id), { document: state, layer });

    expect(outcome.edit!.after[at]).toBe(128);
  });
});
