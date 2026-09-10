import * as THREE from "three";
import type { RasterDocumentState, Scene3DLayerData } from "@vravio/env-raster";
import { applyLighting, centerAndFit, createScene3D } from "./three3d";
import { buildGeometrySource } from "./scene3d-render";

/**
 * A persistent live-render session for one interactive rotation drag — the
 * thing `docs/master-plan.md` §23.2 calls out as the actual prerequisite for
 * on-canvas 3D handles: "нужен persistent THREE.Scene/WebGLRenderer в
 * режиме редактирования (60 FPS, не create-render-readPixels-dispose на
 * каждое изменение), readPixels — только по завершении редактирования".
 *
 * `renderScene3DLayerPixels` (scene3d-render.ts) is the right tool for a
 * single commit, and the wrong one for a live drag: it rebuilds the mesh
 * geometry from scratch (re-tracing an extrude source's alpha contour,
 * re-laying-out a text source's glyphs) and reads the whole canvas back via
 * `gl.readPixels` — on every single call. A rotation-only drag never changes
 * the geometry at all, so this session builds the mesh exactly once, and
 * every subsequent frame only updates `rig.rotation` and calls
 * `renderer.render()` straight to a visible `<canvas>` — no readback, no
 * document compositing, nothing baked until the gesture actually ends.
 */
export interface LiveScene3DSession {
  setRotation(rotationX: number, rotationY: number, rotationZ: number): void;
  dispose(): void;
}

export async function beginLiveScene3D(canvas: HTMLCanvasElement, data: Scene3DLayerData, document: RasterDocumentState): Promise<LiveScene3DSession> {
  const object = await buildGeometrySource(data, document);
  const scene3d = createScene3D(canvas, document.width, document.height);
  const rig = new THREE.Group();
  rig.add(object);
  scene3d.scene.add(rig);
  applyLighting(scene3d, data.lighting, 500);
  let disposed = false;
  const setRotation = (rotationX: number, rotationY: number, rotationZ: number) => {
    if (disposed) return;
    rig.rotation.set(rotationX * Math.PI / 180, rotationY * Math.PI / 180, rotationZ * Math.PI / 180);
    // Re-centering every frame is deliberate, not an oversight: an
    // asymmetric mesh's screen-space bounding box shifts as it turns, and
    // `renderScene3DLayerPixels` (the commit path this session's own final
    // frame has to visually match) re-centers on every render too — a
    // session that centered once, at the start, would drift out of step
    // with where the committed bake ends up the moment rotation changes.
    centerAndFit(rig, scene3d.camera);
    scene3d.renderer.render(scene3d.scene, scene3d.camera);
  };
  setRotation(data.rotationX, data.rotationY, data.rotationZ);
  return {
    setRotation,
    dispose: () => { disposed = true; scene3d.dispose(); },
  };
}

/**
 * The on-canvas rotation sliders' own arithmetic — schematically the owner's
 * own drawing, "-------o------": a bounded track whose knob position is an
 * *absolute* reading of the current angle, the same [-180°, 180°] range the
 * Properties panel's own rotation sliders already use, just relocated onto
 * the layer itself. Kept pure and separate from the React component wiring
 * them up (this codebase's own convention — the tool state-machine math in
 * `move.tsx` is pure functions, the JSX around it is thin) so the mapping is
 * unit-testable without a DOM.
 */
export function rotationFromTrackOffset(offset: number, trackLength: number): number {
  if (trackLength <= 0) return 0;
  const fraction = Math.max(0, Math.min(1, offset / trackLength));
  return Math.round(fraction * 360 - 180);
}

export function trackOffsetFromRotation(rotation: number, trackLength: number): number {
  const clamped = Math.max(-180, Math.min(180, rotation));
  return ((clamped + 180) / 360) * trackLength;
}
