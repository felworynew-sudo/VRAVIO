import { useEffect, useRef, useState, type CSSProperties, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { addShape, createImageShape, createShape, duplicateShape, isVectorDocumentState, moveShapeInStack, pathData, removeShapes, shapeAt, shapeBounds, translateShape, updateShape, type VectorDocumentState, type VectorPoint, type VectorShape, type VectorShapeKind } from "@vravio/env-vector";
import { RASTER_ASSET_MIME, decodeRasterAsset, encodeRasterAsset } from "@vravio/env-raster";
import type { AssetId, VravioDocument } from "@vravio/kernel";
import { kernel } from "./kernel";
import { changeVectorDocument, commitVectorDrag, snapshotVector, type VectorSnapshot } from "./vector-commands";
import { defaultViewport, useShellStore } from "./store";
import { useContextMenu } from "./ContextMenu";
import { text } from "./i18n";

function clampZoom(zoom: number): number {
  return Math.max(0.01, Math.min(64, zoom));
}

/** Screen-space pointer coordinates into document space, undoing the stage's pan/zoom/rotate transform — the same math RasterWorkspace uses for its own canvas. */
function toDocumentPoint(event: { clientX: number; clientY: number }, workspace: HTMLElement, viewport: { panX: number; panY: number; zoom: number; rotation: number }, width: number, height: number) {
  const rect = workspace.getBoundingClientRect();
  const dx = event.clientX - rect.left - rect.width / 2 - viewport.panX;
  const dy = event.clientY - rect.top - rect.height / 2 - viewport.panY;
  const radians = -viewport.rotation * Math.PI / 180, cosine = Math.cos(radians), sine = Math.sin(radians);
  return { x: (cosine * dx - sine * dy) / viewport.zoom + width / 2, y: (sine * dx + cosine * dy) / viewport.zoom + height / 2 };
}

const shapeToolKinds: Partial<Record<string, VectorShapeKind>> = { "vector.rectangle": "rectangle", "vector.ellipse": "ellipse", "vector.text": "text" };

type NodePart = "anchor" | "handleIn" | "handleOut";

/** Absolute position of a point's anchor or one of its (offset-stored) handles. */
function nodePosition(point: VectorPoint, part: NodePart): { x: number; y: number } {
  if (part === "anchor") return { x: point.x, y: point.y };
  const handle = point[part];
  return handle ? { x: point.x + handle.x, y: point.y + handle.y } : { x: point.x, y: point.y };
}

/** Finds the closest anchor/handle of a path within `tolerance` document units of `at`, preferring handles (they sit on top visually) over anchors when both are in range. */
function hitTestNode(shape: VectorShape, at: { x: number; y: number }, tolerance: number): { pointIndex: number; part: NodePart } | null {
  if (shape.kind !== "path") return null;
  type Best = { pointIndex: number; part: NodePart; distance: number };
  let best: Best | null = null;
  shape.points.forEach((point, pointIndex) => {
    (["handleOut", "handleIn", "anchor"] as const).forEach((part) => {
      if (part !== "anchor" && !point[part]) return;
      const position = nodePosition(point, part);
      const distance = Math.hypot(position.x - at.x, position.y - at.y);
      if (distance <= tolerance && (!best || distance < (best as Best).distance)) best = { pointIndex, part, distance };
    });
  });
  return best ? { pointIndex: (best as Best).pointIndex, part: (best as Best).part } : null;
}


/** Resolves an asset's pixels to a `<image>`-ready data URL, refetching whenever `rev` changes —
 * the caller reads the asset's current head at render time and passes it in, so a revision that
 * arrives from another tab (round-trip apply) or from undo naturally invalidates the cache
 * instead of this hook having to subscribe to the asset store itself. */
function useAssetBitmapUrl(assetId: string, rev: number): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    void (async () => {
      const bytes = await kernel.assets.read(assetId as AssetId, rev).catch(() => null);
      if (!bytes || cancelled) return;
      const image = decodeRasterAsset(bytes);
      const canvas = window.document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d");
      if (!context) return;
      context.putImageData(new ImageData(new Uint8ClampedArray(image.pixels), image.width, image.height), 0, 0);
      if (!cancelled) setUrl(canvas.toDataURL());
    })();
    return () => { cancelled = true; };
  }, [assetId, rev]);
  return url;
}

