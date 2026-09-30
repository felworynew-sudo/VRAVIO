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
    const pixels = layerDocumentPixels(layer, document.width, document.height);
    const bounds = layerContentBounds(pixels, document.width, document.height);
    const outlines = traceAlphaOutlines(pixels, document.width, document.height);
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
