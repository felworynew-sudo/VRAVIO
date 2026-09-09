import { describe, expect, it } from "vitest";
import { createPuppetSolverCache, nearestVertex, puppetMesh, puppetWarpPixels, solvePuppetMesh } from "./index";

/**
 * master-plan.md §1.2, the Puppet Warp. The method is the donor's — ARAP over a
 * triangulated mesh (Igarashi et al. 2005, which `mikecokina/puppet-warp`
 * implements) — and these check the properties that make it that method rather
 * than any smooth deformation: pins are obeyed, an unmoved mesh stays put, a
 * mesh dragged as a whole translates instead of stretching, and the picture
 * follows the mesh.
 */

const BOUNDS = { x: 20, y: 20, width: 80, height: 80 };
const WIDTH = 128, HEIGHT = 128;

const distance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

describe("puppet mesh", () => {
  it("covers the bounds with triangles", () => {
    const mesh = puppetMesh(BOUNDS, 4);
    expect(mesh.vertices).toHaveLength(25);
    expect(mesh.triangles).toHaveLength(4 * 4 * 2 * 3);
    expect(mesh.vertices[0]).toEqual({ x: 20, y: 20 });
    expect(mesh.vertices[24]).toEqual({ x: 100, y: 100 });
  });

  it("turns a click into the vertex nearest it", () => {
    const mesh = puppetMesh(BOUNDS, 4);
    expect(nearestVertex(mesh, { x: 22, y: 21 })).toBe(0);
    expect(nearestVertex(mesh, { x: 99, y: 98 })).toBe(24);
  });
});

describe("solving the mesh", () => {
  it("leaves the mesh where it is when its pins have not moved", () => {
    const mesh = puppetMesh(BOUNDS, 4);
    const pins = [0, 4, 20, 24].map((vertex) => ({ vertex, at: mesh.vertices[vertex]! }));
    const solved = solvePuppetMesh(mesh, pins);
    for (let index = 0; index < mesh.vertices.length; index += 1) {
      expect(distance(solved[index]!, mesh.vertices[index]!)).toBeLessThan(0.5);
    }
  });

  it("puts a dragged pin where it was dragged", () => {
    const mesh = puppetMesh(BOUNDS, 4);
    const target = { x: mesh.vertices[24]!.x + 25, y: mesh.vertices[24]!.y + 10 };
    const solved = solvePuppetMesh(mesh, [
      { vertex: 0, at: mesh.vertices[0]! },
      { vertex: 4, at: mesh.vertices[4]! },
      { vertex: 20, at: mesh.vertices[20]! },
      { vertex: 24, at: target },
    ]);
    // The pin is a constraint, not a suggestion — it lands on the pointer.
    expect(distance(solved[24]!, target)).toBeLessThan(1.5);
    // And the pins that were not dragged hold their ground.
    expect(distance(solved[0]!, mesh.vertices[0]!)).toBeLessThan(1.5);
  });

  it("carries the mesh along smoothly instead of only moving the pin", () => {
    const mesh = puppetMesh(BOUNDS, 4);
    const solved = solvePuppetMesh(mesh, [
      { vertex: 0, at: mesh.vertices[0]! },
      { vertex: 24, at: { x: mesh.vertices[24]!.x, y: mesh.vertices[24]!.y + 30 } },
    ]);
    // A neighbour of the dragged corner moves with it — a deformation, not a
    // single displaced point.
    expect(distance(solved[23]!, mesh.vertices[23]!)).toBeGreaterThan(3);
    // And the far pinned corner does not.
    expect(distance(solved[0]!, mesh.vertices[0]!)).toBeLessThan(1.5);
  });

  it("translates rather than stretches when every pin moves together", () => {
    // The rigidity half of "as rigid as possible": if the pins describe a pure
    // translation, so must the answer. Step 1 alone would be free to scale here.
    const mesh = puppetMesh(BOUNDS, 4);
    const shift = { x: 17, y: -9 };
    const pins = [0, 4, 20, 24].map((vertex) => ({ vertex, at: { x: mesh.vertices[vertex]!.x + shift.x, y: mesh.vertices[vertex]!.y + shift.y } }));
    const solved = solvePuppetMesh(mesh, pins);
    for (let index = 0; index < mesh.vertices.length; index += 1) {
      expect(distance(solved[index]!, { x: mesh.vertices[index]!.x + shift.x, y: mesh.vertices[index]!.y + shift.y })).toBeLessThan(0.5);
    }
  });

  it("keeps the mesh it had when the pins pin nothing down", () => {
    const mesh = puppetMesh(BOUNDS, 4);
    expect(solvePuppetMesh(mesh, [])).toBe(mesh.vertices);
  });
});