function VectorImageShape({ shape }: { shape: Extract<VectorShape, { kind: "image" }> }) {
  const rev = kernel.assets.get(shape.pixelAssetId as AssetId)?.head ?? 0;
  const url = useAssetBitmapUrl(shape.pixelAssetId, rev);
  const transform = shape.rotation ? `rotate(${shape.rotation} ${shape.x + shape.width / 2} ${shape.y + shape.height / 2})` : undefined;
  if (!url) return <rect key={shape.id} x={shape.x} y={shape.y} width={shape.width} height={shape.height} opacity={shape.style.opacity} className="vector-image-placeholder" transform={transform}/>;
  return <image key={shape.id} href={url} x={shape.x} y={shape.y} width={shape.width} height={shape.height} opacity={shape.style.opacity} preserveAspectRatio="none" transform={transform}/>;
}

function renderShape(shape: VectorShape) {
  if (!shape.visible) return null;
  if (shape.kind === "image") return <VectorImageShape key={shape.id} shape={shape}/>;
  const fill = shape.style.fill ?? "none", stroke = shape.style.stroke ?? "none";
  const common = { fill, stroke, strokeWidth: shape.style.strokeWidth, opacity: shape.style.opacity };
  if (shape.kind === "rectangle") return <rect key={shape.id} {...common} x={shape.x} y={shape.y} width={shape.width} height={shape.height} rx={shape.cornerRadius} transform={shape.rotation ? `rotate(${shape.rotation} ${shape.x + shape.width / 2} ${shape.y + shape.height / 2})` : undefined}/>;
  if (shape.kind === "ellipse") return <ellipse key={shape.id} {...common} cx={shape.x + shape.width / 2} cy={shape.y + shape.height / 2} rx={shape.width / 2} ry={shape.height / 2} transform={shape.rotation ? `rotate(${shape.rotation} ${shape.x + shape.width / 2} ${shape.y + shape.height / 2})` : undefined}/>;
  if (shape.kind === "line") return <line key={shape.id} {...common} x1={shape.x1} y1={shape.y1} x2={shape.x2} y2={shape.y2}/>;
  if (shape.kind === "text") return <text key={shape.id} {...common} x={shape.x} y={shape.y} fontSize={shape.fontSize} fontFamily={shape.fontFamily} textAnchor={shape.align === "center" ? "middle" : shape.align === "right" ? "end" : "start"} stroke="none">{shape.value}</text>;
  return <path key={shape.id} {...common} d={pathData(shape.points, shape.closed)}/>;
}

