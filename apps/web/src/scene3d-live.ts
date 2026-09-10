import * as THREE from "three";
import type { RasterDocumentState, Scene3DGround, Scene3DLayerData } from "@vravio/env-raster";
import { applyLighting, centerAndFit, createScene3D, type Scene3D } from "./three3d";
import { buildGeometrySource } from "./scene3d-render";
import { applyGroundPlane } from "./scene3d-ground";

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
  /** Rebuilds the ground plane and shadow-camera setup for a new tilt/distance/opacity/softness
   * — see `scene3d-ground.ts`'s own doc comment. Removing the previous plane first, rather than
   * just repositioning it, is deliberate: `enabled: false` (or switching the whole feature off
   * mid-session) has to actually remove the shadow, not leave a zero-opacity plane still
   * consuming a shadow-map render pass every frame. */
  setGround(ground: Scene3DGround | undefined): void;
  dispose(): void;
}

/**
 * `isCancelled`, checked right after the async geometry build and before touching the canvas at
 * all: `buildGeometrySource` can await a font/model fetch for a real stretch of time, and if the
 * caller's own effect was already cleaned up by the time it resolves — closed the gizmo already,
 * or (in dev) React StrictMode's mount→cleanup→mount double-invoke — creating a `WebGLRenderer`
 * here anyway hands back a session nobody will ever call `render()` on, whose own `dispose()`
 * only runs once the caller notices via this same `cancelled` flag. Twice in a row on the *same*
 * canvas element (StrictMode's replay keeps the DOM commit, so both invocations share one canvas)
 * is worse than a leak: two `WebGLRenderer`s calling `canvas.getContext(...)` both resolve to the
 * *same* underlying context, and the first one's `dispose()` — arriving after the second has
 * already started drawing into it — quietly resets state the second renderer assumed it still
 * owned. Found by reproducing the "the object doesn't render, only the gizmo rings do" symptom:
 * the scene graph was correct (mesh present, visible, right parent) on the surviving session, so
 * only a corrupted *shared* GL context explained a structurally sound scene drawing empty.
 * Checking before creating the renderer at all — not merely disposing sooner afterward — is what
 * keeps two renderers from ever touching the same canvas in the first place.
 */
export async function beginLiveScene3D(canvas: HTMLCanvasElement, data: Scene3DLayerData, document: RasterDocumentState, isCancelled: () => boolean = () => false): Promise<LiveScene3DSession | null> {
  const object = await buildGeometrySource(data, document);
  if (isCancelled()) return null;
  const scene3d: Scene3D = createScene3D(canvas, document.width, document.height);
  const rig = new THREE.Group();
  rig.add(object);
  scene3d.scene.add(rig);
  // Fit once, here, at the object's own intrinsic (unrotated) pose — not on every `render()` call
  // the way this used to (re-fitting against whichever rotation happened to be live that frame).
  // A live rotate/orbit drag calls `render()` on every pointer-move tick, and re-fitting there
  // meant the camera's own distance and the rig's own centering both silently followed the
  // rotated bounding box's radius each tick — a diagonal view's axis-aligned box is bigger than a
  // face-on one of the same object, so the object visibly zoomed and drifted as it turned, on top
  // of whatever the user was actually doing. `renderScene3DLayerPixels`'s own commit path (this
  // session's one-frame counterpart) fits at the same stable pose, for the same reason — see its
  // own comment.
  centerAndFit(rig, scene3d.camera);
  applyLighting(scene3d, data.lighting, 500);
  let disposed = false;
  let groundPlane: THREE.Mesh | null = null;
  const render = () => {
    if (disposed) return;
    scene3d.renderer.render(scene3d.scene, scene3d.camera);
  };
  const setRotation = (rotationX: number, rotationY: number, rotationZ: number) => {
    if (disposed) return;
    rig.rotation.set(rotationX * Math.PI / 180, rotationY * Math.PI / 180, rotationZ * Math.PI / 180);
    render();
  };
  const setGround = (ground: Scene3DGround | undefined) => {
    if (disposed) return;
    if (groundPlane) { scene3d.scene.remove(groundPlane); groundPlane.geometry.dispose(); (groundPlane.material as THREE.Material).dispose(); groundPlane = null; }
    groundPlane = applyGroundPlane(scene3d, rig, ground);
    render();
  };
  setRotation(data.rotationX, data.rotationY, data.rotationZ);
  return {
    scene: scene3d.scene, camera: scene3d.camera, renderer: scene3d.renderer, rig,
    render, setRotation, setGround,
    dispose: () => { disposed = true; scene3d.dispose(); },
  };
}
