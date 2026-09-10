import * as THREE from "three";
import type { Scene3DGround } from "@vravio/env-raster";
import type { Scene3D } from "./three3d";

/**
 * The invisible ground plane a 3D layer's shadow falls onto — see
 * `Scene3DGround`'s own doc comment (env-raster/types.ts) for why this is
 * `tiltX`/`tiltZ`/`distance`, dragged (or point-placed) into place against a
 * live preview, rather than a full photo calibration.
 *
 * `THREE.ShadowMaterial` is the actual trick that makes "invisible plane,
 * visible shadow" possible: it renders nothing but the shadow itself
 * (`color` × `opacity` wherever a shadow falls, fully transparent
 * everywhere else), so the plane composites over whatever raster layer sits
 * beneath this one — a photographed table — through this layer's own
 * ordinary alpha blending. No special-casing anywhere else in the
 * compositor.
 */

/**
 * The plane's own surface normal for a given tilt pair — a closed-form
 * formula (not a three.js Euler decomposition) so the exact same math can
 * run in both directions: forward here, to actually orient the rendered
 * plane, and inverted by `Scene3DGroundPointsGizmo.tsx` to turn three or
 * four clicked points back into a `tiltX`/`tiltZ` pair. Relying on
 * `THREE.Euler`'s own XYZ/ZXY/etc. ordering for this would mean the two
 * directions could silently drift apart if either side's rotation order
 * ever changed — one shared formula is the only door.
 *
 * Derivation: the plane's own default normal is `(0,0,1)` (`PlaneGeometry`
 * lies in its local XY plane). Rotating by `-tiltX` around X first gives
 * `(0, sin(tiltX), cos(tiltX))`; rotating that by `tiltZ` around Z gives the
 * formula below. `tiltX=90, tiltZ=0` — the classic floor case — yields
 * `(0,1,0)`, straight up, matching the old single-axis behaviour exactly.
 */
export function groundNormal(tiltX: number, tiltZ: number): THREE.Vector3 {
  const x = tiltX * Math.PI / 180, z = tiltZ * Math.PI / 180;
  const sinX = Math.sin(x), cosX = Math.cos(x), sinZ = Math.sin(z), cosZ = Math.cos(z);
  return new THREE.Vector3(-sinX * sinZ, sinX * cosZ, cosX);
}

/**
 * The inverse of `groundNormal`: the closest `tiltX`/`tiltZ` pair for an
 * arbitrary (already-normalized) surface normal, folded so `tiltX` stays in
 * `[0, 180]` and pointed toward whichever hemisphere the caller's normal
 * already faces — `Scene3DGroundPointsGizmo.tsx`'s own three-point plane fit
 * has no guaranteed normal direction (a plane has two), so it flips first,
 * toward the camera, before calling this.
 */
export function tiltFromGroundNormal(normal: THREE.Vector3): { tiltX: number; tiltZ: number } {
  const n = normal.clone().normalize();
  const tiltX = Math.acos(Math.max(-1, Math.min(1, n.z))) * 180 / Math.PI;
  const sinX = Math.sin(tiltX * Math.PI / 180);
  // A near-vertical normal (tiltX ~ 0) leaves tiltZ meaningless — dividing by a near-zero sinX
  // would otherwise amplify floating-point noise into a wildly unstable angle for no visual gain.
  const tiltZ = sinX > 1e-4 ? Math.atan2(-n.x, n.y) * 180 / Math.PI : 0;
  return { tiltX, tiltZ };
}

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

  // Deliberately *not* derived from `radius` (the object's current, rotated bounding box) the way
  // the shadow camera's own frustum above still is: a "floor" reads as a floor because it looks
  // like it keeps going, and a plane sized off a live rotated silhouette shrinks toward a sliver
  // the moment the object turns edge-on — the reported "shadow doesn't reach past the object's
  // own bounds". A `PlaneGeometry` this size costs the same two triangles regardless, so there is
  // no reason to size it tightly in the first place.
  const planeSize = Math.max(ground.distance * 6, 3000);
  const geometry = new THREE.PlaneGeometry(planeSize, planeSize);
  const material = new THREE.ShadowMaterial({ opacity: Math.max(0, Math.min(1, ground.opacity / 100)) });
  const plane = new THREE.Mesh(geometry, material);
  plane.receiveShadow = true;
  // tiltX=90/tiltZ=0 is a floor (normal straight up); tiltX=0 is a wall facing the camera; any
  // other pair — reachable only through the point-placement UI, the slider never leaves tiltZ=0
  // — tips the plane toward an arbitrary direction. `groundNormal` is the single formula both
  // this and the point-fit's own inverse (`tiltFromGroundNormal`) agree on.
  const normal = groundNormal(ground.tiltX, ground.tiltZ ?? 0);
  plane.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
  const center = box.getCenter(new THREE.Vector3());
  // `distance` is how far *below the object's own base, along the plane's own normal* the plane
  // sits — for the classic floor (normal straight up) this is exactly the old `box.min.y -
  // distance`, so every ground saved before point-placement existed still renders identically.
  plane.position.set(center.x, box.min.y, center.z).addScaledVector(normal, -ground.distance);
  scene3d.scene.add(plane);
  return plane;
}
