import * as THREE from "three";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { FontLoader } from "three/addons/loaders/FontLoader.js";
import { TextGeometry } from "three/addons/geometries/TextGeometry.js";
import { layerContentBounds, layerPixelsView, type RasterDocumentState, type RasterLayer, type RasterRect, type Scene3DLayerData } from "@vravio/env-raster";
import type { AssetId } from "@vravio/kernel";
import { applyLighting, centerInParent, createScene3D, placeCameraForDocument, readPixelsRgba } from "./three3d";
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

export interface AlphaOutline {
  /** Clockwise in document (y-down) space. */
  readonly outer: { x: number; y: number }[];
  readonly holes: { x: number; y: number }[][];
}

/**
 * Every boundary of a layer's opaque pixels — each separate part, each with its holes — as
 * polygons on pixel corners, in document coordinates: the "extrude another layer" source.
 *
 * Potrace's path decomposition (Selinger, "Potrace: a polygon-based tracing algorithm", §2.1),
 * the step Inkscape's Trace Bitmap runs first: every edge between an opaque and a transparent
 * pixel becomes a directed edge with the opaque side on its right, the edges are linked into
 * closed paths, and a path's orientation says what it is — clockwise (in y-down space) around
 * filled pixels, anticlockwise around a hole. At a corner where two pixels touch only diagonally
 * the path always turns right, so they stay separate parts and no path touches itself (a pinched
 * polygon is what triangulation handles worst). Each hole then goes to the smallest outline that
 * contains it — three.js's own `SVGLoader.createShapes` groups holes the same way.
 *
 * What this replaced walked one Moore-neighbour contour from the first opaque pixel it found: a
 * layer of separate letters extruded only its first letter, and every letter's hole was filled
 * in (§65.9).
 */
export function traceAlphaOutlines(pixels: Uint8ClampedArray, width: number, height: number, minArea = 4): AlphaOutline[] {
  const opaque = (x: number, y: number) => x >= 0 && x < width && y >= 0 && y < height && pixels[(y * width + x) * 4 + 3]! > 16;
  const stride = width + 1;
  // Directed boundary edges keyed by their start vertex. A vertex starts at most two edges (the
  // diagonal case), so two slots per vertex; direction 0..3 = east, south, west, north.
  const first = new Int8Array(stride * (height + 1)).fill(-1);
  const second = new Int8Array(stride * (height + 1)).fill(-1);
  const add = (vx: number, vy: number, direction: number) => {
    const at = vy * stride + vx;
    if (first[at] === -1) first[at] = direction; else second[at] = direction;
  };
  let edges = 0;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    if (!opaque(x, y)) continue;
    // Clockwise around the pixel in y-down space, so the opaque pixel is always on the right.
    if (!opaque(x, y - 1)) { add(x, y, 0); edges += 1; }
    if (!opaque(x + 1, y)) { add(x + 1, y, 1); edges += 1; }
    if (!opaque(x, y + 1)) { add(x + 1, y + 1, 2); edges += 1; }
    if (!opaque(x - 1, y)) { add(x, y + 1, 3); edges += 1; }
  }
  if (edges === 0) return [];
  const step = [[1, 0], [0, 1], [-1, 0], [0, -1]] as const;
  const take = (at: number, incoming: number): number => {
    const a = first[at]!, b = second[at]!;
    if (b === -1) { first[at] = -1; return a; }
    // Two ways on: prefer the right turn (incoming + 1), keeping diagonal neighbours apart.
    const right = (incoming + 1) % 4;
    if (a === right) { first[at] = b; second[at] = -1; return a; }
    second[at] = -1; return b;
  };
  const loops: { x: number; y: number }[][] = [];
  for (let start = 0; start < first.length; start += 1) {
    while (first[start] !== -1) {
      const points: { x: number; y: number }[] = [];
      let vx = start % stride, vy = Math.floor(start / stride);
      const startX = vx, startY = vy;
      // The loop's first edge: no incoming direction yet, so either slot will do.
      let direction = first[start]!;
      if (second[start] !== -1) { first[start] = second[start]!; second[start] = -1; } else first[start] = -1;
      let previous = -1;
      for (let guard = 0; guard <= edges; guard += 1) {
        // Only corners are kept: a run of edges in one direction is one straight side.
        if (direction !== previous) points.push({ x: vx, y: vy });
        previous = direction;
        vx += step[direction]![0]; vy += step[direction]![1];
        if (vx === startX && vy === startY) break;
        const at = vy * stride + vx;
        if (first[at] === -1) break;
        direction = take(at, direction);
      }
      if (points.length >= 3) loops.push(points);
    }
  }
  const signedArea = (loop: readonly { x: number; y: number }[]) => {
    let sum = 0;
    for (let index = 0; index < loop.length; index += 1) { const p = loop[index]!, q = loop[(index + 1) % loop.length]!; sum += p.x * q.y - q.x * p.y; }
    return sum / 2;
  };
  const inside = (point: { x: number; y: number }, loop: readonly { x: number; y: number }[]) => {
    let hit = false;
    for (let index = 0, previousIndex = loop.length - 1; index < loop.length; previousIndex = index, index += 1) {
      const a = loop[index]!, b = loop[previousIndex]!;
      if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) hit = !hit;
    }
    return hit;
  };
  const outlines: { outer: { x: number; y: number }[]; holes: { x: number; y: number }[][]; area: number }[] = [];
  const holes: { loop: { x: number; y: number }[]; area: number }[] = [];
  for (const loop of loops) {
    const area = signedArea(loop);
    if (Math.abs(area) < minArea) continue;
    if (area > 0) outlines.push({ outer: loop, holes: [], area }); else holes.push({ loop, area: -area });
  }
  for (const hole of holes) {
    // A point just inside the hole: the middle of its first edge, a quarter pixel to the left of
    // travel — the transparent side, since opaque is always on the right.
    const a = hole.loop[0]!, b = hole.loop[1]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const probe = { x: (a.x + b.x) / 2 + (b.y - a.y) / length * 0.25, y: (a.y + b.y) / 2 - (b.x - a.x) / length * 0.25 };
    let owner: (typeof outlines)[number] | undefined;
    for (const candidate of outlines) if (candidate.area > hole.area && inside(probe, candidate.outer) && (!owner || candidate.area < owner.area)) owner = candidate;
    owner?.holes.push(hole.loop);
  }
  return outlines.map(({ outer, holes: ownHoles }) => ({ outer, holes: ownHoles }));
}

