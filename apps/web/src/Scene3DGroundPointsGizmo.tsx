import { useEffect, useRef } from "react";
import * as THREE from "three";
import { defaultScene3DGround, type RasterDocumentState, type RasterLayer, type Scene3DGround } from "@vravio/env-raster";
import { beginLiveScene3D, type LiveScene3DSession } from "./scene3d-live";
import { tiltFromGroundNormal } from "./scene3d-ground";

/**
 * "Cast Shadow…" on a 3D layer's context menu — the owner's own replacement
 * for the tilt/distance sliders (`Scene3DGroundGizmo.tsx`, removed): drag a
 * bounded track meant "how do I even read this control", so instead this
 * asks for three or four clicks marking real points on (or near) the
 * object, the way you would place a coaster on a table by pointing at its
 * corners rather than dialing in an angle and a height by feel. Each
 * already-placed point can be dragged to a new spot afterward, not only
 * clicked once — the owner's own follow-up request, for the same reason a
 * dropped pin usually needs a nudge.
 *
 * Each click (or drag) raycasts through the live camera; a hit on the
 * object's own mesh gives an exact point on its surface (rest a
 * shadow-casting object on its own tilted face, say), and a miss falls back
 * to a horizontal reference at the object's own base so a point that lands
 * just past its silhouette still produces a sane spot instead of doing
 * nothing. Three points already define a plane; a fourth is accepted for a
 * steadier read on an imperfectly flat surface (Newell's method below, not
 * a strict three-point solve) but never required. A thin line grid across
 * the fitted plane — the owner's own request, "to feel the perspective
 * better" — reuses the exact same points, so it can never disagree with
 * what the shadow itself is about to be cast onto.
 *
 * The fitted plane previews *through the same door it will commit through*
 * — `session.setGround(...)`, the real shadow-casting plane, not a stand-in
 * outline — matching this project's own "what you see while dragging is
 * exactly what commits" rule from the slider version it replaces. Dragging
 * an already-placed point re-fits and re-renders on every pointer sample by
 * default, which is exactly the per-coalesced-sample cost `patch.tsx` was
 * just found to choke on — so the actual re-fit here is coalesced to one
 * per animation frame the same way, while the point's own marker still
 * follows the cursor immediately (cheap: a mesh position, not a solve).
 */

const MAX_POINTS = 4;
/** Screen pixels — a marker's own grab radius, independent of the document's zoom (this overlay
 *  sits outside the scaled `.raster-stage`, so screen pixels are the right unit here already). */
const POINT_HIT_RADIUS = 14;
/** How many interior grid lines the 4-point case draws in each direction — enough to read as a
 *  perspective grid without becoming visual noise on top of the object itself. */
const GRID_SUBDIVISIONS = 4;

/** Newell's method: robust for 3 or 4 (not perfectly coplanar) points alike, unlike solving a
 *  strict three-point plane and discarding a fourth click's own information. */
function fitPlaneNormal(points: readonly THREE.Vector3[]): THREE.Vector3 {
  const normal = new THREE.Vector3();
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]!, next = points[(index + 1) % points.length]!;
    normal.x += (current.y - next.y) * (current.z + next.z);
    normal.y += (current.z - next.z) * (current.x + next.x);
    normal.z += (current.x - next.x) * (current.y + next.y);
  }
  return normal.normalize();
}

function centroidOf(points: readonly THREE.Vector3[]): THREE.Vector3 {
  const sum = new THREE.Vector3();
  for (const point of points) sum.add(point);
  return sum.divideScalar(points.length);
}

/** Fits `points` to a `Scene3DGround` tilt/distance pair, reusing `base` for everything a click
 *  doesn't determine (opacity, softness — this tool is only about the plane's own placement). */
function groundFromPoints(points: readonly THREE.Vector3[], base: Scene3DGround, box: THREE.Box3): Scene3DGround {
  let normal = fitPlaneNormal(points);
  // A plane's own normal has no inherent "up" side — Newell's method can hand back either one
  // depending on click order. Flipped toward the object's own base-reference "up" (the same
  // convention the classic floor case already uses: normal (0,1,0)) so three points clicked in
  // *either* winding order read as the same surface, not its mirror.
  if (normal.y < 0) normal.negate();
  const { tiltX, tiltZ } = tiltFromGroundNormal(normal);
  const centroid = centroidOf(points);
  const center = box.getCenter(new THREE.Vector3());
  const reference = new THREE.Vector3(center.x, box.min.y, center.z);
  // The inverse of `applyGroundPlane`'s own position formula (its own comment has the forward
  // direction) — solved so the *rendered* plane actually passes through the clicked points
  // instead of merely sharing their orientation.
  const distance = normal.dot(reference.clone().sub(centroid));
  return { ...base, enabled: true, tiltX, tiltZ, distance };
}