describe("drawing through the mesh", () => {
  /** A filled square inside the mesh bounds. */
  function block(): Uint8ClampedArray {
    const pixels = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
    for (let y = 30; y < 90; y += 1) for (let x = 30; x < 90; x += 1) {
      const index = (y * WIDTH + x) * 4;
      pixels[index] = 200; pixels[index + 1] = 60; pixels[index + 2] = 60; pixels[index + 3] = 255;
    }
    return pixels;
  }

  const alphaAt = (pixels: Uint8ClampedArray, x: number, y: number) => pixels[(y * WIDTH + x) * 4 + 3]!;

  it("reproduces the picture when the mesh has not moved", () => {
    const source = block();
    const mesh = puppetMesh(BOUNDS, 4);
    const output = puppetWarpPixels(source, WIDTH, HEIGHT, mesh, mesh.vertices, null);
    let worst = 0;
    for (let y = 35; y < 85; y += 1) for (let x = 35; x < 85; x += 1) {
      worst = Math.max(worst, Math.abs(alphaAt(output, x, y) - alphaAt(source, x, y)));
    }
    expect(worst).toBeLessThanOrEqual(2);
  });

  it("moves the content when the mesh is translated", () => {
    const source = block();
    const mesh = puppetMesh(BOUNDS, 4);
    const moved = mesh.vertices.map((vertex) => ({ x: vertex.x + 10, y: vertex.y }));
    const output = puppetWarpPixels(source, WIDTH, HEIGHT, mesh, moved, null);
    // Where the block was and is not any more.
    expect(alphaAt(output, 34, 60)).toBe(0);
    // Where it landed.
    expect(alphaAt(output, 50, 60)).toBe(255);
    expect(alphaAt(output, 95, 60)).toBe(255);
  });

  it("leaves no holes inside a deformed mesh", () => {
    const source = block();
    const mesh = puppetMesh(BOUNDS, 4);
    const solved = solvePuppetMesh(mesh, [
      { vertex: 0, at: mesh.vertices[0]! },
      { vertex: 4, at: mesh.vertices[4]! },
      { vertex: 24, at: { x: mesh.vertices[24]!.x + 12, y: mesh.vertices[24]!.y + 12 } },
    ]);
    const output = puppetWarpPixels(source, WIDTH, HEIGHT, mesh, solved, null);
    // The middle of the block stays covered — triangles that dropped their
    // seams would show as a lattice of transparent lines through it.
    let transparent = 0;
    for (let y = 45; y < 75; y += 1) for (let x = 45; x < 75; x += 1) if (alphaAt(output, x, y) === 0) transparent += 1;
    expect(transparent).toBe(0);
  });
});

describe("rotation pins", () => {
  /** The signed angle a vertex has swept around a centre, between two mesh states. */
  const sweep = (centre: { x: number; y: number }, before: { x: number; y: number }, after: { x: number; y: number }) => {
    const a = Math.atan2(before.y - centre.y, before.x - centre.x);
    const b = Math.atan2(after.y - centre.y, after.x - centre.x);
    let delta = b - a;
    while (delta > Math.PI) delta -= 2 * Math.PI;
    while (delta < -Math.PI) delta += 2 * Math.PI;
    return delta;
  };

  it("turns the artwork around a pin that a position pin could only hold still", () => {
    // Photoshop's third pin kind, and the reason it exists: one pin that does not move says
    // nothing about which way the artwork faces, so on its own it cannot twist anything. The
    // same pin with an angle does. Both cases are run here, because the difference between
    // them is the whole feature.
    const mesh = puppetMesh(BOUNDS, 4);
    const centre = Math.floor(mesh.vertices.length / 2);
    const corner = 0;

    const held = solvePuppetMesh(mesh, [{ vertex: centre, at: mesh.vertices[centre]! }]);
    expect(Math.abs(sweep(mesh.vertices[centre]!, mesh.vertices[corner]!, held[corner]!))).toBeLessThan(0.01);

    const quarter = Math.PI / 4;
    const turned = solvePuppetMesh(mesh, [{ vertex: centre, at: mesh.vertices[centre]!, rotation: quarter }]);
    expect(sweep(mesh.vertices[centre]!, mesh.vertices[corner]!, turned[corner]!)).toBeGreaterThan(0.05);
  });

  it("turns the neighbourhood most, and lets a second pin hold the far side back", () => {
    // The property that makes it a *pin* rather than a rotate-the-layer command.
    //
    // It only shows with something else holding the artwork: a single rotation pin and
    // nothing else leaves a rigid turn of the whole mesh free of cost, so everything sweeps
    // by the full angle — which is also what Photoshop does with one pin, and what the first
    // version of this test wrongly called a bug. Add a pin at the far corner and the twist has
    // to relax across the mesh instead.
    const mesh = puppetMesh(BOUNDS, 6);
    const pinVertex = 0;
    const near = 1, far = mesh.vertices.length - 1;
    const turned = solvePuppetMesh(mesh, [
      { vertex: pinVertex, at: mesh.vertices[pinVertex]!, rotation: Math.PI / 6 },
      { vertex: far, at: mesh.vertices[far]! },
    ]);

    const nearSweep = Math.abs(sweep(mesh.vertices[pinVertex]!, mesh.vertices[near]!, turned[near]!));
    const farSweep = Math.abs(sweep(mesh.vertices[pinVertex]!, mesh.vertices[far]!, turned[far]!));
    expect(nearSweep).toBeGreaterThan(farSweep);
    expect(farSweep).toBeLessThan(0.02);
  });
  it("still puts a dragged pin exactly where it was dragged", () => {
    // A rotation must not cost the position constraint: a pin that turns is still a pin.
    const mesh = puppetMesh(BOUNDS, 4);
    const vertex = Math.floor(mesh.vertices.length / 2);
    const target = { x: mesh.vertices[vertex]!.x + 12, y: mesh.vertices[vertex]!.y - 7 };
    const solved = solvePuppetMesh(mesh, [{ vertex, at: target, rotation: Math.PI / 3 }]);
    expect(distance(solved[vertex]!, target)).toBeLessThan(0.5);
  });

  it("leaves a zero rotation exactly as a plain pin", () => {
    // The default has to cost nothing, or every existing pin would quietly acquire a
    // constraint the moment the field appeared.
    const mesh = puppetMesh(BOUNDS, 4);
    const vertex = 10, at = { x: mesh.vertices[vertex]!.x + 9, y: mesh.vertices[vertex]!.y + 4 };
    const plain = solvePuppetMesh(mesh, [{ vertex, at }]);
    const zero = solvePuppetMesh(mesh, [{ vertex, at, rotation: 0 }]);
    for (let index = 0; index < plain.length; index += 1) expect(distance(plain[index]!, zero[index]!)).toBeLessThan(1e-9);
  });
});

