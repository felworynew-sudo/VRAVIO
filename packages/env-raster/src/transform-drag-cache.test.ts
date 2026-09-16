import { describe, expect, it } from "vitest";
import { meshLayerPixels, quadLayerPixels, regularMesh, WARP_GRID, type TransformDragCache } from "./index";
import { createRectangleSelection } from "./selection";
import type { Point } from "./types";

/**
 * docs/master-plan.md §37.3 item 5 — `quadLayerPixels`/`meshLayerPixels`'s new `cache` parameter
 * exists purely to avoid a fresh document-sized clone every drag frame; it must never change what
 * gets drawn. Every test here compares a *sequence* of cached calls (mimicking a real drag: one
 * call per pointermove, same `quadOrigin`/`meshOrigin` pixels every time, only the corners/mesh
 * changing) against the same sequence run through the uncached path — not just the final frame,
 * since a bug in the "restore the previous frame's own touched region" step would most likely
 * still get the *last* frame right (nothing left to restore-and-redraw wrong) while corrupting an
 * *intermediate* one a live drag would actually show on screen.
 */

const WIDTH = 80, HEIGHT = 80;
const BOUNDS = { x: 10, y: 10, width: 50, height: 50 };

function checkerboard(): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y += 1) for (let x = 0; x < WIDTH; x += 1) {
    const index = (y * WIDTH + x) * 4, on = (Math.floor(x / 5) + Math.floor(y / 5)) % 2 === 0;
    pixels[index] = on ? 210 : 40; pixels[index + 1] = on ? 30 : 180; pixels[index + 2] = (x * 3 + y * 7) % 200;
    pixels[index + 3] = 255;
  }
  return pixels;
}

function quadCornersSequence(): readonly [Point, Point, Point, Point][] {
  const base = BOUNDS;
  const shifts = [0, 4, -3, 9, -6, 12];
  return shifts.map((shift) => [
    { x: base.x + shift, y: base.y },
    { x: base.x + base.width, y: base.y + shift * 0.5 },
    { x: base.x + base.width - shift, y: base.y + base.height },
    { x: base.x, y: base.y + base.height - shift * 0.5 },
  ] as [Point, Point, Point, Point]);
}

function meshSequence(): readonly (readonly Point[])[] {
  const base = regularMesh(BOUNDS, WARP_GRID);
  const shifts = [0, 3, -5, 8, -2, 6];
  return shifts.map((shift) => base.map((point, index) => index === 5 ? { x: point.x + shift, y: point.y - shift } : point));
}

describe("quadLayerPixels's drag cache matches the uncached path frame by frame", () => {
  it("across a sequence of corner moves, with no selection", () => {
    const origin = checkerboard();
    const cache: TransformDragCache = { working: origin.slice(), dirtyRect: null };
    for (const corners of quadCornersSequence()) {
      const cached = quadLayerPixels(origin, WIDTH, HEIGHT, BOUNDS, corners, null, cache);
      const fresh = quadLayerPixels(origin, WIDTH, HEIGHT, BOUNDS, corners, null);
      expect([...cached]).toEqual([...fresh]);
    }
  });

  it("across a sequence of corner moves, with an active selection", () => {
    const origin = checkerboard();
    const selection = createRectangleSelection(WIDTH, HEIGHT, 15, 15, 55, 55);
    const cache: TransformDragCache = { working: origin.slice(), dirtyRect: null };
    for (const corners of quadCornersSequence()) {
      const cached = quadLayerPixels(origin, WIDTH, HEIGHT, BOUNDS, corners, selection, cache);
      const fresh = quadLayerPixels(origin, WIDTH, HEIGHT, BOUNDS, corners, selection);
      expect([...cached]).toEqual([...fresh]);
    }
  });

  it("never grows the dirty rect to the whole document across a realistic drag", () => {
    const origin = checkerboard();
    const cache: TransformDragCache = { working: origin.slice(), dirtyRect: null };
    for (const corners of quadCornersSequence()) quadLayerPixels(origin, WIDTH, HEIGHT, BOUNDS, corners, null, cache);
    expect(cache.dirtyRect).not.toBeNull();
    expect(cache.dirtyRect!.width).toBeLessThan(WIDTH);
    expect(cache.dirtyRect!.height).toBeLessThan(HEIGHT);
  });
});

describe("meshLayerPixels's drag cache matches the uncached path frame by frame", () => {
  it("across a sequence of anchor moves, with no selection", () => {
    const origin = checkerboard();
    const cache: TransformDragCache = { working: origin.slice(), dirtyRect: null };
    for (const mesh of meshSequence()) {
      const cached = meshLayerPixels(origin, WIDTH, HEIGHT, BOUNDS, mesh, null, cache);
      const fresh = meshLayerPixels(origin, WIDTH, HEIGHT, BOUNDS, mesh, null);
      expect([...cached]).toEqual([...fresh]);
    }
  });

  it("across a sequence of anchor moves, with an active selection", () => {
    const origin = checkerboard();
    const selection = createRectangleSelection(WIDTH, HEIGHT, 15, 15, 55, 55);
    const cache: TransformDragCache = { working: origin.slice(), dirtyRect: null };
    for (const mesh of meshSequence()) {
      const cached = meshLayerPixels(origin, WIDTH, HEIGHT, BOUNDS, mesh, selection, cache);
      const fresh = meshLayerPixels(origin, WIDTH, HEIGHT, BOUNDS, mesh, selection);
      expect([...cached]).toEqual([...fresh]);
    }
  });

  it("the very first cached frame (no previous dirty rect yet) matches the uncached path", () => {
    // The one-call, no-history case — `cache.dirtyRect` starts `null`, so the "restore the
    // previous frame" step must be skipped, not attempt to restore a non-existent rect.
    const origin = checkerboard();
    const cache: TransformDragCache = { working: origin.slice(), dirtyRect: null };
    const [mesh] = meshSequence();
    const cached = meshLayerPixels(origin, WIDTH, HEIGHT, BOUNDS, mesh!, null, cache);
    const fresh = meshLayerPixels(origin, WIDTH, HEIGHT, BOUNDS, mesh!, null);
    expect([...cached]).toEqual([...fresh]);
  });
});