/**
 * Rounds off the pixel-grid staircase a raw alpha-contour trace leaves along
 * any diagonal or curved edge — `traceAlphaOutlines` walks pixel corners one
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
    // The layer's own buffer, not its canvas-sized view: a source reaching past the canvas
    // extrudes whole (§65.11). Coordinates below are layer-local, which is all the shape needs.
    const pixels = layerPixelsView(layer);
    const bounds = layerContentBounds(pixels, layer.width, layer.height);
    const outlines = traceAlphaOutlines(pixels, layer.width, layer.height);
    if (!outlines.length) return new THREE.Group();
    // Smoothed before it ever becomes a THREE.Shape — a raw trace only ever
    // walks whole pixel steps, so any diagonal or curved edge in the source
    // layer would otherwise extrude with a visible staircase running the
    // full depth of the side wall. See smoothContour's own doc comment.
    const toVectors = (loop: readonly { x: number; y: number }[]) => smoothContour(loop).map((point) => new THREE.Vector2(point.x - bounds.x - bounds.width / 2, -(point.y - bounds.y - bounds.height / 2)));
    const shapes = outlines.map((outline) => {
      const shape = new THREE.Shape(toVectors(outline.outer));
      for (const hole of outline.holes) shape.holes.push(new THREE.Path(toVectors(hole)));
      return shape;
    });
    const geometry = new THREE.ExtrudeGeometry(shapes, { depth: source.depth, bevelEnabled: false });
    const scale = data.size / Math.max(bounds.width, bounds.height, 1);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: data.color, metalness: data.metalness, roughness: data.roughness }));
    mesh.scale.setScalar(scale);
    return mesh;
  }
  const record = kernel.assets.get(source.assetId as AssetId);
  if (!record) return new THREE.Group();
  const bytes = await kernel.assets.read(source.assetId as AssetId);
  if (!bytes) return new THREE.Group();
  const model = (await loadModel(source.assetId, record.head, source.fileName, bytes)).clone();
  // A model file's own units mean nothing here: it is sized to `data.size` document pixels across
  // its largest side, the same way an extruded layer is (§65.11).
  const extent = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3());
  model.scale.multiplyScalar(data.size / Math.max(extent.x, extent.y, extent.z, 1e-6));
  return model;
}

/** What a 3D layer bake produces: pixels for exactly the rectangle the object covers, and where
 * that rectangle sits in document coordinates — which may reach past the canvas on any side. */
