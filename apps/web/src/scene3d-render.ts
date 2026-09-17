import * as THREE from "three";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { FontLoader } from "three/addons/loaders/FontLoader.js";
import { TextGeometry } from "three/addons/geometries/TextGeometry.js";
import { layerContentBounds, layerDocumentPixels, translateLayerPixels, type RasterDocumentState, type RasterLayer, type Scene3DLayerData } from "@vravio/env-raster";
import type { AssetId } from "@vravio/kernel";
import { applyLighting, centerAndFit, createScene3D, readPixelsRgba } from "./three3d";
import { applyGroundPlane } from "./scene3d-ground";
import { kernel } from "./kernel";

const fontCache = new Map<string, ReturnType<FontLoader["loadAsync"]>>();
function loadFont(name: string) {
  if (!fontCache.has(name)) fontCache.set(name, new FontLoader().loadAsync(`/fonts/${name}.typeface.json`));
  return fontCache.get(name)!;
}

const modelCache = new Map<string, Promise<THREE.Object3D>>();
/** Parses an imported model's bytes into a THREE object, cached by asset id + revision so
 * dragging a rotation slider doesn't re-parse a multi-megabyte GLB on every frame. */
export function loadModel(assetId: string, rev: number, fileName: string, bytes: Uint8Array): Promise<THREE.Object3D> {
  const key = `${assetId}@${rev}`;
  if (!modelCache.has(key)) modelCache.set(key, parseModel(fileName, bytes));
  return modelCache.get(key)!;
}

async function parseModel(fileName: string, bytes: Uint8Array): Promise<THREE.Object3D> {
  const extension = /\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toLowerCase();
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  if (extension === "obj") {
    const text = new TextDecoder().decode(bytes);
    return new OBJLoader().parse(text);
  }
  // GLTFLoader.parse also accepts .gltf's JSON text, but a dropped .gltf usually references
  // external buffers/textures that aren't available here — .glb (self-contained binary) is the
  // form this actually supports well, and is what "full model import" realistically means
  // without also building a companion-file picker.
  const gltf = await new GLTFLoader().parseAsync(buffer, "");
  return gltf.scene;
}

/** Boundary of a layer's opaque pixels, as a polygon in the layer's own local coordinates — the
 * "extrude another layer" source. Moore-neighbor tracing, outer contour only (a shape with holes
 * extrudes as if the holes were filled, which is a fair simplification for this one source kind
 * given everything else a 3D layer can already do). */
export function traceAlphaContour(pixels: Uint8ClampedArray, width: number, height: number): { x: number; y: number }[] {
  const opaque = (x: number, y: number) => x >= 0 && x < width && y >= 0 && y < height && pixels[(y * width + x) * 4 + 3]! > 16;
  let startX = -1, startY = -1;
  outer: for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) if (opaque(x, y)) { startX = x; startY = y; break outer; }
  if (startX < 0) return [];
  const directions = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
  const points: { x: number; y: number }[] = [];
  let x = startX, y = startY, direction = 6, steps = 0;
  const maxSteps = width * height;
  do {
    points.push({ x, y });
    let found = false;
    for (let turn = 0; turn < 8; turn += 1) {
      const candidate = (direction + 6 + turn) % 8;
      const [dx, dy] = directions[candidate]! as [number, number];
      if (opaque(x + dx, y + dy)) { x += dx; y += dy; direction = candidate; found = true; break; }
    }
    if (!found) break;
    steps += 1;
  } while ((x !== startX || y !== startY) && steps < maxSteps);
  return points;
}

/**
 * Rounds off the pixel-grid staircase a raw alpha-contour trace leaves along
 * any diagonal or curved edge — `traceAlphaContour` walks pixel corners one
 * unit step at a time, so a 30°-diagonal silhouette boundary comes out as a
 * literal staircase of 90° corners, and `ExtrudeGeometry` extrudes exactly
 * that: a visibly stepped side wall instead of a smooth slope.
 *
 * Chaikin's corner-cutting algorithm (Chaikin 1974 — the standard,
 * widely-implemented technique for this, not invented here: it is what
 * Inkscape's own path-smoothing and most "simplify path" tools in open
 * vector editors use under the hood). Each pass replaces every edge
 * `(P, Q)` with two points at 1/4 and 3/4 along it, converging toward a
 * quadratic B-spline of the original polygon. The reason this fixes
 * staircasing specifically, rather than blurring real corners into
 * mush: a cut removes a *fraction* of each edge's own length, so the many
 * short single-pixel treads and risers of a staircase get rounded away
 * almost entirely in a couple of passes, while a large intentional corner
 * (whose adjacent edges are long) only loses a small sliver off its tip —
 * the same reason it is the right default with no per-corner heuristics
 * needed, rather than a fixed-angle "is this corner real" threshold
 * (Potrace's approach, and considerably more code for a case this project
 * does not need: the input is already a pixel-quantized silhouette, so
 * every corner in it is approximate to begin with).
 */
