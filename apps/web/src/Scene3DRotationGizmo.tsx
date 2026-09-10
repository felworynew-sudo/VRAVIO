import { useEffect, useRef, useState } from "react";
import type { RasterDocumentState, RasterLayer } from "@vravio/env-raster";
import { beginLiveScene3D, rotationFromTrackOffset, trackOffsetFromRotation, type LiveScene3DSession } from "./scene3d-live";
import { updateScene3DLayer } from "./scene3d-commands";

/**
 * On-canvas rotation handles for a persistent 3D layer — the owner's own
 * request and sketch: a horizontal track under the layer's regular transform
 * frame for left-right (yaw / rotationY), a vertical one beside it for
 * up-down tilt (pitch / rotationX). Roll (rotationZ) and scale are left to
 * the Move tool's own existing corner handles, which already double for
 * them on a baked layer — this only adds the two axes a 2D drag has no
 * natural equivalent for.
 *
 * The live preview during a drag goes through `scene3d-live.ts`'s
 * persistent session (build the mesh once, re-render every frame, never
 * re-bake) rather than calling `updateScene3DLayer` per pointer sample —
 * that per-frame commit-and-rebake is what the Properties panel's own
 * sliders still do (DockLayout.tsx's `Scene3DProperties`), and it is
 * exactly the "жёсткий затуп" pattern already fixed once this session for
 * the adjustment dialog, reproduced here on a 3D re-render instead of a
 * flat composite. `updateScene3DLayer` — the single non-destructive edit
 * door every other 3D control already goes through — is only called once,
 * on release.
 *
 * Drag arithmetic runs entirely in *client* coordinates (`event.clientX/Y`
 * against the track element's own `getBoundingClientRect()`), not
 * `documentOriginX/Y` — those are workspace-local (`RasterWorkspace.tsx`'s
 * own pan/zoom bookkeeping), and mixing the two spaces would put the knob
 * somewhere other than the pointer. `documentOriginX/Y` is only used below
 * to *place* the track divs on screen, never to interpret a pointer event.
 */

const TRACK_MARGIN = 18;
const MIN_TRACK_LENGTH = 96;
const MAX_TRACK_LENGTH = 260;

interface DragState {
  readonly axis: "yaw" | "pitch";
  readonly pointerId: number;
  readonly trackStart: number;
  readonly trackLength: number;
  readonly vertical: boolean;
  rotationX: number;
  rotationY: number;
  session: LiveScene3DSession | null;
  /** Set while `beginLiveScene3D` is still resolving, so whatever the
   * fastest early frames of a drag produced is not lost — applied the
   * instant the session becomes available instead of only reacting to
   * whatever move happens to arrive after that. */
  pendingRotation: { x: number; y: number } | null;
}

