import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { groundNormal, tiltFromGroundNormal } from "./scene3d-ground";

describe("groundNormal", () => {
  it("matches the old single-axis floor case: tiltX=90, tiltZ=0 points straight up", () => {
    const normal = groundNormal(90, 0);
    expect(normal.x).toBeCloseTo(0, 5);
    expect(normal.y).toBeCloseTo(1, 5);
    expect(normal.z).toBeCloseTo(0, 5);
  });

  it("matches the old single-axis wall case: tiltX=0, tiltZ=0 faces the camera", () => {
    const normal = groundNormal(0, 0);
    expect(normal.x).toBeCloseTo(0, 5);
    expect(normal.y).toBeCloseTo(0, 5);
    expect(normal.z).toBeCloseTo(1, 5);
  });

  it("is always unit length regardless of the tilt pair", () => {
    for (const [x, z] of [[65, 0], [30, 45], [90, 90], [10, -60], [0, 30]]) {
      expect(groundNormal(x!, z!).length()).toBeCloseTo(1, 5);
    }
  });
});

describe("tiltFromGroundNormal", () => {
  it("round-trips through groundNormal for a spread of tilt pairs", () => {
    for (const [tiltX, tiltZ] of [[90, 0], [65, 20], [45, -45], [30, 90], [80, -170]]) {
      const normal = groundNormal(tiltX!, tiltZ!);
      const recovered = tiltFromGroundNormal(normal);
      const recoveredNormal = groundNormal(recovered.tiltX, recovered.tiltZ);
      // Compare via the resulting normal rather than the angles themselves: several (tiltX,
      // tiltZ) pairs can describe the same physical plane (e.g. tiltZ is meaningless at
      // tiltX≈0), so the angles alone are not always unique, but the direction they produce is.
      expect(recoveredNormal.x).toBeCloseTo(normal.x, 4);
      expect(recoveredNormal.y).toBeCloseTo(normal.y, 4);
      expect(recoveredNormal.z).toBeCloseTo(normal.z, 4);
    }
  });

  it("degrades tiltZ to 0 instead of a noisy angle when the normal points nearly straight along Z", () => {
    const { tiltX, tiltZ } = tiltFromGroundNormal(new THREE.Vector3(0, 0, 1));
    expect(tiltX).toBeCloseTo(0, 3);
    expect(tiltZ).toBe(0);
  });
});
