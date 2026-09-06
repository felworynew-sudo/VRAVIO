import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { addShape, buildShapeSpatialIndex, createImageShape, isIdentityMatrix, isVectorDocumentState, matrixToCss, pathData, removeShapes, resolveAppearance, shapeAtIndexed, shapesInRect, shapeWorldBoundsIndexed, siblingsOf, snapSources, type GradientDef, type VectorDocumentState, type VectorShape } from "@vravio/env-vector";
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
import { vectorTextMeasurer } from "./vector-text-metrics";
import { useModifierResults } from "./vector-modifiers";

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

/**
 * The document-space rectangle the workspace's own pixel box currently
 * shows, for stage 12's viewport culling (docs/vector-plan.md) — same
 * transform `toDocumentPoint` undoes, but for the workspace's four corners
 * rather than a pointer event, and using the tracked `workspaceSize`
 * instead of a fresh `getBoundingClientRect()` (no DOM read needed: the
 * math only cares about the box's own width/height, not its screen
 * offset). A rotated viewport's true visible area is a rotated rectangle;
 * this returns its axis-aligned bounding box, a conservative superset —
 * exactly what a "don't render if definitely offscreen" filter needs, and
 * simpler than clipping to the exact rotated shape for the false positives
 * (a few extra shapes rendered near a rotated view's corners) it costs.
 * Padded by one workspace-size worth of document space on each side so a
 * shape does not visibly pop in only after it has already scrolled inside
 * the frame.
 */
