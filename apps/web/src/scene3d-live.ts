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
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  /** The object a gizmo attaches to and a caller reads the live rotation back off — everything
   * else in the scene (lights, a future ground plane) hangs off `scene` directly, not this. */
  readonly rig: THREE.Group;
  /** Re-centers on the rig's current (possibly just-rotated) bounds and renders one frame —
   * the same pair `renderScene3DLayerPixels` (the commit path this session's own last frame
   * has to visually match) does on every bake, so a live session never drifts out of step with
   * where the committed result ends up. Cheap enough to call every frame of an active gizmo drag:
   * no geometry rebuild, no `readPixels`, just a bounding-box recompute and one GPU draw call. */
  render(): void;
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
  const render = () => {
    if (disposed) return;
    centerAndFit(rig, scene3d.camera);
    scene3d.renderer.render(scene3d.scene, scene3d.camera);
  };
  const setRotation = (rotationX: number, rotationY: number, rotationZ: number) => {
    if (disposed) return;
    rig.rotation.set(rotationX * Math.PI / 180, rotationY * Math.PI / 180, rotationZ * Math.PI / 180);
    render();
  };
  setRotation(data.rotationX, data.rotationY, data.rotationZ);
  return {
    scene: scene3d.scene, camera: scene3d.camera, renderer: scene3d.renderer, rig,
    render, setRotation,
    dispose: () => { disposed = true; scene3d.dispose(); },
  };
}

/**
 * A bounded track's arithmetic — a linear ["-------o------"](the owner's own drawing) whose knob
 * position is an *absolute* reading of a value across [-180°, 180°], the same range the Properties
 * panel's own rotation sliders use. No longer used for the 3D object's own rotation (replaced by
 * the Blender-style orbit gizmo, `Scene3DOrbitGizmo.tsx` — the owner tried the linear-slider
 * version live and asked for it to come off), but the same bounded-track control is reused for the
 * ground plane's tilt. Kept pure and separate from whichever component wires it up (this
 * codebase's own convention — the tool state-machine math in `move.tsx` is pure functions, the
 * JSX around it is thin) so the mapping is unit-testable without a DOM.
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