describe("the solver cache", () => {
  const identical = (a: readonly { x: number; y: number }[], b: readonly { x: number; y: number }[]) => {
    expect(a.length).toBe(b.length);
    for (let index = 0; index < a.length; index += 1) {
      expect(a[index]!.x).toBeCloseTo(b[index]!.x, 9);
      expect(a[index]!.y).toBeCloseTo(b[index]!.y, 9);
    }
  };

  it("gives the same answer as solving from scratch, frame after frame", () => {
    // The whole point is that the factorisation survives a drag while the pins move. If a cached
    // frame differed from an uncached one by anything, the cache would be reusing a matrix that
    // no longer describes the problem.
    const mesh = puppetMesh(BOUNDS, 4);
    const held = nearestVertex(mesh, { x: 30, y: 30 });
    const dragged = nearestVertex(mesh, { x: 90, y: 90 });
    const cache = createPuppetSolverCache();
    for (let frame = 0; frame < 6; frame += 1) {
      const pins = [
        { vertex: held, at: mesh.vertices[held]! },
        { vertex: dragged, at: { x: mesh.vertices[dragged]!.x + frame * 3, y: mesh.vertices[dragged]!.y - frame * 2 } },
      ];
      identical(solvePuppetMesh(mesh, pins, cache), solvePuppetMesh(mesh, pins));
    }
  });

  it("throws the factorisation away when the pins themselves change", () => {
    // Adding, removing or newly rotating a pin changes which entries the matrices have, not just
    // their right-hand side — reusing across that would silently solve the previous problem.
    const mesh = puppetMesh(BOUNDS, 4);
    const first = nearestVertex(mesh, { x: 30, y: 30 });
    const second = nearestVertex(mesh, { x: 90, y: 40 });
    const cache = createPuppetSolverCache();

    const onePin = [{ vertex: first, at: { x: mesh.vertices[first]!.x + 8, y: mesh.vertices[first]!.y } }];
    solvePuppetMesh(mesh, onePin, cache);

    const twoPins = [...onePin, { vertex: second, at: mesh.vertices[second]! }];
    identical(solvePuppetMesh(mesh, twoPins, cache), solvePuppetMesh(mesh, twoPins));

    // And the same again when a pin gains an angle, which adds its whole one-ring to the system.
    const turned = twoPins.map((pin, index) => index === 1 ? { ...pin, rotation: Math.PI / 5 } : pin);
    identical(solvePuppetMesh(mesh, turned, cache), solvePuppetMesh(mesh, turned));
  });

  it("does not care what order the pins arrive in", () => {
    // The signature is sorted, so re-ordering the same pins must not force a refactorisation —
    // and must not produce a different answer either.
    const mesh = puppetMesh(BOUNDS, 4);
    const a = nearestVertex(mesh, { x: 30, y: 30 }), b = nearestVertex(mesh, { x: 90, y: 40 });
    const pins = [{ vertex: a, at: { x: mesh.vertices[a]!.x + 5, y: mesh.vertices[a]!.y } }, { vertex: b, at: mesh.vertices[b]! }];
    const cache = createPuppetSolverCache();
    solvePuppetMesh(mesh, pins, cache);
    identical(solvePuppetMesh(mesh, [...pins].reverse(), cache), solvePuppetMesh(mesh, pins));
  });
});