export function Scene3DRotationGizmo({
  documentId, document, layer, zoom, documentOriginX, documentOriginY,
}: {
  documentId: string;
  document: RasterDocumentState;
  layer: RasterLayer;
  zoom: number;
  documentOriginX: number;
  documentOriginY: number;
}) {
  const data = layer.scene3d!;
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  dragRef.current = drag;
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // The live canvas only exists in the DOM while a drag is in progress
  // (`drag` truthy) — mounting it is what makes `canvasRef.current` valid,
  // so the session has to start from an effect keyed on that transition,
  // not from the pointerdown handler itself.
  useEffect(() => {
    if (!drag || drag.session || !canvasRef.current) return;
    let cancelled = false;
    void beginLiveScene3D(canvasRef.current, data, document).then((session) => {
      if (cancelled) { session.dispose(); return; }
      const current = dragRef.current;
      if (!current) { session.dispose(); return; }
      const seed = current.pendingRotation;
      if (seed) session.setRotation(seed.x, seed.y, data.rotationZ);
      const next: DragState = { ...current, session, pendingRotation: null };
      dragRef.current = next;
      setDrag(next);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag?.pointerId]);

  const screenX = documentOriginX + layer.bounds.x * zoom;
  const screenY = documentOriginY + layer.bounds.y * zoom;
  const screenWidth = layer.bounds.width * zoom;
  const screenHeight = layer.bounds.height * zoom;
  const horizontalLength = Math.max(MIN_TRACK_LENGTH, Math.min(MAX_TRACK_LENGTH, screenWidth));
  const verticalLength = Math.max(MIN_TRACK_LENGTH, Math.min(MAX_TRACK_LENGTH, screenHeight));
  const horizontalLeft = screenX + screenWidth / 2 - horizontalLength / 2;
  const horizontalTop = screenY + screenHeight + TRACK_MARGIN;
  const verticalLeft = screenX + screenWidth + TRACK_MARGIN;
  const verticalTop = screenY + screenHeight / 2 - verticalLength / 2;

  const liveRotationX = drag?.axis === "pitch" ? drag.rotationX : data.rotationX;
  const liveRotationY = drag?.axis === "yaw" ? drag.rotationY : data.rotationY;
  const yawOffset = trackOffsetFromRotation(liveRotationY, horizontalLength);
  const pitchOffset = trackOffsetFromRotation(liveRotationX, verticalLength);

  const beginDrag = (axis: "yaw" | "pitch", vertical: boolean, event: React.PointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const trackStart = vertical ? rect.top : rect.left;
    const trackLength = vertical ? rect.height : rect.width;
    event.currentTarget.setPointerCapture(event.pointerId);
    const offset = (vertical ? event.clientY : event.clientX) - trackStart;
    const rotation = rotationFromTrackOffset(offset, trackLength);
    const rotationX = axis === "pitch" ? rotation : data.rotationX;
    const rotationY = axis === "yaw" ? rotation : data.rotationY;
    const next: DragState = { axis, pointerId: event.pointerId, trackStart, trackLength, vertical, rotationX, rotationY, session: null, pendingRotation: { x: rotationX, y: rotationY } };
    dragRef.current = next;
    setDrag(next);
  };

  const onTrackPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const current = dragRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const offset = (current.vertical ? event.clientY : event.clientX) - current.trackStart;
    const rotation = rotationFromTrackOffset(offset, current.trackLength);
    const rotationX = current.axis === "pitch" ? rotation : current.rotationX;
    const rotationY = current.axis === "yaw" ? rotation : current.rotationY;
    const next: DragState = { ...current, rotationX, rotationY, pendingRotation: current.session ? null : { x: rotationX, y: rotationY } };
    dragRef.current = next;
    setDrag(next);
    current.session?.setRotation(rotationX, rotationY, data.rotationZ);
  };

  const onTrackPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const current = dragRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    current.session?.dispose();
    dragRef.current = null;
    setDrag(null);
    void updateScene3DLayer(documentId, layer.id, { rotationX: current.rotationX, rotationY: current.rotationY });
  };

  return <>
    {drag && <canvas ref={canvasRef} className="scene3d-live-canvas" width={document.width} height={document.height} style={{ left: documentOriginX, top: documentOriginY, width: document.width * zoom, height: document.height * zoom }} />}
    <div className="scene3d-rotation-track scene3d-rotation-track--horizontal" style={{ left: horizontalLeft, top: horizontalTop, width: horizontalLength }}
      onPointerDown={(event) => beginDrag("yaw", false, event)} onPointerMove={onTrackPointerMove} onPointerUp={onTrackPointerUp} onPointerCancel={onTrackPointerUp}>
      <div className="scene3d-rotation-knob" style={{ left: yawOffset }} title={`${Math.round(liveRotationY)}°`} />
    </div>
    <div className="scene3d-rotation-track scene3d-rotation-track--vertical" style={{ left: verticalLeft, top: verticalTop, height: verticalLength }}
      onPointerDown={(event) => beginDrag("pitch", true, event)} onPointerMove={onTrackPointerMove} onPointerUp={onTrackPointerUp} onPointerCancel={onTrackPointerUp}>
      <div className="scene3d-rotation-knob" style={{ top: pitchOffset }} title={`${Math.round(liveRotationX)}°`} />
    </div>
  </>;
}
