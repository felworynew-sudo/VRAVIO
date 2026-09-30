import { describe, expect, it } from "vitest";
import { createRasterDocument, layerPixelsView, setLayerLocalPixels, type RasterDocumentState, type RasterRect } from "@vravio/env-raster";
import puppetWarp, { type PuppetWarpState } from "./definitions/puppet-warp";
import type { ToolContext, ToolPointer } from "./types";

/**
 * §65.15 — the Puppet Warp session end to end, without a browser: the mesh comes from the layer's
 * own pixels, a frame only touches the region it changed, and a warp that pushes part of the layer
 * past the canvas keeps that part.
 */
const pointerAt = (x: number, y: number): ToolPointer => ({ point: { x, y }, screenX: x, screenY: y, pointerId: 1, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, button: 0, pressure: 1 });

function drive(options: Record<string, unknown>) {
  const document = createRasterDocument(200, 160);
  const layer = document.layers[0]!;
  const disc = new Uint8ClampedArray(80 * 80 * 4);
  for (let y = 0; y < 80; y += 1) for (let x = 0; x < 80; x += 1) if ((x - 40) ** 2 + (y - 40) ** 2 < 38 ** 2) disc.set([200, 90, 40, 255], (y * 80 + x) * 4);
  setLayerLocalPixels(layer, disc, { x: 60, y: 10, width: 80, height: 80 });
  let state: PuppetWarpState = puppetWarp.createState!() as PuppetWarpState;
  const previews: { dirty: RasterRect | undefined }[] = [];
  const commits: { after: RasterDocumentState }[] = [];
  const context = {
    documentId: "doc", document, options, viewport: { zoom: 1, rotation: 0, panX: 0, panY: 0, mode: "actual" },
    activeLayer: layer,
    get state() { return state; },
    setState: (next: PuppetWarpState) => { state = next; },
    capturePointer: () => {},
    schedulePreview: (_pixels: Uint8ClampedArray, _target: string, _layer: string, dirty?: RasterRect) => { previews.push({ dirty }); },
    commitDocument: async (_before: RasterDocumentState, after: RasterDocumentState) => { commits.push({ after }); },
    previewWithLayerHidden: () => {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as ToolContext<PuppetWarpState>;
  return { context, previews, commits, get state() { return state; } };
}

describe("Puppet Warp session", () => {
  it("lays its mesh on the layer's own outline and keeps what a warp pushes past the canvas", () => {
    const run = drive({ density: "normal", expansion: 2 });
    // Two pins: one near the top of the disc, one near the bottom, then the top one dragged up
    // past the canvas's top edge.
    puppetWarp.onPointerDown!(run.context, pointerAt(100, 16));
    puppetWarp.onGestureEnd!(run.context, pointerAt(100, 16));
    puppetWarp.onPointerDown!(run.context, pointerAt(100, 84));
    puppetWarp.onGestureEnd!(run.context, pointerAt(100, 84));
    const mesh = run.state.session!.mesh;
    // The mesh hugs the disc (radius 38 around 100,50), not an 80×80 square.
    for (const p of mesh.vertices) expect(Math.hypot(p.x - 100, p.y - 50)).toBeLessThan(38 + 2 + 1.5);

    puppetWarp.onPointerDown!(run.context, pointerAt(100, 16));
    puppetWarp.onPointerMove!(run.context, pointerAt(100, -30));
    puppetWarp.onGestureEnd!(run.context, pointerAt(100, -30));
    // A frame repaints only around what it changed, never the whole canvas.
    const last = run.previews.at(-1)!.dirty!;
    expect(last.width * last.height).toBeLessThan(200 * 160);

    puppetWarp.onDeactivate!(run.context);
    expect(run.commits).toHaveLength(1);
    const warped = run.commits[0]!.after.layers[0]!;
    // Content now reaches above the canvas and is stored there, not cut at y = 0.
    expect(warped.bounds.y).toBeLessThan(-20);
    const pixels = layerPixelsView(warped);
    let opaqueAboveCanvas = 0;
    for (let y = 0; y < Math.min(-warped.bounds.y, warped.bounds.height); y += 1) for (let x = 0; x < warped.bounds.width; x += 1) if (pixels[(y * warped.bounds.width + x) * 4 + 3]! > 0) opaqueAboveCanvas += 1;
    expect(opaqueAboveCanvas).toBeGreaterThan(100);
  });

  it("builds a denser mesh for More Points and a wider one for a larger Expansion", () => {
    const vertices = (options: Record<string, unknown>) => {
      const run = drive(options);
      puppetWarp.onPointerDown!(run.context, pointerAt(100, 50));
      return run.state.session!.mesh;
    };
    expect(vertices({ density: "more", expansion: 2 }).vertices.length).toBeGreaterThan(vertices({ density: "fewer", expansion: 2 }).vertices.length);
    expect(vertices({ density: "normal", expansion: 20 }).bounds.width).toBeGreaterThan(vertices({ density: "normal", expansion: 2 }).bounds.width + 20);
  });
});
