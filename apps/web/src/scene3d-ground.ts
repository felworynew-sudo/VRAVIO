import * as THREE from "three";
import type { Scene3DGround } from "@vravio/env-raster";
import type { Scene3D } from "./three3d";

/**
 * The invisible ground plane a 3D layer's shadow falls onto — see
 * `Scene3DGround`'s own doc comment (env-raster/types.ts) for why this is
 * `tiltX`/`distance`, dragged into place against a live preview, rather than
 * a full photo calibration.
 *
 * `THREE.ShadowMaterial` is the actual trick that makes "invisible plane,
 * visible shadow" possible: it renders nothing but the shadow itself
 * (`color` × `opacity` wherever a shadow falls, fully transparent
 * everywhere else), so the plane composites over whatever raster layer sits
 * beneath this one — a photographed table — through this layer's own
 * ordinary alpha blending. No special-casing anywhere else in the
 * compositor.
 */
export function applyGroundPlane(scene3d: Scene3D, rig: THREE.Group, ground: Scene3DGround | undefined): THREE.Mesh | null {
  if (!ground?.enabled) return null;

  // Soft shadows need VSM specifically: `light.shadow.radius` — the blur
  // amount `softness` maps onto — only behaves as a real blur radius under
  // `VSMShadowMap`. Under the renderer's default (`PCFShadowMap`) or
  // `PCFSoftShadowMap`, `radius` means something else (a fixed small
  // percentage-closer-filter kernel), and dialing `softness` up would not
  // visibly do anything past a small ceiling — the actual bug this project's
  // own CLAUDE.md warns against, a setting that stops affecting its result.
  scene3d.renderer.shadowMap.enabled = true;
  scene3d.renderer.shadowMap.type = THREE.VSMShadowMap;

  const box = new THREE.Box3().setFromObject(rig);
  const size = box.getSize(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z, 1) / 2;

  scene3d.directional.castShadow = true;
  scene3d.directional.shadow.mapSize.set(1024, 1024);
  scene3d.directional.shadow.radius = Math.max(0, ground.softness);
  scene3d.directional.shadow.bias = -0.0015;
  const frustum = radius * 4;
  const camera = scene3d.directional.shadow.camera;
  camera.left = -frustum; camera.right = frustum; camera.top = frustum; camera.bottom = -frustum;
  camera.near = 0.1; camera.far = radius * 4 + ground.distance * 2 + 200;
  camera.updateProjectionMatrix();
  scene3d.directional.target.position.set(0, 0, 0);
  scene3d.scene.add(scene3d.directional.target);

  rig.traverse((child) => { if (child instanceof THREE.Mesh) child.castShadow = true; });

  const planeSize = Math.max(radius * 10, ground.distance * 4, 200);
  const geometry = new THREE.PlaneGeometry(planeSize, planeSize);
  const material = new THREE.ShadowMaterial({ opacity: Math.max(0, Math.min(1, ground.opacity / 100)) });
  const plane = new THREE.Mesh(geometry, material);
  plane.receiveShadow = true;
  // tiltX=0 is face-on (the plane's own default orientation, normal toward
  // the camera — a wall); tiltX=90 lays it flat with the normal pointing
  // up (a floor seen from above). See the type's own doc comment.
  plane.rotation.x = -ground.tiltX * Math.PI / 180;
  plane.position.set(0, box.min.y - ground.distance, 0);
  scene3d.scene.add(plane);
  return plane;
}