export function VectorWorkspace({ document }: { document: VravioDocument }) {
  const state = document.state;
  if (!isVectorDocumentState(state)) return null;
  const store = useShellStore();
  const activeToolId = useShellStore((shell) => shell.activeToolByDocument[document.id]);
  const foregroundColor = useShellStore((shell) => shell.foregroundColor);
  const viewport = useShellStore((shell) => shell.viewports[document.id] ?? defaultViewport);
  const setViewport = store.setViewport;
  const workspaceRef = useRef<HTMLDivElement>(null);
  const draft = useRef<{ tool: string; shapeId: string; start: { x: number; y: number }; before: VectorSnapshot } | null>(null);
  const pathDraft = useRef<{ id: string; before: VectorSnapshot } | null>(null);
  /** While set, pointer movement pulls a symmetric bezier handle out of the point just placed — Illustrator's click-drag-to-curve. Cleared on pointer-up; the point stays a plain corner if the pointer never moved far enough to count as a drag. */
  const penHandle = useRef<{ shapeId: string; pointIndex: number; anchor: { x: number; y: number } } | null>(null);
  const contextMenu = useContextMenu();
  /** Node tool: which anchor/handle is being dragged, and the snapshot to diff against at commit. */
  const nodeDrag = useRef<{ shapeId: string; pointIndex: number; part: NodePart; before: VectorSnapshot } | null>(null);
  const [selectedNode, setSelectedNode] = useState<{ shapeId: string; pointIndex: number } | null>(null);

  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace || viewport.mode !== "fit") return;
    const fit = () => {
      const rect = workspace.getBoundingClientRect();
      const zoom = clampZoom(Math.min(Math.max(1, rect.width - 80) / state.width, Math.max(1, rect.height - 80) / state.height));
      const current = useShellStore.getState().viewports[document.id] ?? defaultViewport;
      if (Math.abs(current.zoom - zoom) > 0.0001 || current.panX !== 0 || current.panY !== 0) setViewport(document.id, { zoom, panX: 0, panY: 0 });
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(workspace);
    return () => observer.disconnect();
  }, [document.id, setViewport, state.width, state.height, viewport.mode]);

  // Delete/Backspace/Escape are handled locally rather than through kernel.commands: they act
  // on "the selected shape in this workspace", which has no meaning outside it, unlike a
  // document-level action such as Undo. Escape also has to cancel an in-progress path, a piece
  // of state kernel.commands has no way to reach.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (useShellStore.getState().activeDocumentId !== document.id) return;
      const target = event.target as HTMLElement | null;
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable) return;
      const current = kernel.documents.get<VectorDocumentState>(document.id); if (!current) return;
      if ((event.key === "Delete" || event.key === "Backspace") && activeToolId === "vector.nodes" && selectedNode) {
        event.preventDefault();
        const { shapeId, pointIndex } = selectedNode;
        setSelectedNode(null);
        void changeVectorDocument(document.id, "Delete Point (Удалить точку)", (draftState) => {
          const shape = draftState.shapes.find((item) => item.id === shapeId);
          if (shape?.kind !== "path" || shape.points.length <= 2) return false;
          shape.points = shape.points.filter((_, index) => index !== pointIndex);
          return true;
        });
      } else if ((event.key === "Delete" || event.key === "Backspace") && current.state.selection.length) {
        event.preventDefault();
        const ids = current.state.selection;
        void changeVectorDocument(document.id, "Delete Shape (Удалить фигуру)", (draftState) => { removeShapes(draftState, ids); return true; });
      } else if (event.key === "Escape" && pathDraft.current) {
        // Cancels the whole in-progress path rather than just the last point — its points were
        // written live with no history steps of their own, so there is nothing to step back
        // through; only the snapshot from before the first click can restore the prior state.
        const before = pathDraft.current.before;
        pathDraft.current = null;
        kernel.documents.update<VectorDocumentState>(document.id, (draftState) => { draftState.shapes = structuredClone(before.shapes); draftState.activeShapeId = before.activeShapeId; draftState.selection = before.selection; });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [document.id, activeToolId, selectedNode]);

  const style = (): { fill: string | null; stroke: string | null; strokeWidth: number; opacity: number } => ({ fill: foregroundColor, stroke: null, strokeWidth: 2, opacity: 1 });

  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return; // right-click opens the context menu instead, left-click only draws
    const workspace = workspaceRef.current; if (!workspace) return;
    const point = toDocumentPoint(event, workspace, viewport, state.width, state.height);
    const kind = shapeToolKinds[activeToolId ?? ""];

    if (activeToolId === "vector.pen") {
      event.preventDefault();
      if (pathDraft.current) {
        const shapeId = pathDraft.current.id;
        let pointIndex = -1;
        kernel.documents.update<VectorDocumentState>(document.id, (draftState) => { const shape = draftState.shapes.find((item) => item.id === shapeId); if (shape?.kind === "path") { shape.points = [...shape.points, { x: point.x, y: point.y }]; pointIndex = shape.points.length - 1; } });
        if (pointIndex >= 0) penHandle.current = { shapeId, pointIndex, anchor: point };
        if (event.detail >= 2) { const finished = pathDraft.current; pathDraft.current = null; penHandle.current = null; commitVectorDrag(document.id, "New Path (Новый контур)", finished.before); }
      } else {
        const before = snapshotVector(state);
        const shape = createShape("path", point.x, point.y, style());
        pathDraft.current = { id: shape.id, before };
        penHandle.current = { shapeId: shape.id, pointIndex: 0, anchor: point };
        kernel.documents.update<VectorDocumentState>(document.id, (draftState) => addShape(draftState, shape));
      }
      return;
    }

    if (kind) {
      event.preventDefault();
      const before = snapshotVector(state);
      const shape = createShape(kind, point.x, point.y, style());
      draft.current = { tool: activeToolId!, shapeId: shape.id, start: point, before };
      kernel.documents.update<VectorDocumentState>(document.id, (draftState) => addShape(draftState, shape));
      if (kind === "text") { draft.current = null; commitVectorDrag(document.id, "New Text (Новый текст)", before); }
      return;
    }

    if (activeToolId === "vector.nodes") {
      const activeShape = state.shapes.find((shape) => shape.id === state.activeShapeId) ?? null;
      const tolerance = 6 / viewport.zoom;
      const node = activeShape ? hitTestNode(activeShape, point, tolerance) : null;
      if (node && activeShape) {
        event.preventDefault();
        setSelectedNode({ shapeId: activeShape.id, pointIndex: node.pointIndex });
        nodeDrag.current = { shapeId: activeShape.id, pointIndex: node.pointIndex, part: node.part, before: snapshotVector(state) };
        return;
      }
      setSelectedNode(null);
      // Fall through to the select-tool behavior below: pick a shape to make active, or deselect.
    }

    // Select tool: pick the topmost shape under the pointer and start a move-drag; clicking
    // empty space deselects without a history step, matching how a raster marquee click doesn't
    // push an undo entry.
    const hit = shapeAt(state, point.x, point.y);
    if (hit) { draft.current = { tool: "move", shapeId: hit.id, start: point, before: snapshotVector(state) }; kernel.documents.update<VectorDocumentState>(document.id, (draftState) => { draftState.activeShapeId = hit.id; draftState.selection = [hit.id]; }); }
    else { draft.current = null; kernel.documents.update<VectorDocumentState>(document.id, (draftState) => { draftState.activeShapeId = null; draftState.selection = []; }); }
  };

  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (nodeDrag.current) {
      const workspace = workspaceRef.current; if (!workspace) return;
      const point = toDocumentPoint(event, workspace, viewport, state.width, state.height);
      const { shapeId, pointIndex, part } = nodeDrag.current;
      kernel.documents.update<VectorDocumentState>(document.id, (draftState) => {
        const shape = draftState.shapes.find((item) => item.id === shapeId);
        if (shape?.kind !== "path" || !shape.points[pointIndex]) return;
        shape.points = shape.points.map((current, index) => {
          if (index !== pointIndex) return current;
          if (part === "anchor") return { ...current, x: point.x, y: point.y };
          const offset = { x: point.x - current.x, y: point.y - current.y };
          const mirror = !event.altKey;
          const opposite: NodePart = part === "handleOut" ? "handleIn" : "handleOut";
          return { ...current, [part]: offset, ...(mirror ? { [opposite]: { x: -offset.x, y: -offset.y } } : {}) };
        });
      });
      return;
    }
    if (penHandle.current) {
      const workspace = workspaceRef.current; if (!workspace) return;
      const point = toDocumentPoint(event, workspace, viewport, state.width, state.height);
      const { shapeId, pointIndex, anchor } = penHandle.current;
      const dx = point.x - anchor.x, dy = point.y - anchor.y;
      // Below this, a click reads as a corner point, not an accidental one-pixel drag.
      if (Math.hypot(dx, dy) < 1) return;
      kernel.documents.update<VectorDocumentState>(document.id, (draftState) => {
        const shape = draftState.shapes.find((item) => item.id === shapeId);
        if (shape?.kind === "path" && shape.points[pointIndex]) shape.points = shape.points.map((current, index) => index === pointIndex ? { ...current, handleOut: { x: dx, y: dy }, handleIn: { x: -dx, y: -dy } } : current);
      });
      return;
    }
    if (!draft.current) return;
    const workspace = workspaceRef.current; if (!workspace) return;
    const point = toDocumentPoint(event, workspace, viewport, state.width, state.height);
    const { tool, shapeId, start } = draft.current;
    if (tool === "move") { const dx = point.x - start.x, dy = point.y - start.y; draft.current.start = point; kernel.documents.update<VectorDocumentState>(document.id, (draftState) => translateShape(draftState, shapeId, dx, dy)); return; }
    if (shapeToolKinds[tool]) {
      const x = Math.min(start.x, point.x), y = Math.min(start.y, point.y), width = Math.abs(point.x - start.x), height = Math.abs(point.y - start.y);
      kernel.documents.update<VectorDocumentState>(document.id, (draftState) => updateShape(draftState, shapeId, { x, y, width: Math.max(1, width), height: Math.max(1, height) }));
    }
  };

  const onPointerUp = () => {
    if (nodeDrag.current) { const { before } = nodeDrag.current; nodeDrag.current = null; commitVectorDrag(document.id, "Edit Path (Изменить контур)", before); return; }
    if (penHandle.current) { penHandle.current = null; return; }
    if (!draft.current) return;
    const { tool, before } = draft.current;
    draft.current = null;
    const label = tool === "move" ? "Move Shape (Переместить фигуру)" : "New Shape (Новая фигура)";
    commitVectorDrag(document.id, label, before);
  };

  // The pen tool's own right-click menu — Photoshop's, adapted: while a path is in
  // progress, "finish" commits it open, "close" joins the last point back to the first,
  // "delete last point" backs out one click without touching the rest, and "delete path"
  // discards the whole thing and restores exactly what was on the canvas before it started.
  const finishPath = () => { const drawing = pathDraft.current; if (!drawing) return; pathDraft.current = null; commitVectorDrag(document.id, "New Path (Новый контур)", drawing.before); };
  const closePath = () => { const drawing = pathDraft.current; if (!drawing) return; kernel.documents.update<VectorDocumentState>(document.id, (draftState) => { const shape = draftState.shapes.find((item) => item.id === drawing.id); if (shape?.kind === "path") shape.closed = true; }); finishPath(); };
  const deleteLastPoint = () => { const drawing = pathDraft.current; if (!drawing) return; kernel.documents.update<VectorDocumentState>(document.id, (draftState) => { const shape = draftState.shapes.find((item) => item.id === drawing.id); if (shape?.kind === "path" && shape.points.length > 1) shape.points = shape.points.slice(0, -1); }); };
  const deletePath = () => { const drawing = pathDraft.current; if (!drawing) return; pathDraft.current = null; kernel.documents.update<VectorDocumentState>(document.id, (draftState) => { draftState.shapes = structuredClone(drawing.before.shapes); draftState.activeShapeId = drawing.before.activeShapeId; draftState.selection = drawing.before.selection; }); };
  const onCanvasContextMenu = (event: ReactMouseEvent<SVGSVGElement>) => {
    if (activeToolId === "vector.pen" && pathDraft.current) {
      contextMenu.open(event, [
        { label: text(store.language, "Finish Path", "Завершить контур"), onSelect: finishPath },
        { label: text(store.language, "Close Path", "Закрыть контур"), onSelect: closePath },
        { label: text(store.language, "Delete Last Point", "Удалить последнюю точку"), onSelect: deleteLastPoint },
        { label: text(store.language, "Delete Path", "Удалить контур"), onSelect: deletePath, danger: true, separatorBefore: true },
      ]);
      return;
    }
    const workspace = workspaceRef.current;
    const point = workspace ? toDocumentPoint(event, workspace, viewport, state.width, state.height) : null;
    const hit = point ? shapeAt(state, point.x, point.y) : null;
    if (hit?.kind === "image") {
      kernel.documents.update<VectorDocumentState>(document.id, (draftState) => { draftState.activeShapeId = hit.id; draftState.selection = [hit.id]; });
      contextMenu.open(event, [
        { label: text(store.language, "Edit Image in Raster Environment", "Открыть картинку в растровой среде"), onSelect: () => void kernel.commands.execute("image.openElsewhere", { activeDocumentId: document.id }) },
        { label: text(store.language, "Edit Image as a Copy", "Открыть картинку копией"), onSelect: () => void kernel.commands.execute("image.openElsewhereBranch", { activeDocumentId: document.id }) },
        { label: text(store.language, "Delete Image", "Удалить картинку"), onSelect: () => void changeVectorDocument(document.id, "Delete Shape (Удалить фигуру)", (draftState) => { removeShapes(draftState, [hit.id]); return true; }), danger: true, separatorBefore: true },
      ]);
      return;
    }
    event.preventDefault();
  };

  const active = state.shapes.find((shape) => shape.id === state.activeShapeId) ?? null;
  const bounds = active ? shapeBounds(active) : null;
  const stageStyle = { width: state.width, height: state.height, transform: `translate(-50%, -50%) translate(${viewport.panX}px, ${viewport.panY}px) rotate(${viewport.rotation}deg) scale(${viewport.zoom})` } as CSSProperties;

  const handleWheel = (event: React.WheelEvent) => {
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      const zoom = clampZoom(viewport.zoom * Math.exp(-event.deltaY * 0.002));
      setViewport(document.id, { zoom, mode: "custom" });
    } else setViewport(document.id, { panX: viewport.panX - event.deltaX, panY: viewport.panY - event.deltaY, mode: "custom" });
  };

  /** Decodes a dropped image file into an asset and places it as a new image shape, at up to
   * the document's own size — the same "picture, not a copy" reference an extracted asset gets,
   * so this placed picture is round-trip-editable in the raster environment from the moment it
   * lands, with no separate "convert to smart object" step. */
  const importImageFile = async (file: File, at: { x: number; y: number }): Promise<void> => {
    const bitmap = await createImageBitmap(file);
    const canvas = window.document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) { bitmap.close(); return; }
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data as unknown as Uint8ClampedArray;
    const bytes = encodeRasterAsset(pixels, canvas.width, canvas.height);
    const assetId = await kernel.assets.importAsset(bytes, { kind: "image", mime: RASTER_ASSET_MIME, name: file.name, producedBy: "vector-env" });
    const scale = Math.min(1, state.width / canvas.width, state.height / canvas.height);
    const width = canvas.width * scale, height = canvas.height * scale;
    const shape = createImageShape(at.x - width / 2, at.y - height / 2, width, height, assetId, file.name.replace(/\.[a-z0-9]+$/i, ""));
    await changeVectorDocument(document.id, "Place Image (Поместить изображение)", (draftState) => { addShape(draftState, shape); return true; });
    kernel.documents.addAssetRef(document.id, assetId);
  };

  const onDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const files = [...(event.dataTransfer?.files ?? [])].filter((file) => file.type.startsWith("image/"));
    if (!files.length) return;
    const workspace = workspaceRef.current; if (!workspace) return;
    const dropPoint = toDocumentPoint(event, workspace, viewport, state.width, state.height);
    files.forEach((file, index) => void importImageFile(file, { x: dropPoint.x + index * 32, y: dropPoint.y + index * 32 }));
  };

  return <div ref={workspaceRef} className="vector-workspace" data-active-tool={activeToolId} onWheel={handleWheel} onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
    <div className="vector-stage" style={stageStyle}>
      <svg width={state.width} height={state.height} viewBox={`0 0 ${state.width} ${state.height}`} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerLeave={onPointerUp} onContextMenu={onCanvasContextMenu}>
        {state.shapes.map(renderShape)}
        {bounds && <rect className="vector-selection" x={bounds.x} y={bounds.y} width={bounds.width} height={bounds.height} vectorEffect="non-scaling-stroke"/>}
        {bounds && [[bounds.x, bounds.y], [bounds.x + bounds.width, bounds.y], [bounds.x, bounds.y + bounds.height], [bounds.x + bounds.width, bounds.y + bounds.height]].map(([x, y]) => <circle className="vector-handle" key={`${x}-${y}`} cx={x} cy={y} r={5 / viewport.zoom} vectorEffect="non-scaling-stroke"/>)}
        {activeToolId === "vector.nodes" && active?.kind === "path" && active.points.map((point, pointIndex) => {
          const isSelected = selectedNode?.shapeId === active.id && selectedNode.pointIndex === pointIndex;
          return <g key={pointIndex}>
            {point.handleOut && <line className="vector-node-handle-line" x1={point.x} y1={point.y} x2={point.x + point.handleOut.x} y2={point.y + point.handleOut.y} vectorEffect="non-scaling-stroke"/>}
            {point.handleIn && <line className="vector-node-handle-line" x1={point.x} y1={point.y} x2={point.x + point.handleIn.x} y2={point.y + point.handleIn.y} vectorEffect="non-scaling-stroke"/>}
            {point.handleOut && <circle className="vector-node-handle" cx={point.x + point.handleOut.x} cy={point.y + point.handleOut.y} r={3.5 / viewport.zoom} vectorEffect="non-scaling-stroke"/>}
            {point.handleIn && <circle className="vector-node-handle" cx={point.x + point.handleIn.x} cy={point.y + point.handleIn.y} r={3.5 / viewport.zoom} vectorEffect="non-scaling-stroke"/>}
            <rect className={isSelected ? "vector-node-anchor selected" : "vector-node-anchor"} x={point.x - 4 / viewport.zoom} y={point.y - 4 / viewport.zoom} width={8 / viewport.zoom} height={8 / viewport.zoom} vectorEffect="non-scaling-stroke"/>
          </g>;
        })}
      </svg>
    </div>
    {contextMenu.node}
  </div>;
}