export function smoothContour(points: readonly { x: number; y: number }[], iterations = 2): { x: number; y: number }[] {
  if (points.length < 3 || iterations <= 0) return points.slice();
  let current: { x: number; y: number }[] = points.slice();
  for (let pass = 0; pass < iterations; pass += 1) {
    const next: { x: number; y: number }[] = [];
    for (let index = 0; index < current.length; index += 1) {
      const p = current[index]!, q = current[(index + 1) % current.length]!;
      next.push({ x: p.x * 0.75 + q.x * 0.25, y: p.y * 0.75 + q.y * 0.25 });
      next.push({ x: p.x * 0.25 + q.x * 0.75, y: p.y * 0.25 + q.y * 0.75 });
    }
    current = next;
  }
  return current;
}

/** Exported for `scene3d-live.ts`'s persistent drag-session renderer, which builds the mesh once
 * at gesture start and only re-renders it (never rebuilds the geometry) on every subsequent
 * frame — see that module's own doc comment. */
export async function buildGeometrySource(data: Scene3DLayerData, document: RasterDocumentState): Promise<THREE.Object3D> {
  const source = data.source;
  if (source.kind === "text") {
    const font = await loadFont(source.font);
    const geometry = new TextGeometry(source.value || " ", { font, size: data.size, depth: source.depth, curveSegments: source.curveSegments, bevelEnabled: source.bevelEnabled, bevelThickness: source.bevelThickness, bevelSize: source.bevelSize, bevelSegments: source.bevelSegments });
    return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: data.color, metalness: data.metalness, roughness: data.roughness }));
  }
  if (source.kind === "extrude") {
    const layer = document.layers.find((item) => item.id === source.sourceLayerId);
    if (!layer) return new THREE.Group();
    const pixels = layerDocumentPixels(layer, document.width, document.height);
    const bounds = layerContentBounds(pixels, document.width, document.height);
    const contour = traceAlphaContour(pixels, document.width, document.height);
    if (contour.length < 3) return new THREE.Group();
    // Smoothed before it ever becomes a THREE.Shape — a raw trace only ever
    // walks whole pixel steps, so any diagonal or curved edge in the source
    // layer would otherwise extrude with a visible staircase running the
    // full depth of the side wall. See smoothContour's own doc comment.
    const smoothed = smoothContour(contour);
    const shape = new THREE.Shape(smoothed.map((point) => new THREE.Vector2(point.x - bounds.x - bounds.width / 2, -(point.y - bounds.y - bounds.height / 2))));
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: source.depth, bevelEnabled: false });
    const scale = data.size / Math.max(bounds.width, bounds.height, 1);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: data.color, metalness: data.metalness, roughness: data.roughness }));
    mesh.scale.setScalar(scale);
    return mesh;
  }
  const record = kernel.assets.get(source.assetId as AssetId);
  if (!record) return new THREE.Group();
  const bytes = await kernel.assets.read(source.assetId as AssetId);
  if (!bytes) return new THREE.Group();
  const model = await loadModel(source.assetId, record.head, source.fileName, bytes);
  return model.clone();
}

/**
 * Renders a 3D layer's current data to a document-sized RGBA buffer — the non-destructive
 * "re-render on every property change" the layer needs to behave like a text layer that happens
 * to be a mesh instead of glyphs.
 *
 * `offset` shifts the result away from `centerAndFit`'s own centered pose, in document pixels.
 * A 3D layer has no stored position of its own — its `bounds` (`RasterLayer`'s, the same field
 * every layer's Move-tool drag already writes to) is the one place "where the user last put it"
 * lives — so `offset` is always *derived* from the layer's own current bounds by the caller that
 * knows them (`updateScene3DLayer`), not carried in `Scene3DLayerData` itself: a field there could
 * only ever go stale the moment Move changed `bounds` without knowing to update it too. Omitted
 * (or `{x:0,y:0}`) reproduces a *truly* centered pose — this function measures and cancels its own
 * centering bias internally (see the `naturalBounds`/`bias` comment below) before `offset` is ever
 * applied, so a caller passing `{x:0,y:0}` is guaranteed the alpha-trimmed content actually lands
 * on the frame center, not merely that the 3D bounding box does.
 */