/** The thin perspective-feel grid: the points' own outline (open until 3 exist, closed after),
 *  plus, once all four are placed, a bilinear interior grid between opposite edges — the same
 *  construction a Photoshop-style vanishing-point grid uses, just built from real clicked corners
 *  instead of a dragged-out rectangle. */
function buildGridSegments(points: readonly THREE.Vector3[]): THREE.Vector3[] {
  const segments: THREE.Vector3[] = [];
  const edge = (a: THREE.Vector3, b: THREE.Vector3) => { segments.push(a, b); };
  for (let index = 0; index < points.length - 1; index += 1) edge(points[index]!, points[index + 1]!);
  if (points.length >= 3) edge(points[points.length - 1]!, points[0]!);
  if (points.length === 4) {
    const [p0, p1, p2, p3] = points as [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3];
    for (let step = 1; step < GRID_SUBDIVISIONS; step += 1) {
      const t = step / GRID_SUBDIVISIONS;
      edge(p0.clone().lerp(p1, t), p3.clone().lerp(p2, t));
      edge(p0.clone().lerp(p3, t), p1.clone().lerp(p2, t));
    }
  }
  return segments;
}

export function Scene3DGroundPointsGizmo({
  documentId, document, layer, zoom, documentOriginX, documentOriginY, onPointsChange, onAccept, onCancel,
}: {
  documentId: string;
  document: RasterDocumentState;
  layer: RasterLayer;
  zoom: number;
  documentOriginX: number;
  documentOriginY: number;
  /** Fired on every placed/dragged point — `ground` is the live fit once 3+ points exist (the
   *  same object `onAccept` would receive if called right now), `null` while there are fewer.
   *  `count` is only for the status text ("2 more points…"), which needs it even before there is
   *  a fit yet. */
  onPointsChange(count: number, ground: Scene3DGround | null): void;
  onAccept(): void;
  onCancel(): void;
}) {
  const data = layer.scene3d!;
  const committedGround = data.ground ?? { ...defaultScene3DGround, distance: data.size * 0.3 };

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sessionRef = useRef<LiveScene3DSession | null>(null);
  const pointsRef = useRef<THREE.Vector3[]>([]);
  const markerMeshesRef = useRef<THREE.Mesh[]>([]);
  const markersGroupRef = useRef<THREE.Group | null>(null);
  const gridLineRef = useRef<THREE.LineSegments | null>(null);
  const baseBoxRef = useRef<THREE.Box3 | null>(null);
  const draggingIndexRef = useRef<number | null>(null);
  const fitFrameRef = useRef<number | null>(null);
  const onPointsChangeRef = useRef(onPointsChange);
  onPointsChangeRef.current = onPointsChange;
  const onAcceptRef = useRef(onAccept);
  onAcceptRef.current = onAccept;
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    void beginLiveScene3D(canvas, data, document, () => cancelled).then((session) => {
      if (!session) return;
      if (cancelled) { session.dispose(); return; }
      sessionRef.current = session;
      baseBoxRef.current = new THREE.Box3().setFromObject(session.rig);
      const markersGroup = new THREE.Group();
      markersGroupRef.current = markersGroup;
      session.scene.add(markersGroup);
      if (committedGround.enabled) session.setGround(committedGround);
      session.render();
    });

    /** Rebuilds the thin outline/grid from the current points — cheap (a handful of line
     *  segments), safe to call on every pointer sample unlike the actual plane re-fit below. */
    const refreshGrid = (session: LiveScene3DSession) => {
      const segments = buildGridSegments(pointsRef.current);
      gridLineRef.current?.geometry.dispose();
      if (gridLineRef.current) session.scene.remove(gridLineRef.current);
      if (segments.length) {
        const geometry = new THREE.BufferGeometry().setFromPoints(segments);
        const line = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: 0xffcc33, transparent: true, opacity: 0.65 }));
        session.scene.add(line);
        gridLineRef.current = line;
      } else {
        gridLineRef.current = null;
      }
    };

    /** The actual plane fit + `setGround` — a real recompute, not free. Coalesced to at most once
     *  per animation frame (the same fix `patch.tsx`'s own onPointerMove just got): dragging a
     *  point fires a pointer sample far faster than the browser paints, and re-fitting for every
     *  one of them in a row is exactly the "hangs, keeps flickering" pattern already found and
     *  fixed there. */
    const scheduleFit = (session: LiveScene3DSession, box: THREE.Box3) => {
      if (fitFrameRef.current !== null) return;
      fitFrameRef.current = requestAnimationFrame(() => {
        fitFrameRef.current = null;
        if (pointsRef.current.length < 3) return;
        const ground = groundFromPoints(pointsRef.current, committedGround, box);
        session.setGround(ground);
        onPointsChangeRef.current(pointsRef.current.length, ground);
      });
    };

    const pointerToWorld = (session: LiveScene3DSession, box: THREE.Box3, event: PointerEvent): THREE.Vector3 | null => {
      const rect = canvas.getBoundingClientRect();
      const ndcX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      const ndcY = -(((event.clientY - rect.top) / rect.height) * 2 - 1);
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), session.camera);
      const hit = raycaster.intersectObject(session.rig, true)[0];
      if (hit) return hit.point;
      // A point that misses the object's own mesh — the horizontal reference at its base, so
      // "roughly where I pointed" still lands somewhere sane instead of doing nothing.
      const referencePlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -box.min.y);
      const fallback = new THREE.Vector3();
      return raycaster.ray.intersectPlane(referencePlane, fallback) ? fallback : null;
    };

    /** Which already-placed point (if any) a screen position is close enough to grab — compares
     *  in screen pixels, not world units, so the grab radius stays the same size regardless of
     *  how near or far that point's own surface is from the camera. */
    const hitTestPoint = (session: LiveScene3DSession, clientX: number, clientY: number): number | null => {
      const rect = canvas.getBoundingClientRect();
      let closestIndex: number | null = null, closestDistance = POINT_HIT_RADIUS;
      for (let index = 0; index < pointsRef.current.length; index += 1) {
        const projected = pointsRef.current[index]!.clone().project(session.camera);
        const screenX = rect.left + (projected.x + 1) / 2 * rect.width, screenY = rect.top + (1 - (projected.y + 1) / 2) * rect.height;
        const distance = Math.hypot(clientX - screenX, clientY - screenY);
        if (distance <= closestDistance) { closestDistance = distance; closestIndex = index; }
      }
      return closestIndex;
    };

    const onPointerDown = (event: PointerEvent) => {
      const session = sessionRef.current, box = baseBoxRef.current, markersGroup = markersGroupRef.current;
      if (!session || !box || !markersGroup) return;
      const existing = hitTestPoint(session, event.clientX, event.clientY);
      if (existing !== null) {
        draggingIndexRef.current = existing;
        canvas.setPointerCapture(event.pointerId);
        return;
      }
      if (pointsRef.current.length >= MAX_POINTS) return;
      const point = pointerToWorld(session, box, event);
      if (!point) return;
      pointsRef.current = [...pointsRef.current, point];
      const marker = new THREE.Mesh(new THREE.SphereGeometry(Math.max(2, box.getSize(new THREE.Vector3()).length() * 0.015), 12, 8), new THREE.MeshBasicMaterial({ color: 0xffcc33 }));
      marker.position.copy(point);
      markersGroup.add(marker);
      markerMeshesRef.current.push(marker);
      refreshGrid(session);
      if (pointsRef.current.length >= 3) scheduleFit(session, box);
      else { session.render(); onPointsChangeRef.current(pointsRef.current.length, null); }
    };

    const onPointerMove = (event: PointerEvent) => {
      const index = draggingIndexRef.current;
      const session = sessionRef.current, box = baseBoxRef.current;
      if (index === null || !session || !box) return;
      const point = pointerToWorld(session, box, event);
      if (!point) return;
      // The marker itself (and the outline/grid built from it) follows every sample — cheap, and
      // dragging feels dead if only the eventual shadow moves. Only the real plane re-fit below
      // is throttled.
      pointsRef.current[index] = point;
      markerMeshesRef.current[index]?.position.copy(point);
      refreshGrid(session);
      session.render();
      scheduleFit(session, box);
    };

    const onPointerUp = () => { draggingIndexRef.current = null; };

    canvas.addEventListener("pointerdown", onPointerDown);
    // On window, not the canvas: a fast drag can carry the pointer outside the canvas's own
    // bounds between samples, and losing the drag there would strand the point mid-move.
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Enter") {
        event.preventDefault();
        if (pointsRef.current.length >= 3) onAcceptRef.current();
      } else if (event.key === "Escape") {
        event.preventDefault();
        onCancelRef.current();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);

    return () => {
      cancelled = true;
      canvas.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("keydown", onKeyDown, true);
      if (fitFrameRef.current !== null) cancelAnimationFrame(fitFrameRef.current);
      sessionRef.current?.dispose();
      sessionRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layer.id, documentId]);

  return <canvas ref={canvasRef} className="scene3d-live-canvas" width={document.width} height={document.height}
    style={{ left: documentOriginX, top: documentOriginY, width: document.width * zoom, height: document.height * zoom, pointerEvents: "auto" }} />;
}
