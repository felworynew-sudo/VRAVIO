import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { centerInParent, placeCameraForDocument } from "./three3d";

/** §65.11 — the 3D layer's object must turn in place and keep its size in document pixels. */
describe("3D layer framing", () => {
  it("turns an off-centre object about its own centre, not about its rig's origin", () => {
    // Text geometry starts at its corner and an extrusion runs from z=0 to its depth — an object
    // whose own origin is nowhere near its middle, like this one.
    const geometry = new THREE.BoxGeometry(200, 60, 40).translate(100, 30, 20);
    const mesh = new THREE.Mesh(geometry);
    const rig = new THREE.Group();
    rig.add(mesh);
    centerInParent(mesh);
    for (const [x, y, z] of [[0, 0, 0], [0, 70, 0], [30, -40, 90]] as const) {
      rig.rotation.set(x * Math.PI / 180, y * Math.PI / 180, z * Math.PI / 180);
      rig.updateMatrixWorld(true);
      const center = new THREE.Box3().setFromObject(mesh).getCenter(new THREE.Vector3());
      expect(center.length(), `rotation ${x},${y},${z}`).toBeLessThan(1e-6);
    }
  });

  it("maps one world unit at the pivot's depth to one document pixel", () => {
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
    placeCameraForDocument(camera, 1000, 600);
    camera.updateMatrixWorld();
    const toPixel = (point: THREE.Vector3) => { const p = point.clone().project(camera); return { x: (p.x + 1) / 2 * 1000, y: (1 - p.y) / 2 * 600 }; };
    const origin = toPixel(new THREE.Vector3(0, 0, 0));
    expect(origin.x).toBeCloseTo(500, 6);
    expect(origin.y).toBeCloseTo(300, 6);
    const right = toPixel(new THREE.Vector3(150, 0, 0)), up = toPixel(new THREE.Vector3(0, 80, 0));
    expect(right.x - origin.x).toBeCloseTo(150, 6);
    expect(origin.y - up.y).toBeCloseTo(80, 6);
  });
});
