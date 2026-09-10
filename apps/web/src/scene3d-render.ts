import * as THREE from "three";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { FontLoader } from "three/addons/loaders/FontLoader.js";
import { TextGeometry } from "three/addons/geometries/TextGeometry.js";
import { layerContentBounds, layerDocumentPixels, type RasterDocumentState, type RasterLayer, type Scene3DLayerData } from "@vravio/env-raster";
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

/** Renders a 3D layer's current data to a document-sized RGBA buffer — the non-destructive
 * "re-render on every property change" the layer needs to behave like a text layer that happens
 * to be a mesh instead of glyphs. */
export async function renderScene3DLayerPixels(data: Scene3DLayerData, document: RasterDocumentState): Promise<Uint8ClampedArray> {
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
    rig.rotation.set(data.rotationX * Math.PI / 180, data.rotationY * Math.PI / 180, data.rotationZ * Math.PI / 180);
    scene3d.scene.add(rig);
    centerAndFit(rig, scene3d.camera);
    applyLighting(scene3d, data.lighting, 500);
    // After centerAndFit, not before: the ground plane sits at the rig's own
    // bounding-box bottom, which centerAndFit is what actually settles.
    applyGroundPlane(scene3d, rig, data.ground);
    return readPixelsRgba(scene3d.renderer, scene3d.scene, scene3d.camera, document.width, document.height);
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