export async function renderScene3DLayerPixels(data: Scene3DLayerData, document: RasterDocumentState, offset: { x: number; y: number } = { x: 0, y: 0 }): Promise<Uint8ClampedArray> {
  const object = await buildGeometrySource(data, document);
  const scene3d = createScene3D(window.document.createElement("canvas"), document.width, document.height);
  // `dispose()` moved into `finally`: every rotate/shadow edit spins up a fresh WebGLRenderer here
  // and threw it away undisposed if anything between construction and the end of this function
  // (lighting, the ground plane, the actual `readPixels` call) ever threw — a real way to leak
  // toward the browser's own concurrent-WebGL-context limit over a session with many edits, which
  // reads on screen as some *other*, unrelated live 3D context silently losing its own.
  try {
    const rig = new THREE.Group();
    rig.add(object);
    scene3d.scene.add(rig);
    // Fit computed at the object's own intrinsic (unrotated) pose, *before* `rig.rotation` is
    // set — not after, which is what this used to do. Fitting against the rotated box instead
    // re-frames (and re-zooms, since the camera distance below follows the box's own radius)
    // every single rotation, since a diagonal view's axis-aligned box is bigger than a face-on
    // one of the same object — the reported "the object zooms/shifts on its own" and "transforms
    // to fit its own frame instead of the frame fitting it". Centering (inside `centerAndFit`)
    // also then happens on this same stable box, so the rotation pivot is the object's own
    // natural centroid regardless of which way it currently faces.
    centerAndFit(rig, scene3d.camera);
    rig.rotation.set(data.rotationX * Math.PI / 180, data.rotationY * Math.PI / 180, data.rotationZ * Math.PI / 180);
    applyLighting(scene3d, data.lighting, 500);

    // `centerAndFit` only guarantees the object's 3D *bounding-box* center projects to the exact
    // frame center — not that the alpha-trimmed 2D *silhouette*'s own bounding-rectangle midpoint
    // does. For an asymmetric mesh (this project's camera-rig/bracket import, any extruded logo,
    // any off-center text) those are different points, and `layer.bounds` — what
    // `updateScene3DLayer`'s own `offset` argument is derived from — is measured the second way.
    // Re-deriving `offset` from `layer.bounds` on every edit therefore fed this render's own fixed
    // asymmetry bias back in as if the user had intentionally moved the layer, and the *next* edit
    // did it again on top of that: found live as lighting/shadow-only edits (nothing touching
    // position) walking the object steadily off-frame, one fixed increment per edit, exactly the
    // "checkbox moves the layer" symptom that should never happen — position is the Move tool's
    // job alone. Measured fresh on every render (an extra cheap `readPixels` before the shadow-
    // casting ground plane exists, not trusting the previous render's own already-biased bounds) and
    // cancelled out below, so a non-positional edit can no longer accumulate any drift at all.
    const naturalPixels = readPixelsRgba(scene3d.renderer, scene3d.scene, scene3d.camera, document.width, document.height);
    const naturalBounds = layerContentBounds(naturalPixels, document.width, document.height);
    const bias = {
      x: naturalBounds.x + naturalBounds.width / 2 - document.width / 2,
      y: naturalBounds.y + naturalBounds.height / 2 - document.height / 2,
    };

    // After centerAndFit, not before: the ground plane sits at the rig's own
    // bounding-box bottom, which centerAndFit is what actually settles.
    applyGroundPlane(scene3d, rig, data.ground);
    const rendered = readPixelsRgba(scene3d.renderer, scene3d.scene, scene3d.camera, document.width, document.height);
    // Combines the caller's own requested shift with the bias correction above into one move —
    // applied after the render, on the finished bytes, rather than moving the object or camera
    // before it: every other step above already assumes "centered" (the ground plane sits under
    // the centered bounding box, the fit distance is measured from it), and a post-render shift is
    // the one change that touches none of that.
    const shiftX = offset.x - bias.x, shiftY = offset.y - bias.y;
    return shiftX || shiftY ? translateLayerPixels(rendered, document.width, document.height, shiftX, shiftY) : rendered;
  } finally {
    scene3d.dispose();
  }
}

/** The bundled helvetiker JSON typeface (three.js's own example font) only carries Latin glyphs —
 * this default value is deliberately plain Latin text, not the layer's own (bilingual) name. */
export const defaultScene3DLayer = (layer: RasterLayer): Scene3DLayerData => ({
  source: { kind: "text", value: "VRAVIO", font: "helvetiker_bold", depth: 24, bevelEnabled: true, bevelThickness: 3, bevelSize: 2, bevelSegments: 4, curveSegments: 6 },
  size: 60, color: "#c9cfda", metalness: 0.25, roughness: 0.4, rotationX: -12, rotationY: 22, rotationZ: 0,
  lighting: { ambientIntensity: 0.55, ambientColor: "#ffffff", directionalIntensity: 1.4, directionalColor: "#ffffff", azimuth: -35, elevation: 45 },
});