function visibleDocumentRect(workspaceSize: { width: number; height: number }, viewport: { panX: number; panY: number; zoom: number; rotation: number }, width: number, height: number) {
  const radians = -viewport.rotation * Math.PI / 180, cosine = Math.cos(radians), sine = Math.sin(radians);
  const toDoc = (localX: number, localY: number) => {
    const dx = localX - workspaceSize.width / 2 - viewport.panX;
    const dy = localY - workspaceSize.height / 2 - viewport.panY;
    return { x: (cosine * dx - sine * dy) / viewport.zoom + width / 2, y: (sine * dx + cosine * dy) / viewport.zoom + height / 2 };
  };
  const marginX = workspaceSize.width, marginY = workspaceSize.height;
  const corners = [toDoc(-marginX, -marginY), toDoc(workspaceSize.width + marginX, -marginY), toDoc(-marginX, workspaceSize.height + marginY), toDoc(workspaceSize.width + marginX, workspaceSize.height + marginY)];
  const xs = corners.map((corner) => corner.x), ys = corners.map((corner) => corner.y);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
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

/** Geometry attributes only — no paint. Stage 6 draws a shape's geometry
 * once per visible fill/stroke layer (the same shape, restyled and stacked,
 * is how "two fills, three strokes" on one object actually renders), so
 * paint had to stop being baked into each kind's own JSX branch. */
type GeometryTag = "rect" | "ellipse" | "line" | "path" | "text";
function geometryFor(shape: Exclude<VectorShape, { kind: "image" } | { kind: "group" }>): { Tag: GeometryTag; props: Record<string, unknown> } {
  if (shape.kind === "rectangle") return { Tag: "rect", props: { x: shape.x, y: shape.y, width: shape.width, height: shape.height, rx: shape.cornerRadius } };
  if (shape.kind === "ellipse") return { Tag: "ellipse", props: { cx: shape.x + shape.width / 2, cy: shape.y + shape.height / 2, rx: shape.width / 2, ry: shape.height / 2 } };
  if (shape.kind === "line") return { Tag: "line", props: { x1: shape.x1, y1: shape.y1, x2: shape.x2, y2: shape.y2 } };
  if (shape.kind === "text") return { Tag: "text", props: { x: shape.x, y: shape.y, fontSize: shape.fontSize, fontFamily: shape.fontFamily, textAnchor: shape.align === "center" ? "middle" : shape.align === "right" ? "end" : "start" } };
  return { Tag: "path", props: { d: pathData(shape.points, shape.closed) } };
}

/** `<linearGradient>`/`<radialGradient>` from a `GradientDef` — `from`/`to`
 * are already 0..1 against the shape's own bounding box (see `Gradient`'s
 * own doc comment), which is exactly what `gradientUnits="objectBoundingBox"`
 * expects, so no extra conversion happens here at all. A radial gradient's
 * radius is the plain distance between the two normalized points; a
 * same-point gradient (radius 0) is nudged to a hair above zero, since SVG
 * treats an exact 0 radius as "paint nothing" rather than "one solid colour". */
function renderGradientDef({ id, gradient }: GradientDef): ReactNode {
  const stops = gradient.stops.map((stop, index) => <stop key={index} offset={stop.offset} stopColor={colorToCss(stop.color)}/>);
  if (gradient.kind === "linear") return <linearGradient key={id} id={id} gradientUnits="objectBoundingBox" x1={gradient.from.x} y1={gradient.from.y} x2={gradient.to.x} y2={gradient.to.y}>{stops}</linearGradient>;
  const radius = Math.hypot(gradient.to.x - gradient.from.x, gradient.to.y - gradient.from.y) || 0.0001;
  return <radialGradient key={id} id={id} gradientUnits="objectBoundingBox" cx={gradient.from.x} cy={gradient.from.y} r={radius}>{stops}</radialGradient>;
}

const blendStyle = (mode: string): CSSProperties | undefined => mode === "normal" ? undefined : { mixBlendMode: mode as CSSProperties["mixBlendMode"] };

/**
 * A shape's own geometry, unless it has a non-empty modifier stack AND that
 * stack's result has already resolved (`modifiedPath`) — in which case the
 * whole shape renders as a single `<path>` instead of its native
 * `<rect>`/`<ellipse>`/etc, since a modifier's output (offset, rounded
 * corners, a boolean with another shape) is not, in general, still a
 * rectangle or an ellipse. Falling back to the plain geometry while
 * `modifiedPath` is still resolving (see `vector-modifiers.ts`) means a
 * shape never flashes blank or stale while its WASM-backed modifiers catch
 * up to a fast edit.
 */
function geometryOrModified(shape: Exclude<VectorShape, { kind: "image" } | { kind: "group" }>, modifiedPath: string | undefined): { Tag: GeometryTag; props: Record<string, unknown> } {
  if (shape.geometry.length > 0 && modifiedPath !== undefined) return { Tag: "path", props: { d: modifiedPath } };
  return geometryFor(shape);
}

function renderShape(shape: VectorShape, modifiedPath: string | undefined): ReactNode {
  if (!shape.visible) return null;
  if (shape.kind === "image") return <VectorImageShape key={shape.id} shape={shape}/>;
  if (shape.kind === "group") return null; // a group has no visual of its own — see renderShapeTree, which wraps its children in a transformed <g> instead of calling this

  const { Tag, props } = geometryOrModified(shape, modifiedPath);
  const resolved = resolveAppearance(shape.style, shape.id);
  const textValue = shape.kind === "text" ? shape.value : undefined;

  return <g key={shape.id} transform={shapeTransform(shape)} opacity={shape.style.opacity} style={blendStyle(shape.style.blendMode)}>
    {resolved.gradientDefs.length > 0 && <defs>{resolved.gradientDefs.map(renderGradientDef)}</defs>}
    {resolved.fills.filter((fill) => fill.layer.visible).map((fill, index) => (
      <Tag key={`fill-${index}`} {...props} fill={fill.css} stroke="none" opacity={fill.layer.opacity} style={blendStyle(fill.layer.blendMode)}>{textValue}</Tag>
    ))}
    {resolved.strokes.filter((stroke) => stroke.layer.visible).map((stroke, index) => (
      <Tag key={`stroke-${index}`} {...props} fill="none" stroke={stroke.css} strokeWidth={stroke.layer.width}
        strokeDasharray={stroke.layer.dash.length ? stroke.layer.dash.join(" ") : undefined} strokeLinecap={stroke.layer.cap} strokeLinejoin={stroke.layer.join}
        opacity={stroke.layer.opacity} style={blendStyle(stroke.layer.blendMode)}>{textValue}</Tag>
    ))}
  </g>;
}

/**
 * Walks the shape tree in paint order, wrapping each group in a `<g
 * transform>` around its own children — nested groups nest `<g>`s the same
 * way, and the browser composes the transforms for free, exactly the reason
 * `Matrix` was designed to hand straight to SVG (see matrix.ts's own doc
 * comment). This is the one place group nesting actually has to exist in the
 * render tree; `shapeAt`/`shapeWorldBounds` walk the flat `parentId` chain
 * instead because pointer math has no DOM to lean on.
 *
 * `visibleIds`, when given, skips a leaf shape not in the set instead of
 * rendering it — see docs/vector-plan.md stage 12: a live measurement found
 * the current SVG/DOM render taking seconds per frame at a few thousand
 * *simultaneously on-screen* shapes, which this does not fix (it only skips
 * shapes outside the viewport). What it does fix is the more common case of
 * a large document mostly panned out of view — not rendering a DOM node
 * that would not be visible anyway. `undefined` (the default) renders
 * everything, matching this function's behaviour before this parameter
 * existed — used for contexts with no workspace size to compute a viewport
 * rect from yet (none today, but the fallback is what the type asks for
 * rather than an unchecked non-null assertion at the call site). A group is
 * never itself tested against `visibleIds` (only leaf shapes are indexed —
 * see `buildShapeSpatialIndex`'s own reasoning for skipping them) and
 * always recurses; the cost this saves is per rendered *leaf* shape, and an
 * empty `<g>` left behind by a fully-offscreen group costs nothing real.
 */
function renderShapeTree(shapes: readonly VectorShape[], parentId: string | null, modifierResults: ReadonlyMap<string, string>, visibleIds?: ReadonlySet<string>): ReactNode[] {
  return siblingsOf(shapes, parentId).map((shape) => {
    if (!shape.visible) return null;
    if (shape.kind === "group") return <g key={shape.id} transform={shapeTransform(shape)}>{renderShapeTree(shapes, shape.id, modifierResults, visibleIds)}</g>;
    if (visibleIds && !visibleIds.has(shape.id)) return null;
    return renderShape(shape, modifierResults.get(shape.id));
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

  // Rebuilt only when the document actually changes (its revision counter,
  // incremented by every kernel.documents.update call — see
  // packages/kernel/src/document-store.ts) rather than on every render or
  // every pointer move, which is what makes stage 4's index a net win: the
  // one-time O(n) cost of building it (~12ms at 10,000 shapes, see
  // performance.bench.test.ts) is paid once per edit, not once per query.
  const spatialIndex = useMemo(() => buildShapeSpatialIndex(state.shapes, vectorTextMeasurer), [document.revision]); // eslint-disable-line react-hooks/exhaustive-deps

  // Stage 9: every shape with a non-empty geometry modifier stack, resolved
  // async (offset/simplify/boolean go through WASM) and cached by revision
  // — see vector-modifiers.ts's own doc comment.
  const modifierResults = useModifierResults(state, document.revision);

  // docs/vector-plan.md stage 5: what a drag should snap to, read straight
  // from live Settings (Guides & Grid) so a tool never has to know those
  // preferences exist — see ToolContext.snapping's own doc comment.
  const smartGuides = useShellStore((shell) => shell.preferences.smartGuides);
  const snapToGrid = useShellStore((shell) => shell.preferences.snapToGrid);
  const snapGridSize = useShellStore((shell) => shell.preferences.snapGridSize);
  // A real setting (Settings → Guides & Grid → "Snap sensitivity"), not a
  // hardcoded `8` — the owner's own complaint about snapping feeling too
  // aggressive is exactly what this knob is for.
  const snapSensitivity = useShellStore((shell) => shell.preferences.snapSensitivity);
  const snapping = {
    sources: smartGuides ? snapSources : snapSources.filter((source) => source.id === "grid"),
    gridSpacing: snapToGrid ? snapGridSize : null,
    // Screen pixels, not document units (docs/vector-plan.md's own checklist
    // item) — converted using the current zoom, the one thing a snap source
    // or the engine has no way to know on its own.
    radius: snapSensitivity / viewport.zoom,
  };

  // One state slot per tool id, held here rather than inside a tool — the
  // same reason raster's RasterWorkspace does: a tool file stays a plain
  // object with no hooks of its own, and switching tools cannot leave a
  // half-finished gesture running.
  const [toolStates, setToolStates] = useState<Record<string, unknown>>({});
  const toolStatesRef = useRef(toolStates);
  toolStatesRef.current = toolStates;

  // Stage 12's cheaper half (docs/vector-plan.md): the workspace's own pixel
  // size, tracked unconditionally (not just under "fit" mode, the way the
  // effect below only cares about it) so the culling below can convert it
  // to a document-space visible rect on every pan/zoom/resize.
  const [workspaceSize, setWorkspaceSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const measure = () => {
      const rect = workspace.getBoundingClientRect();
      setWorkspaceSize((current) => (current.width === rect.width && current.height === rect.height ? current : { width: rect.width, height: rect.height }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(workspace);
    return () => observer.disconnect();
  }, []);

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
      spatialIndex,
      snapping,
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
    const hit = point ? shapeAtIndexed(spatialIndex, state.shapes, point.x, point.y, vectorTextMeasurer) : null;
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
  // where it would sit if it had no parent. Read from the index rather than
  // recomputed — buildShapeSpatialIndex already walked every shape's
  // ancestor chain once this revision; a second walk here would just repeat
  // that work every render.
  const bounds = active ? (shapeWorldBoundsIndexed(spatialIndex, active.id) ?? null) : null;
  const stageStyle = { width: state.width, height: state.height, transform: `translate(-50%, -50%) translate(${viewport.panX}px, ${viewport.panY}px) rotate(${viewport.rotation}deg) scale(${viewport.zoom})` } as CSSProperties;

  // Stage 12 (docs/vector-plan.md): skip rendering leaf shapes definitely
  // outside the current view. `workspaceSize` is only known after the
  // ResizeObserver effect's first measurement (0x0 before that single
  // frame) — `undefined` then means "render everything", the same
  // behaviour this had before culling existed, rather than culling
  // against a bogus zero-size rect and hiding the whole document for a
  // frame.
  const visibleIds = workspaceSize.width > 0 && workspaceSize.height > 0
    ? new Set(shapesInRect(spatialIndex, state.shapes, visibleDocumentRect(workspaceSize, viewport, state.width, state.height)).map((shape) => shape.id))
    : undefined;

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
        {renderShapeTree(state.shapes, null, modifierResults, visibleIds)}
        {bounds && <rect className="vector-selection" x={bounds.x} y={bounds.y} width={bounds.width} height={bounds.height} strokeWidth={1 / viewport.zoom}/>}
        {bounds && [[bounds.x, bounds.y], [bounds.x + bounds.width, bounds.y], [bounds.x, bounds.y + bounds.height], [bounds.x + bounds.width, bounds.y + bounds.height]].map(([x, y]) => <circle className="vector-handle" key={`${x}-${y}`} cx={x} cy={y} r={5 / viewport.zoom} vectorEffect="non-scaling-stroke"/>)}
        {catalogueTool?.Overlay && <catalogueTool.Overlay state={toolStates[catalogueTool.id] ?? catalogueTool.createState()} document={state} options={(toolOptions[catalogueTool.id] ?? {}) as Readonly<Record<string, string | number | boolean>>} context={toolContextFor(catalogueTool.id)}/>}
      </svg>
    </div>
    {contextMenu.node}
  </div>;
}
