import { describe, expect, it } from "vitest";
import { createRasterDocument, setLayerPixels, layerDocumentPixels, type RasterDocumentState } from "@vravio/env-raster";
import puppetWarp, { type PuppetWarpState } from "./definitions/puppet-warp";
import type { ToolContext, ToolPointer } from "./types";

/**
 * master-plan.md §1.2's own "осталось не сделанным": Photoshop's third pin kind.
 *
 * A Position pin and a Fixed pin are the same constraint to the solver — "this point is here"
 * — which says nothing about which way the artwork faces. A Rotation pin adds the angle, and
 * the gesture that sets it is Photoshop's: hold Alt, put the pointer near (not over) a pin, a
 * ring appears, and dragging around it turns the artwork. Alt *over* a pin still deletes,
 * which is the same key doing the same two things it does in Photoshop.
 *
 * Driven through the tool's own handlers rather than the browser: the Browser pane applies
 * modifier keys to a click but not to a drag, so an Alt-drag cannot be produced there at all —
 * an Alt-drag arrives as a plain drag and simply places a pin. (The engine side of rotation is
 * covered separately in `packages/env-raster/src/puppet.test.ts`.)
 */

const WIDTH = 64, HEIGHT = 64;

function document(): RasterDocumentState {
  const state = createRasterDocument(WIDTH, HEIGHT);
  const pixels = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  for (let y = 16; y < 48; y += 1) for (let x = 16; x < 48; x += 1) {
    const index = (y * WIDTH + x) * 4;
    pixels[index] = 200; pixels[index + 1] = 120; pixels[index + 2] = 60; pixels[index + 3] = 255;
  }
  setLayerPixels(state.layers[0]!, pixels, WIDTH, HEIGHT);
  return state;
}

function harness() {
  const state = document();
  const layer = state.layers.find((item) => item.id === state.activeLayerId)!;
  const box: { state: PuppetWarpState } = { state: puppetWarp.createState!() as PuppetWarpState };
  const context = {
    documentId: "doc", document: state,
    viewport: { zoom: 1, rotation: 0, panX: 0, panY: 0, mode: "actual" },
    options: {}, activeLayer: layer, selection: null, selectedLayers: [layer.id],
    paintTarget: { kind: "pixels", layerId: layer.id },
    get state() { return box.state; },
    setState: (next: PuppetWarpState) => { box.state = next; },
    capturePointer: () => {},
    layerPixels: () => layerDocumentPixels(layer, WIDTH, HEIGHT),
    targetPixels: () => layerDocumentPixels(layer, WIDTH, HEIGHT),
    schedulePreview: () => {}, schedulePreviewLayers: () => {}, previewWithLayerHidden: () => {},
    commit: async () => {}, commitSelection: async () => {}, commitDocument: async () => {},
    setActiveLayer: () => {}, setSelectedLayers: () => {}, setForegroundColor: () => {},
    setMaskForegroundWhite: () => {}, resetViewportToFit: () => {}, setLastStrokePoint: () => {},
    setCloneSource: () => {}, setCloneOffset: () => {}, previewSpotHealMask: () => {}, previewSelectionBrushMask: () => {},
    scheduleWork: (fn: () => void) => fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as ToolContext<PuppetWarpState>;
  return { context, box };
}

const at = (x: number, y: number, keys: { altKey?: boolean; shiftKey?: boolean } = {}): ToolPointer => ({
  point: { x, y }, screenX: x, screenY: y, pointerId: 1, pressure: 1, button: 0,
  shiftKey: keys.shiftKey ?? false, altKey: keys.altKey ?? false, ctrlKey: false, metaKey: false,
});

/** Places a pin at a point and returns where it actually landed (the nearest mesh vertex). */
function placePin(context: ToolContext<PuppetWarpState>, box: { state: PuppetWarpState }, x: number, y: number) {
  puppetWarp.onPointerDown!(context, at(x, y));
  puppetWarp.onGestureEnd!(context, at(x, y));
  return box.state.pins[box.state.pins.length - 1]!;
}

describe("the Puppet Warp rotation pin", () => {
  it("turns the pin nearest an Alt-drag instead of placing a new one", () => {
    const { context, box } = harness();
    const pin = placePin(context, box, 32, 32);
    const before = box.state.pins.length;

    // Down beside the pin, not on it, then round: Photoshop's ring.
    puppetWarp.onPointerDown!(context, at(pin.at.x + 20, pin.at.y, { altKey: true }));
    puppetWarp.onPointerMove!(context, at(pin.at.x, pin.at.y + 20, { altKey: true }));
    puppetWarp.onGestureEnd!(context, at(pin.at.x, pin.at.y + 20, { altKey: true }));

    expect(box.state.pins).toHaveLength(before);
    // A quarter turn of the pointer around the pin is a quarter turn of the pin.
    expect(box.state.pins[0]!.rotation).toBeCloseTo(Math.PI / 2, 6);
  });

  it("bends the artwork when it turns, not only the pin", () => {
    // The pin's angle has to reach the mesh, or it is a stored number and nothing more
    // (CLAUDE.md §3). A second pin holds the far side so the twist has to show as a
    // deformation rather than as a rigid turn of everything.
    const { context, box } = harness();
    const turning = placePin(context, box, 24, 24);
    placePin(context, box, 44, 44);
    const flat = box.state.deformed!.map((point) => ({ ...point }));

    puppetWarp.onPointerDown!(context, at(turning.at.x + 15, turning.at.y, { altKey: true }));
    puppetWarp.onPointerMove!(context, at(turning.at.x, turning.at.y + 15, { altKey: true }));
    puppetWarp.onGestureEnd!(context, at(turning.at.x, turning.at.y + 15, { altKey: true }));

    const turned = box.state.deformed!;
    let worst = 0;
    for (let index = 0; index < turned.length; index += 1) {
      worst = Math.max(worst, Math.hypot(turned[index]!.x - flat[index]!.x, turned[index]!.y - flat[index]!.y));
    }
    expect(worst).toBeGreaterThan(1);
  });

  it("still deletes when Alt lands on the pin itself", () => {
    // The two Alt gestures must not have eaten each other.
    const { context, box } = harness();
    const pin = placePin(context, box, 32, 32);
    puppetWarp.onPointerDown!(context, at(pin.at.x, pin.at.y, { altKey: true }));
    puppetWarp.onGestureEnd!(context, at(pin.at.x, pin.at.y, { altKey: true }));
    expect(box.state.pins).toHaveLength(0);
  });

  it("places a pin when Alt is held far from every pin", () => {
    // Outside the ring there is nothing to turn, so Alt means what it meant before.
    const { context, box } = harness();
    placePin(context, box, 20, 20);
    puppetWarp.onPointerDown!(context, at(46, 46, { altKey: true }));
    puppetWarp.onGestureEnd!(context, at(46, 46, { altKey: true }));
    expect(box.state.pins).toHaveLength(2);
  });
});
