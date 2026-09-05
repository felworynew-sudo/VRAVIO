import { useEffect, useRef, useState, type CSSProperties, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { addShape, createImageShape, isIdentityMatrix, isVectorDocumentState, matrixToCss, pathData, removeShapes, shapeAt, shapeWorldBounds, siblingsOf, type VectorDocumentState, type VectorShape } from "@vravio/env-vector";
import { RASTER_ASSET_MIME, decodeRasterAsset, encodeRasterAsset } from "@vravio/env-raster";
import { colorToCss } from "@vravio/kernel";
import type { AssetId, VravioDocument } from "@vravio/kernel";
import { kernel } from "./kernel";
import { changeVectorDocument, commitVectorDrag, snapshotVector } from "./vector-commands";
import { defaultViewport, useShellStore } from "./store";
import { useContextMenu } from "./ContextMenu";
import { text } from "./i18n";
import { vectorToolById } from "./environments/vector/tools/registry";
import { closePath, deleteLastPoint, deletePath, finishPath, hasDraft, type PenState } from "./environments/vector/tools/definitions/pen";
import type { ToolContext, ToolPointer } from "./environments/vector/tools/types";

/**
 * Stage 5 of docs/migration-plan.md: the vector counterpart of
 * `RasterWorkspace.tsx`'s tool-catalogue bridge. Unlike raster's staged
 * rollout (a bridge alongside a shrinking `switch`, one tool moved per
 * session across many), all six vector tools move over in this single
 * change and the pre-port pointer-handling logic (the `draft`/`pathDraft`/
 * `penHandle`/`nodeDrag` refs and the `selectedNode` state, `hitTestNode`,
 * `shapeToolKinds`, `style()`) is deleted in the same pass — there is no
 * partial state worth preserving between sessions for six tools sharing one
 * `<svg>` gesture, the way there was for thirty sharing a canvas.
 *
 * What stays host-level, and why, mirrors the precedents raster's own port
 * already set:
 * - The generic selection outline/handles (shown for the active shape
 *   regardless of which tool is active) and the pen/image right-click
 *   menus have no pointer gesture of their own to hang a hook off — the
 *   same category raster.move's Skew/Distort/Perspective/Warp menu and the
 *   marquee family's Replace/Add/Subtract/Intersect menu are in.
 * - Delete/Backspace deleting the *shape* selection is chrome that works
 *   under any tool, not a behaviour any one tool owns (vector.nodes' own
 *   Delete/Backspace, for the selected *point*, moved into its own
 *   `Overlay` — see nodes.tsx).
 * - The viewport fit effect, wheel-to-zoom/pan and image drag-and-drop
 *   import are canvas chrome independent of the active tool, the same as
 *   pan/zoom/rotate are for raster.
 */

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

/** `undefined` rather than the identity matrix's own string so an untransformed
 * shape (every shape a v2 document ever had, and most new ones) renders with
 * no `transform` attribute at all — cheaper for the browser and, more
 * importantly, what the DOM already looked like before this stage, so a
 * document with no groups and no rotation is pixel-identical to before. */
const shapeTransform = (shape: VectorShape): string | undefined => isIdentityMatrix(shape.transform) ? undefined : matrixToCss(shape.transform);

function VectorImageShape({ shape }: { shape: Extract<VectorShape, { kind: "image" }> }) {
  const rev = kernel.assets.get(shape.pixelAssetId as AssetId)?.head ?? 0;
  const url = useAssetBitmapUrl(shape.pixelAssetId, rev);
  const transform = shapeTransform(shape);
  if (!url) return <rect key={shape.id} x={shape.x} y={shape.y} width={shape.width} height={shape.height} opacity={shape.style.opacity} className="vector-image-placeholder" transform={transform}/>;
  return <image key={shape.id} href={url} x={shape.x} y={shape.y} width={shape.width} height={shape.height} opacity={shape.style.opacity} preserveAspectRatio="none" transform={transform}/>;
}

function renderShape(shape: VectorShape): ReactNode {
  if (!shape.visible) return null;
  if (shape.kind === "image") return <VectorImageShape key={shape.id} shape={shape}/>;
  if (shape.kind === "group") return null; // a group has no visual of its own — see renderShapeTree, which wraps its children in a transformed <g> instead of calling this
  const fill = shape.style.fill ? colorToCss(shape.style.fill) : "none", stroke = shape.style.stroke ? colorToCss(shape.style.stroke) : "none";
  const common = { fill, stroke, strokeWidth: shape.style.strokeWidth, opacity: shape.style.opacity, transform: shapeTransform(shape) };
  if (shape.kind === "rectangle") return <rect key={shape.id} {...common} x={shape.x} y={shape.y} width={shape.width} height={shape.height} rx={shape.cornerRadius}/>;
  if (shape.kind === "ellipse") return <ellipse key={shape.id} {...common} cx={shape.x + shape.width / 2} cy={shape.y + shape.height / 2} rx={shape.width / 2} ry={shape.height / 2}/>;
  if (shape.kind === "line") return <line key={shape.id} {...common} x1={shape.x1} y1={shape.y1} x2={shape.x2} y2={shape.y2}/>;
  if (shape.kind === "text") return <text key={shape.id} {...common} x={shape.x} y={shape.y} fontSize={shape.fontSize} fontFamily={shape.fontFamily} textAnchor={shape.align === "center" ? "middle" : shape.align === "right" ? "end" : "start"} stroke="none">{shape.value}</text>;
  return <path key={shape.id} {...common} d={pathData(shape.points, shape.closed)}/>;
}

/**
 * Walks the shape tree in paint order, wrapping each group in a `<g
 * transform>` around its own children — nested groups nest `<g>`s the same
 * way, and the browser composes the transforms for free, exactly the reason
 * `Matrix` was designed to hand straight to SVG (see matrix.ts's own doc
 * comment). This is the one place group nesting actually has to exist in the
 * render tree; `shapeAt`/`shapeWorldBounds` walk the flat `parentId` chain
 * instead because pointer math has no DOM to lean on.
 */
function renderShapeTree(shapes: readonly VectorShape[], parentId: string | null): ReactNode[] {
  return siblingsOf(shapes, parentId).map((shape) => {
    if (!shape.visible) return null;
    if (shape.kind === "group") return <g key={shape.id} transform={shapeTransform(shape)}>{renderShapeTree(shapes, shape.id)}</g>;
    return renderShape(shape);
  });
}

export function VectorWorkspace({ document }: { document: VravioDocument }) {
  const state = document.state;
  if (!isVectorDocumentState(state)) return null;
  const store = useShellStore();
  const activeToolId = useShellStore((shell) => shell.activeToolByDocument[document.id]);
  const foregroundColor = useShellStore((shell) => shell.foregroundColor);
  const toolOptions = useShellStore((shell) => shell.toolOptions);
  const viewport = useShellStore((shell) => shell.viewports[document.id] ?? defaultViewport);
  const setViewport = store.setViewport;
  const workspaceRef = useRef<HTMLDivElement>(null);
  const contextMenu = useContextMenu();

  // One state slot per tool id, held here rather than inside a tool — the
  // same reason raster's RasterWorkspace does: a tool file stays a plain
  // object with no hooks of its own, and switching tools cannot leave a
  // half-finished gesture running.
  const [toolStates, setToolStates] = useState<Record<string, unknown>>({});
  const toolStatesRef = useRef(toolStates);
  toolStatesRef.current = toolStates;

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

  const catalogueTool = activeToolId ? vectorToolById.get(activeToolId) : undefined;

  const toolContextFor = (toolId: string): ToolContext<unknown> => {
    const tool = vectorToolById.get(toolId);
    const current = toolStatesRef.current[toolId] ?? tool?.createState();
    return {
      documentId: document.id,
      document: state,
      viewport,
      options: (toolOptions[toolId] ?? {}) as Readonly<Record<string, string | number | boolean>>,
      activeShape: state.shapes.find((shape) => shape.id === state.activeShapeId) ?? null,
      selection: state.selection,
      foregroundColor,
      state: current,
      setState: (next) => {
        toolStatesRef.current = { ...toolStatesRef.current, [toolId]: next };
        setToolStates(toolStatesRef.current);
      },
      mutate: (fn) => kernel.documents.update<VectorDocumentState>(document.id, fn),
      snapshot: () => snapshotVector(state),
      commitDrag: (before, label) => commitVectorDrag(document.id, label, before),
      changeDocument: (label, mutateFn) => changeVectorDocument(document.id, label, mutateFn),
    };
  };

  // Tool state is kept per id and outlives a switch, so the tool being left
  // has to be told to let go of it — the same effect RasterWorkspace runs
  // for the same reason: without it, changing tool mid-press strands the
  // gesture (a pen path left dangling, a drag never committed).
  const previousToolRef = useRef(activeToolId);
  useEffect(() => {
    const previous = previousToolRef.current;
    previousToolRef.current = activeToolId;
    if (previous === activeToolId || !previous) return;
    const leaving = vectorToolById.get(previous);
    leaving?.onDeactivate?.(toolContextFor(previous));
  });

  // Delete/Backspace deletes the shape selection — chrome that works under
  // any tool, not owned by one (vector.nodes' own Delete/Backspace, for the
  // selected point, lives in its own Overlay and calls stopPropagation so
  // the two never both fire for the same keypress). Escape-cancels-the-
  // pen-path moved into pen.tsx's own Overlay for the same reason.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (useShellStore.getState().activeDocumentId !== document.id) return;
      const target = event.target as HTMLElement | null;
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable) return;
      const current = kernel.documents.get<VectorDocumentState>(document.id); if (!current) return;
      if ((event.key === "Delete" || event.key === "Backspace") && current.state.selection.length) {
        event.preventDefault();
        const ids = current.state.selection;
        void changeVectorDocument(document.id, "Delete Shape (Удалить фигуру)", (draftState) => { removeShapes(draftState, ids); return true; });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [document.id]);

  const toolPointerFrom = (event: ReactPointerEvent<SVGSVGElement>, point: { x: number; y: number }): ToolPointer => ({
    point, screenX: event.clientX, screenY: event.clientY, pointerId: event.pointerId,
    shiftKey: event.shiftKey, altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, button: event.button, detail: event.detail,
  });

  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button !== 0 || !catalogueTool) return; // right-click opens the context menu instead, left-click only draws
    const workspace = workspaceRef.current; if (!workspace) return;
    const point = toDocumentPoint(event, workspace, viewport, state.width, state.height);
    catalogueTool.onPointerDown?.(toolContextFor(catalogueTool.id), toolPointerFrom(event, point));
  };

  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!catalogueTool) return;
    const workspace = workspaceRef.current; if (!workspace) return;
    const point = toDocumentPoint(event, workspace, viewport, state.width, state.height);
    catalogueTool.onPointerMove?.(toolContextFor(catalogueTool.id), toolPointerFrom(event, point));
  };

  const onPointerUp = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!catalogueTool) return;
    const workspace = workspaceRef.current; if (!workspace) return;
    const point = toDocumentPoint(event, workspace, viewport, state.width, state.height);
    catalogueTool.onGestureEnd?.(toolContextFor(catalogueTool.id), toolPointerFrom(event, point));
  };

  // The pen tool's own right-click menu — Photoshop's, adapted: while a path is in
  // progress, "finish" commits it open, "close" joins the last point back to the first,
  // "delete last point" backs out one click without touching the rest, and "delete path"
  // discards the whole thing and restores exactly what was on the canvas before it started.
  // No pointer gesture of its own to hang a hook off, so it stays host-level and calls
  // straight into pen.tsx's exported functions — the same shape raster.move's own
  // right-click Skew/Distort/Perspective/Warp menu is in.
  const onCanvasContextMenu = (event: ReactMouseEvent<SVGSVGElement>) => {
    const penContext = toolContextFor("vector.pen") as ToolContext<PenState>;
    if (activeToolId === "vector.pen" && hasDraft(penContext)) {
      contextMenu.open(event, [
        { label: text(store.language, "Finish Path", "Завершить контур"), onSelect: () => finishPath(penContext) },
        { label: text(store.language, "Close Path", "Закрыть контур"), onSelect: () => closePath(penContext) },
        { label: text(store.language, "Delete Last Point", "Удалить последнюю точку"), onSelect: () => deleteLastPoint(penContext) },
        { label: text(store.language, "Delete Path", "Удалить контур"), onSelect: () => deletePath(penContext), danger: true, separatorBefore: true },
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
  // World bounds, not local: an active shape sitting inside a rotated group
  // needs its selection box drawn where it actually appears on screen, not
  // where it would sit if it had no parent.
  const bounds = active ? shapeWorldBounds(active, state.shapes) : null;
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
        {renderShapeTree(state.shapes, null)}
        {bounds && <rect className="vector-selection" x={bounds.x} y={bounds.y} width={bounds.width} height={bounds.height} vectorEffect="non-scaling-stroke"/>}
        {bounds && [[bounds.x, bounds.y], [bounds.x + bounds.width, bounds.y], [bounds.x, bounds.y + bounds.height], [bounds.x + bounds.width, bounds.y + bounds.height]].map(([x, y]) => <circle className="vector-handle" key={`${x}-${y}`} cx={x} cy={y} r={5 / viewport.zoom} vectorEffect="non-scaling-stroke"/>)}
        {catalogueTool?.Overlay && <catalogueTool.Overlay state={toolStates[catalogueTool.id] ?? catalogueTool.createState()} document={state} options={(toolOptions[catalogueTool.id] ?? {}) as Readonly<Record<string, string | number | boolean>>} context={toolContextFor(catalogueTool.id)}/>}
      </svg>
    </div>
    {contextMenu.node}
  </div>;
}
