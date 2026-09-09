import { describe, expect, it } from "vitest";
import { nearestVertex, puppetMesh, puppetWarpPixels, solvePuppetMesh } from "./index";

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