export interface Scene3DRender {
  readonly pixels: Uint8ClampedArray;
  readonly frame: RasterRect;
}

/**
 * Where a rotated object lands on screen, in the document camera's full-view pixels — the 8
 * corners of its world bounding box, projected. Conservative (an axis-aligned box around a turned
 * object is larger than its silhouette), which only costs a few transparent pixels that
 * `setLayerFramePixels` trims away. Null when a corner is behind the camera: the object is then
 * too close to bound this way, and the caller falls back to a generous fixed frame.
 */
function projectedRect(object: THREE.Object3D, camera: THREE.PerspectiveCamera, width: number, height: number): RasterRect | null {
  object.updateMatrixWorld(true);
  camera.updateMatrixWorld();
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return null;
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  const corner = new THREE.Vector3();
  for (let index = 0; index < 8; index += 1) {
    corner.set(index & 1 ? box.max.x : box.min.x, index & 2 ? box.max.y : box.min.y, index & 4 ? box.max.z : box.min.z);
    const inView = corner.clone().applyMatrix4(camera.matrixWorldInverse);
    if (inView.z >= -camera.near) return null;
    corner.project(camera);
    const x = (corner.x + 1) / 2 * width, y = (1 - corner.y) / 2 * height;
    left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  const x = Math.floor(left) - 2, y = Math.floor(top) - 2;
  return { x, y, width: Math.ceil(right) - x + 2, height: Math.ceil(bottom) - y + 2 };
}

/**
 * Renders a 3D layer — the non-destructive "re-render on every property change" a 3D layer needs
 * to behave like a text layer that happens to be a mesh.
 *
 * The object turns about its own centre (`centerInParent`), is sized in document pixels
 * (`placeCameraForDocument`), and `offset` is where that centre sits relative to the canvas
 * centre. Only the rectangle the object covers is rendered, through the camera's view offset, so
 * it never depends on the canvas: an object turned or moved past the edge keeps every pixel, and
 * the caller stores the result in the layer's own frame (§65.11). What this replaced rendered a
 * canvas-sized buffer and then shifted it, which dropped whatever left the canvas for good, and
 * re-centred the 2D silhouette on every bake — so an asymmetric object visibly jumped on commit
 * away from where the live rotate view had shown it.
 */
export async function renderScene3DLayer(data: Scene3DLayerData, document: RasterDocumentState, offset: { x: number; y: number } = { x: 0, y: 0 }): Promise<Scene3DRender> {
  const object = await buildGeometrySource(data, document);
  const scene3d = createScene3D(window.document.createElement("canvas"), document.width, document.height);
  // `dispose()` in `finally`: a renderer left undisposed after a throw leaks toward the browser's
  // own limit on live WebGL contexts, which shows up as some other 3D view losing its context.
  try {
    const rig = new THREE.Group();
    rig.add(object);
    scene3d.scene.add(rig);
    centerInParent(object);
    placeCameraForDocument(scene3d.camera, document.width, document.height);
    rig.rotation.set(data.rotationX * Math.PI / 180, data.rotationY * Math.PI / 180, data.rotationZ * Math.PI / 180);
    applyLighting(scene3d, data.lighting, Math.max(document.width, document.height));
    const ground = applyGroundPlane(scene3d, rig, data.ground);
    const shiftX = Math.round(offset.x), shiftY = Math.round(offset.y);
    // A shadow plane reaches well past the object; the canvas is the frame it always had.
    let rect = ground ? null : projectedRect(rig, scene3d.camera, document.width, document.height);
    if (!rect) rect = { x: 0, y: 0, width: document.width, height: document.height };
    // Bounded by what the GPU can render in one pass, around the object's own centre.
    const limit = Math.min(scene3d.renderer.capabilities.maxTextureSize, 8192);
    if (rect.width > limit) { rect = { ...rect, x: Math.round(document.width / 2 - limit / 2), width: limit }; }
    if (rect.height > limit) { rect = { ...rect, y: Math.round(document.height / 2 - limit / 2), height: limit }; }
    scene3d.renderer.setSize(rect.width, rect.height, false);
    scene3d.camera.setViewOffset(document.width, document.height, rect.x, rect.y, rect.width, rect.height);
    const pixels = readPixelsRgba(scene3d.renderer, scene3d.scene, scene3d.camera, rect.width, rect.height);
    return { pixels, frame: { x: rect.x + shiftX, y: rect.y + shiftY, width: rect.width, height: rect.height } };
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
