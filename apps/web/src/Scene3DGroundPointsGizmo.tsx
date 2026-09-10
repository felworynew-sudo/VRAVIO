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
 * corners rather than dialing in an angle and a height by feel.
 *
 * Each click raycasts through the live camera; a hit on the object's own
 * mesh gives an exact point on its surface (rest a shadow-casting object on
 * its own tilted face, say), and a miss falls back to a horizontal
 * reference at the object's own base so a click that lands just past its
 * silhouette still produces a sane point instead of doing nothing. Three
 * points already define a plane; a fourth is accepted for a steadier read
 * on an imperfectly flat surface (Newell's method below, not a strict
 * three-point solve) but never required.
 *
 * The fitted plane previews *through the same door it will commit through*
 * — `session.setGround(...)`, the real shadow-casting plane, not a stand-in
 * outline — matching this project's own "what you see while dragging is
 * exactly what commits" rule from the slider version it replaces.
 */

const MAX_POINTS = 4;

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

export function Scene3DGroundPointsGizmo({
  documentId, document, layer, zoom, documentOriginX, documentOriginY, onPointsChange, onAccept, onCancel,
}: {
  documentId: string;
  document: RasterDocumentState;
  layer: RasterLayer;
  zoom: number;
  documentOriginX: number;
  documentOriginY: number;
  /** Fired on every click — `ground` is the live fit once 3+ points exist (the same object
   *  `onAccept` would receive if called right now), `null` while there are fewer. `count` is only
   *  for the status text ("2 more points…"), which needs it even before there is a fit yet. */
  onPointsChange(count: number, ground: Scene3DGround | null): void;
  onAccept(): void;
  onCancel(): void;
}) {
  const data = layer.scene3d!;
  const committedGround = data.ground ?? { ...defaultScene3DGround, distance: data.size * 0.3 };

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sessionRef = useRef<LiveScene3DSession | null>(null);
  const pointsRef = useRef<THREE.Vector3[]>([]);
  const markersRef = useRef<THREE.Group | null>(null);
  const baseBoxRef = useRef<THREE.Box3 | null>(null);
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
      const markers = new THREE.Group();
      markersRef.current = markers;
      session.scene.add(markers);
      if (committedGround.enabled) session.setGround(committedGround);
      session.render();
    });

    const onPointerDown = (event: PointerEvent) => {
      const session = sessionRef.current, box = baseBoxRef.current, markers = markersRef.current;
      if (!session || !box || !markers || pointsRef.current.length >= MAX_POINTS) return;
      const rect = canvas.getBoundingClientRect();
      const ndcX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      const ndcY = -(((event.clientY - rect.top) / rect.height) * 2 - 1);
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), session.camera);
      const hit = raycaster.intersectObject(session.rig, true)[0];
      let point: THREE.Vector3;
      if (hit) {
        point = hit.point;
      } else {
        // A click that misses the object's own mesh — the horizontal reference at its base, so
        // "roughly where I pointed" still lands somewhere sane instead of being silently dropped.
        const referencePlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -box.min.y);
        const fallback = new THREE.Vector3();
        if (!raycaster.ray.intersectPlane(referencePlane, fallback)) return;
        point = fallback;
      }
      pointsRef.current = [...pointsRef.current, point];
      const marker = new THREE.Mesh(new THREE.SphereGeometry(Math.max(2, box.getSize(new THREE.Vector3()).length() * 0.015), 12, 8), new THREE.MeshBasicMaterial({ color: 0xffcc33 }));
      marker.position.copy(point);
      markers.add(marker);
      if (pointsRef.current.length >= 3) {
        const ground = groundFromPoints(pointsRef.current, committedGround, box);
        session.setGround(ground);
        onPointsChangeRef.current(pointsRef.current.length, ground);
      } else {
        session.render();
        onPointsChangeRef.current(pointsRef.current.length, null);
      }
    };
    canvas.addEventListener("pointerdown", onPointerDown);

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
      window.removeEventListener("keydown", onKeyDown, true);
      sessionRef.current?.dispose();
      sessionRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layer.id, documentId]);

  return <canvas ref={canvasRef} className="scene3d-live-canvas" width={document.width} height={document.height}
    style={{ left: documentOriginX, top: documentOriginY, width: document.width * zoom, height: document.height * zoom, pointerEvents: "auto" }} />;
}
