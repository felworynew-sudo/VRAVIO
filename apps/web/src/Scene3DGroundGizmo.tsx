import { useEffect, useRef, useState } from "react";
import { defaultScene3DGround, type RasterDocumentState, type RasterLayer, type Scene3DGround } from "@vravio/env-raster";
import { beginLiveScene3D, trackOffsetFromValue, valueFromTrackOffset, type LiveScene3DSession } from "./scene3d-live";
import { updateScene3DLayer } from "./scene3d-commands";

/**
 * The ground plane's own on-canvas controls — "Cast Shadow" on a 3D layer's
 * context menu. Two linear tracks, the same control style the object's own
 * rotation briefly had and lost (the owner asked for that one to come off in
 * favor of a Blender-style gizmo) — kept here deliberately, because this is
 * a different kind of adjustment: tilt and distance are each genuinely
 * one-dimensional (there is no "orbit" reading for "how far below the
 * object does the invisible table sit"), and a bounded track is the direct,
 * honest control for a bounded one-axis value, the same way the Properties
 * panel's own sliders already are for everything else on this layer.
 *
 * Drag either track and the shadow updates live, through the same
 * persistent-session door (`scene3d-live.ts`) the rotation gizmo uses —
 * rebuilding only the ground plane and re-rendering, never the object's own
 * geometry. Released, it commits once through `updateScene3DLayer`.
 */

const TILT_MIN = 0, TILT_MAX = 90;
const TRACK_MARGIN = 18;
const TRACK_LENGTH = 160;

interface DragState {
  readonly axis: "tilt" | "distance";
  readonly pointerId: number;
  readonly trackStart: number;
  readonly trackLength: number;
  readonly vertical: boolean;
  ground: Scene3DGround;
}

export function Scene3DGroundGizmo({
  documentId, document, layer, zoom, documentOriginX, documentOriginY, onClose,
}: {
  documentId: string;
  document: RasterDocumentState;
  layer: RasterLayer;
  zoom: number;
  documentOriginX: number;
  documentOriginY: number;
  onClose(): void;
}) {
  const data = layer.scene3d!;
  const committedGround = data.ground ?? { ...defaultScene3DGround, distance: data.size * 0.3 };
  const distanceMax = Math.max(committedGround.distance * 2, data.size);

  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  dragRef.current = drag;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sessionRef = useRef<LiveScene3DSession | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // The live canvas exists in the DOM (and the session starts) once, on
  // mount — unlike the rotation gizmo's own per-drag session, this one
  // covers the whole "Cast Shadow" visit: every track drag reuses it,
  // since none of them touch the object's own geometry either.
  useEffect(() => {
    if (!canvasRef.current) return;
    let cancelled = false;
    void beginLiveScene3D(canvasRef.current, data, document, () => cancelled).then((session) => {
      if (!session) return;
      if (cancelled) { session.dispose(); return; }
      sessionRef.current = session;
      session.setGround(committedGround);
    });
    return () => { cancelled = true; sessionRef.current?.dispose(); sessionRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layer.id, documentId]);

  // Escape closes the panel — the same convention the orbit gizmo and
  // move.tsx's own pending transform use. Ignored mid-drag, so it cannot
  // race an active gesture.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || dragRef.current) return;
      event.preventDefault();
      onCloseRef.current();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  const screenX = documentOriginX + layer.bounds.x * zoom;
  const screenY = documentOriginY + layer.bounds.y * zoom;
  const screenWidth = layer.bounds.width * zoom;
  const screenHeight = layer.bounds.height * zoom;
  const tiltLeft = screenX + screenWidth / 2 - TRACK_LENGTH / 2;
  const tiltTop = screenY + screenHeight + TRACK_MARGIN;
  const distanceLeft = screenX + screenWidth + TRACK_MARGIN;
  const distanceTop = screenY + screenHeight / 2 - TRACK_LENGTH / 2;

  const liveGround = drag?.ground ?? committedGround;
  const tiltOffset = trackOffsetFromValue(liveGround.tiltX, TRACK_LENGTH, TILT_MIN, TILT_MAX);
  const distanceOffset = trackOffsetFromValue(liveGround.distance, TRACK_LENGTH, 0, distanceMax);

  const beginDrag = (axis: "tilt" | "distance", vertical: boolean, event: React.PointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const trackStart = vertical ? rect.top : rect.left;
    const trackLength = vertical ? rect.height : rect.width;
    event.currentTarget.setPointerCapture(event.pointerId);
    const offset = (vertical ? event.clientY : event.clientX) - trackStart;
    const value = axis === "tilt" ? valueFromTrackOffset(offset, trackLength, TILT_MIN, TILT_MAX) : valueFromTrackOffset(offset, trackLength, 0, distanceMax);
    const ground: Scene3DGround = { ...committedGround, enabled: true, ...(axis === "tilt" ? { tiltX: value } : { distance: value }) };
    const next: DragState = { axis, pointerId: event.pointerId, trackStart, trackLength, vertical, ground };
    dragRef.current = next;
    setDrag(next);
    sessionRef.current?.setGround(ground);
  };

  const onTrackPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const current = dragRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const offset = (current.vertical ? event.clientY : event.clientX) - current.trackStart;
    const value = current.axis === "tilt" ? valueFromTrackOffset(offset, current.trackLength, TILT_MIN, TILT_MAX) : valueFromTrackOffset(offset, current.trackLength, 0, distanceMax);
    const ground: Scene3DGround = { ...current.ground, ...(current.axis === "tilt" ? { tiltX: value } : { distance: value }) };
    const next: DragState = { ...current, ground };
    dragRef.current = next;
    setDrag(next);
    sessionRef.current?.setGround(ground);
  };

  const onTrackPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const current = dragRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDrag(null);
    void updateScene3DLayer(documentId, layer.id, { ground: current.ground });
  };

  return <>
    <canvas ref={canvasRef} className="scene3d-live-canvas" width={document.width} height={document.height}
      style={{ left: documentOriginX, top: documentOriginY, width: document.width * zoom, height: document.height * zoom }} />
    <div className="scene3d-rotation-track scene3d-rotation-track--horizontal" style={{ left: tiltLeft, top: tiltTop, width: TRACK_LENGTH }}
      onPointerDown={(event) => beginDrag("tilt", false, event)} onPointerMove={onTrackPointerMove} onPointerUp={onTrackPointerUp} onPointerCancel={onTrackPointerUp}>
      <div className="scene3d-rotation-knob" style={{ left: tiltOffset }} title={`Tilt ${Math.round(liveGround.tiltX)}°`} />
    </div>
    <div className="scene3d-rotation-track scene3d-rotation-track--vertical" style={{ left: distanceLeft, top: distanceTop, height: TRACK_LENGTH }}
      onPointerDown={(event) => beginDrag("distance", true, event)} onPointerMove={onTrackPointerMove} onPointerUp={onTrackPointerUp} onPointerCancel={onTrackPointerUp}>
      <div className="scene3d-rotation-knob" style={{ top: distanceOffset }} title={`Distance ${Math.round(liveGround.distance)}`} />
    </div>
  </>;
}
