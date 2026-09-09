import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { addShape, buildShapeSpatialIndex, computeCanvasBounds, createImageShape, isIdentityMatrix, isVectorDocumentState, matrixToCss, pathData, removeShapes, resolveAppearance, shapeAtIndexed, shapesInRect, shapeWorldBoundsIndexed, siblingsOf, snapSources, TEXT_LINE_HEIGHT, wrapText, type GradientDef, type VectorDocumentState, type VectorShape } from "@vravio/env-vector";
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
import { closeCurvaturePath, deleteCurvaturePath, deleteLastCurvaturePoint, finishCurvaturePath, hasCurvatureDraft, type CurvatureState } from "./environments/vector/tools/definitions/curvature";
import type { ToolContext, ToolPointer } from "./environments/vector/tools/types";
import { vectorTextMeasurer } from "./vector-text-metrics";
import { useModifierResults } from "./vector-modifiers";
import { useVectorRulerGuides } from "./vector-ruler-guides";
import { useCmykSoftproof } from "./vector-softproof";
import { useVectorCanvasNavigation } from "./vector-navigation";
import { clampZoom } from "./raster-coordinates";
import { toDocumentPoint, toScreenPoint } from "./vector-coordinates";

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
function visibleDocumentRect(workspaceSize: { width: number; height: number }, viewport: { panX: number; panY: number; zoom: number; rotation: number }, stageBounds: { x: number; y: number; width: number; height: number }) {
  const radians = -viewport.rotation * Math.PI / 180, cosine = Math.cos(radians), sine = Math.sin(radians);
  const toDoc = (localX: number, localY: number) => {
    const dx = localX - workspaceSize.width / 2 - viewport.panX;
    const dy = localY - workspaceSize.height / 2 - viewport.panY;
    return { x: (cosine * dx - sine * dy) / viewport.zoom + stageBounds.x + stageBounds.width / 2, y: (sine * dx + cosine * dy) / viewport.zoom + stageBounds.y + stageBounds.height / 2 };
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
function geometryFor(shape: Exclude<VectorShape, { kind: "image" } | { kind: "group" } | { kind: "instance" }>): { Tag: GeometryTag; props: Record<string, unknown> } {
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
function geometryOrModified(shape: Exclude<VectorShape, { kind: "image" } | { kind: "group" } | { kind: "instance" }>, modifiedPath: string | undefined): { Tag: GeometryTag; props: Record<string, unknown> } {
  if (shape.geometry.length > 0 && modifiedPath !== undefined) return { Tag: "path", props: { d: modifiedPath } };
  return geometryFor(shape);
}

function renderShape(shape: VectorShape, modifiedPath: string | undefined, proofColors: ReadonlyMap<string, string>, shapes: readonly VectorShape[]): ReactNode {
  if (!shape.visible) return null;
  if (shape.kind === "image") return <VectorImageShape key={shape.id} shape={shape}/>;
  if (shape.kind === "group" || shape.kind === "instance") return null; // neither paints anything of its own — see renderShapeTree, which wraps a group's children (or, for an instance, its symbol's) in a transformed <g> instead of calling this

  const { Tag, props } = geometryOrModified(shape, modifiedPath);
  const resolved = resolveAppearance(shape.style, shape.id);
  // Stage 11's text-on-a-path: only a *top-level* `path` shape is a valid
  // target — see `VectorShape`'s own `pathShapeId` doc comment for why a
  // group-nested one isn't supported yet. Takes priority over `frameWidth`
  // below when both happen to be set (the panel does not stop a caller
  // from setting both; the renderer has to pick one, and following a path
  // is the more specific request of the two).
  const pathTarget = shape.kind === "text" && shape.pathShapeId
    ? shapes.find((candidate): candidate is Extract<VectorShape, { kind: "path" }> => candidate.id === shape.pathShapeId && candidate.kind === "path" && candidate.parentId === null)
    : undefined;
  const textPathId = pathTarget ? `textpath-${shape.id}` : undefined;
  // Stage 11's text-in-frame: a framed shape's own `value` becomes one
  // `<tspan>` per wrapped line rather than a single string child — each
  // starting at the same `x` (the parent `<text>`'s own `text-anchor`
  // already centres/right-aligns each line individually, the same way it
  // already aligned the single line before frames existed) and stepping
  // down by `dy` on every line after the first, using the one
  // `TEXT_LINE_HEIGHT` constant every reader of a framed shape's lines
  // shares (`text-wrap.ts`'s own doc comment) so this and
  // `vector-svg-export.ts`'s export copy can never quietly disagree on
  // line spacing.
  const textValue = shape.kind === "text"
    ? (textPathId
      ? <textPath href={`#${textPathId}`}>{shape.value}</textPath>
      : shape.frameWidth
        ? wrapText(shape.value, shape.fontFamily, shape.fontSize, shape.frameWidth, vectorTextMeasurer).map((line, index) => (
          <tspan key={index} x={shape.x} dy={index === 0 ? 0 : shape.fontSize * TEXT_LINE_HEIGHT}>{line}</tspan>
        ))
        : shape.value)
    : undefined;
  // Stage 14's softproof: a resolved solid colour's own css string is the
  // key `useCmykSoftproof` built its map with (see that hook's own doc
  // comment) — an empty map (proofing off, or nothing proofed yet) makes
  // this a no-op lookup, never a blocking one; a gradient's `css` is a
  // `url(#...)` reference, never a key this map has, so it always falls
  // through unproofed exactly as `softproof.ts`'s own documented scope
  // says it should.
  const proof = (css: string) => proofColors.get(css) ?? css;
  // `<textPath>` owns positioning entirely — an ancestor `<text>`'s own
  // `x`/`y` are meaningless (and, in at least one renderer's reading of the
  // spec, actively confusing) once it has a `<textPath>` child instead of
  // plain text.
  const geometryProps = textPathId ? { ...props, x: undefined, y: undefined } : props;

  return <g key={shape.id} transform={shapeTransform(shape)} opacity={shape.style.opacity} style={blendStyle(shape.style.blendMode)}>
    {resolved.gradientDefs.length > 0 && <defs>{resolved.gradientDefs.map(renderGradientDef)}</defs>}
    {pathTarget && textPathId && <defs><path id={textPathId} transform={isIdentityMatrix(pathTarget.transform) ? undefined : matrixToCss(pathTarget.transform)} d={pathData(pathTarget.points, pathTarget.closed)}/></defs>}
    {resolved.fills.filter((fill) => fill.layer.visible).map((fill, index) => (
      <Tag key={`fill-${index}`} {...geometryProps} fill={proof(fill.css)} stroke="none" opacity={fill.layer.opacity} style={blendStyle(fill.layer.blendMode)}>{textValue}</Tag>
    ))}
    {resolved.strokes.filter((stroke) => stroke.layer.visible).map((stroke, index) => {
      // Stage 6's own honest gap, closed: SVG's `stroke` primitive is
      // always centered on the path — there is no native "inside"/
      // "outside" attribute. The standard workaround (also what
      // Illustrator/Figma's own SVG export does): draw the stroke at
      // *double* width, then confine it to the shape's own geometry
      // ("inner", a plain `<clipPath>` referencing the shape) or to
      // everywhere *except* the shape ("outer"). "outer" needs a
      // `<mask>`, not a `clipPath` with `clipRule="evenodd"` across two
      // sibling shapes — tried first, and disproved by a real renderer,
      // not just read from a spec: resvg does not combine two *separate*
      // child elements of one `clipPath` via even-odd the way two
      // subpaths of one `<path d>` would combine (`vector-svg.
      // crosscheck.test.ts` caught this — the "outer" stroke rendered
      // right through to the shape's own untouched interior, which the
      // markup's own attribute strings alone would never have shown). A
      // `<mask>`'s white/black luminance compositing across separate
      // elements *is* reliably defined the way this needs: a big white
      // rect everywhere, a black copy of the shape painted over it, and
      // "outer" then has an unambiguous single visible region — the
      // white minus the black — instead of leaning on ambiguous evenodd-
      // across-elements behaviour no renderer this project ships against
      // has actually been checked to define the same way.
      const alignment = stroke.layer.alignment;
      if (alignment === "center") {
        return <Tag key={`stroke-${index}`} {...geometryProps} fill="none" stroke={proof(stroke.css)} strokeWidth={stroke.layer.width}
          strokeDasharray={stroke.layer.dash.length ? stroke.layer.dash.join(" ") : undefined} strokeLinecap={stroke.layer.cap} strokeLinejoin={stroke.layer.join}
          opacity={stroke.layer.opacity} style={blendStyle(stroke.layer.blendMode)}>{textValue}</Tag>;
      }
      const confineId = `stroke-align-${shape.id}-${index}`;
      const strokeElement = <Tag {...geometryProps} fill="none" stroke={proof(stroke.css)} strokeWidth={stroke.layer.width * 2} {...(alignment === "inner" ? { clipPath: `url(#${confineId})` } : { mask: `url(#${confineId})` })}
        strokeDasharray={stroke.layer.dash.length ? stroke.layer.dash.join(" ") : undefined} strokeLinecap={stroke.layer.cap} strokeLinejoin={stroke.layer.join}
        opacity={stroke.layer.opacity} style={blendStyle(stroke.layer.blendMode)}>{textValue}</Tag>;
      return <g key={`stroke-${index}`}>
        {alignment === "inner"
          ? <clipPath id={confineId}><Tag {...geometryProps}/></clipPath>
          : <mask id={confineId}><rect x={-100000} y={-100000} width={200000} height={200000} fill="white"/><Tag {...geometryProps} fill="black"/></mask>}
        {strokeElement}
      </g>;
    })}
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
function renderShapeTree(shapes: readonly VectorShape[], parentId: string | null, modifierResults: ReadonlyMap<string, string>, proofColors: ReadonlyMap<string, string>, visibleIds?: ReadonlySet<string>): ReactNode[] {
  return siblingsOf(shapes, parentId).map((shape) => {
    if (!shape.visible) return null;
    if (shape.kind === "group") return <g key={shape.id} transform={shapeTransform(shape)}>{renderShapeTree(shapes, shape.id, modifierResults, proofColors, visibleIds)}</g>;
    if (visibleIds && !visibleIds.has(shape.id)) return null;
    if (shape.kind === "instance") return (
      // Stage 13: the symbol's own children live in `shapes` too (parented
      // to the symbol's group id, itself parented to `SYMBOLS_ROOT_ID` —
      // see that constant's own doc comment), so this is the exact same
      // "wrap a subtree in a transformed `<g>`" a real group above already
      // does, just sourcing children from a different id than this shape's
      // own. `visibleIds` is deliberately NOT threaded into this inner
      // call: it was built from this instance's own (correctly computed,
      // see shapeWorldBounds' instance case) world bounds, not from where
      // each of its individual leaves would sit if they were placed
      // unscaled at the symbol library's own (irrelevant) position — culling
      // already happened one level up, in the check on this instance
      // itself, and a symbol's content is expected to stay small regardless
      // of how many times it is instanced (that is the whole feature), so
      // there is nothing worth culling again inside it.
      <g key={shape.id} transform={shapeTransform(shape)}>{renderShapeTree(shapes, shape.symbolId, modifierResults, proofColors)}</g>
    );
    return renderShape(shape, modifierResults.get(shape.id), proofColors, shapes);
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

  // Stage 15: the document-space rectangle the stage's own scaled CSS box
  // now represents — real canvas bounds (content + a margin), not
  // `state.width`/`state.height`, which used to also be the hard edge
  // nothing could render past (`docs/vector-plan.md`'s own stage 15 write-
  // up). Same revision-keyed memoisation as the spatial index, for the
  // same reason: this walks every shape's world bounds once, not once per
  // render.
  const canvasBounds = useMemo(() => computeCanvasBounds(state, vectorTextMeasurer), [document.revision]); // eslint-disable-line react-hooks/exhaustive-deps

  // Stage 9: every shape with a non-empty geometry modifier stack, resolved
  // async (offset/simplify/boolean go through WASM) and cached by revision
  // — see vector-modifiers.ts's own doc comment.
  const modifierResults = useModifierResults(state, document.revision);
  // Stage 14: which solid colours currently proof to something else, empty
  // whenever softproof is off or no profile is set — see
  // vector-softproof.ts's own doc comment for why this needs the same
  // cache-by-revision shape `useModifierResults` above already uses.
  const proofColors = useCmykSoftproof(state, document.revision);

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

  // A tool-provided cursor hint (`VectorToolDefinition.cursorFor`) — added
  // for vector.pen's several-different-outcomes-per-click gestures
  // (docs/vector-plan.md section 9). `undefined` means "no hint right now",
  // which the `<svg>`'s own inline `style` below simply omits, falling back
  // to `styles.css`'s static `.vector-stage svg{cursor:crosshair}` rule.
  const [dynamicCursor, setDynamicCursor] = useState<string | undefined>(undefined);

  // `vector.hand`/`vector.zoom` and their temporary overrides (space bar,
  // middle mouse, the wheel) — the same `useCanvasNavigation` raster's own
  // workspace drives, generalized (`canvas-navigation.ts`) so this is not a
  // second copy of that gesture logic. Its own "fit to window" effect is
  // disabled for vector (`disableFit: true` inside `useVectorCanvasNavigation`)
  // because vector fits to the *active artboard*, not a fixed document size —
  // that stays the dedicated effect below. `workspaceSize` (Stage 12's
  // viewport-culling half) now comes from here instead of a second
  // ResizeObserver doing the same measurement.
  const { workspaceSize, beginNavigation, moveNavigation, endNavigation, handleWheel, navigating, spaceHeld } = useVectorCanvasNavigation({
    documentId: document.id, workspaceRef, viewport, activeToolId, toolOptions, documentWidth: state.width, documentHeight: state.height,
  });

  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace || viewport.mode !== "fit") return;
    const fit = () => {
      const rect = workspace.getBoundingClientRect();
      // Stage 15: "fit" shows the active artboard (Illustrator's own
      // default), or the first one if none is active, or the document's
      // legacy default area for a document with no artboards at all —
      // never the raw canvas bounds, which include a margin and every
      // artboard and would otherwise zoom out further than any single
      // page a user actually wants to see filling the window.
      const fitTarget = state.artboards.find((artboard) => artboard.id === state.activeArtboardId) ?? state.artboards[0] ?? { x: 0, y: 0, width: state.width, height: state.height };
      const zoom = clampZoom(Math.min(Math.max(1, rect.width - 80) / fitTarget.width, Math.max(1, rect.height - 80) / fitTarget.height));
      // `panX`/`panY` centre the stage's own box (the full canvas bounds)
      // on the workspace by default — an extra screen-pixel offset re-centres
      // on the fit target instead, since it is not generally the canvas
      // bounds' own centre once a second artboard or off-canvas shape exists.
      const targetCenterX = fitTarget.x + fitTarget.width / 2, targetCenterY = fitTarget.y + fitTarget.height / 2;
      const canvasCenterX = canvasBounds.x + canvasBounds.width / 2, canvasCenterY = canvasBounds.y + canvasBounds.height / 2;
      const panX = -(targetCenterX - canvasCenterX) * zoom, panY = -(targetCenterY - canvasCenterY) * zoom;
      const current = useShellStore.getState().viewports[document.id] ?? defaultViewport;
      if (Math.abs(current.zoom - zoom) > 0.0001 || Math.abs(current.panX - panX) > 0.0001 || Math.abs(current.panY - panY) > 0.0001) setViewport(document.id, { zoom, panX, panY });
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(workspace);
    return () => observer.disconnect();
  }, [document.id, setViewport, state.width, state.height, state.artboards, state.activeArtboardId, canvasBounds, viewport.mode]);

  const catalogueTool = activeToolId ? vectorToolById.get(activeToolId) : undefined;

  const toolContextFor = (toolId: string): ToolContext<unknown> => {
    const tool = vectorToolById.get(toolId);
    const current = toolStatesRef.current[toolId] ?? tool?.createState();
    return {
      documentId: document.id,
      document: state,
      viewport,
      workspaceSize,
      stageBounds: canvasBounds,
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
    // A cursor hint from the tool being left must not linger on the one
    // just switched to — it will set its own on the next pointer move, but
    // there is a gap (right after switching, before the pointer moves
    // again) that would otherwise still show the old tool's hint.
    setDynamicCursor(undefined);
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
    const point = toDocumentPoint(event, workspace, viewport, canvasBounds);
    catalogueTool.onPointerDown?.(toolContextFor(catalogueTool.id), toolPointerFrom(event, point));
  };

  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!catalogueTool) return;
    const workspace = workspaceRef.current; if (!workspace) return;
    const point = toDocumentPoint(event, workspace, viewport, canvasBounds);
    const pointer = toolPointerFrom(event, point);
    catalogueTool.onPointerMove?.(toolContextFor(catalogueTool.id), pointer);
    setDynamicCursor(catalogueTool.cursorFor?.(toolContextFor(catalogueTool.id), pointer));
  };

  const onPointerUp = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!catalogueTool) return;
    const workspace = workspaceRef.current; if (!workspace) return;
    const point = toDocumentPoint(event, workspace, viewport, canvasBounds);
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
    // Same menu, vector.curvature's own equivalents — see that file's own
    // doc comment for why it needs the same four escape hatches pen.tsx does.
    const curvatureContext = toolContextFor("vector.curvature") as ToolContext<CurvatureState>;
    if (activeToolId === "vector.curvature" && hasCurvatureDraft(curvatureContext)) {
      contextMenu.open(event, [
        { label: text(store.language, "Finish Path", "Завершить контур"), onSelect: () => finishCurvaturePath(curvatureContext) },
        { label: text(store.language, "Close Path", "Закрыть контур"), onSelect: () => closeCurvaturePath(curvatureContext) },
        { label: text(store.language, "Delete Last Point", "Удалить последнюю точку"), onSelect: () => deleteLastCurvaturePoint(curvatureContext) },
        { label: text(store.language, "Delete Path", "Удалить контур"), onSelect: () => deleteCurvaturePath(curvatureContext), danger: true, separatorBefore: true },
      ]);
      return;
    }
    const workspace = workspaceRef.current;
    const point = workspace ? toDocumentPoint(event, workspace, viewport, canvasBounds) : null;
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
  // Stage 15: the stage's own CSS box now spans the canvas bounds, not
  // `state.width`/`height` — the `<svg>`'s `viewBox` (below) carries
  // `canvasBounds`'s own (x, y) origin, so this box's local coordinate
  // system still starts at (0, 0) regardless of where that origin sits in
  // document space.
  // `--vector-zoom` is published for chrome drawn inside this scaled stage by
  // components too deep to be handed the viewport — the image placeholder is
  // rendered from the shape tree, several levels down, and threading zoom
  // through every shape renderer to size one dashed box would be a poor trade.
  // Its CSS divides by this exactly the way the JSX elsewhere divides by
  // `viewport.zoom`, so there is still only one rule: screen measurements are
  // divided by the zoom, never left to scale.
  const stageStyle = { width: canvasBounds.width, height: canvasBounds.height, "--vector-zoom": viewport.zoom, transform: `translate(-50%, -50%) translate(${viewport.panX}px, ${viewport.panY}px) rotate(${viewport.rotation}deg) scale(${viewport.zoom})` } as CSSProperties;

  // Stage 12 (docs/vector-plan.md): skip rendering leaf shapes definitely
  // outside the current view. `workspaceSize` is only known after the
  // ResizeObserver effect's first measurement (0x0 before that single
  // frame) — `undefined` then means "render everything", the same
  // behaviour this had before culling existed, rather than culling
  // against a bogus zero-size rect and hiding the whole document for a
  // frame.
  const visibleIds = workspaceSize.width > 0 && workspaceSize.height > 0
    ? new Set(shapesInRect(spatialIndex, state.shapes, visibleDocumentRect(workspaceSize, viewport, canvasBounds)).map((shape) => shape.id))
    : undefined;

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
    const dropPoint = toDocumentPoint(event, workspace, viewport, canvasBounds);
    files.forEach((file, index) => void importImageFile(file, { x: dropPoint.x + index * 32, y: dropPoint.y + index * 32 }));
  };

  // Stage 15: the page(s) actually drawn as white rectangles on the canvas
  // — real artboards when the document has any, or one implicit default
  // page at (0,0,width,height) for a document with none at all, so a
  // plain single-page document still looks exactly as it always did
  // rather than showing a bare grey canvas with nothing on it.
  const pages = state.artboards.length > 0 ? state.artboards : [{ id: "__default__", name: "", x: 0, y: 0, width: state.width, height: state.height, bleed: 0 }];
  const labelSize = 12 / viewport.zoom;
  const { guideOverlay, rulers } = useVectorRulerGuides({ documentId: document.id, state, viewport, workspaceRef, workspaceSize, canvasBounds });
  const showRulers = useShellStore((shell) => shell.preferences.showRulers);
  const showGuides = useShellStore((shell) => shell.preferences.showGuides);

  return <div ref={workspaceRef} className="vector-workspace" data-active-tool={activeToolId} data-space-held={spaceHeld || undefined} data-navigating={navigating || undefined} onPointerDownCapture={beginNavigation} onPointerMoveCapture={moveNavigation} onPointerUpCapture={endNavigation} onPointerCancelCapture={endNavigation} onWheel={handleWheel} onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
    <div className="vector-stage" style={stageStyle}>
      <svg width={canvasBounds.width} height={canvasBounds.height} viewBox={`${canvasBounds.x} ${canvasBounds.y} ${canvasBounds.width} ${canvasBounds.height}`} style={dynamicCursor ? { cursor: dynamicCursor } : undefined} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerLeave={(event) => { onPointerUp(event); setDynamicCursor(undefined); }} onContextMenu={onCanvasContextMenu}>
        {pages.map((page) => <g key={page.id}>
          <rect className="vector-artboard-page" x={page.x} y={page.y} width={page.width} height={page.height}/>
          <rect className={page.id === state.activeArtboardId ? "vector-artboard-outline active" : "vector-artboard-outline"} x={page.x} y={page.y} width={page.width} height={page.height} strokeWidth={(page.id === state.activeArtboardId ? 1.5 : 1) / viewport.zoom}/>
          {page.bleed > 0 && <rect className="vector-artboard-bleed" x={page.x - page.bleed} y={page.y - page.bleed} width={page.width + page.bleed * 2} height={page.height + page.bleed * 2} strokeWidth={1 / viewport.zoom} strokeDasharray={`${4 / viewport.zoom} ${3 / viewport.zoom}`}/>}
          {page.name && <text className="vector-artboard-label" x={page.x} y={page.y - labelSize * 0.6} fontSize={labelSize}>{page.name}</text>}
        </g>)}
        {renderShapeTree(state.shapes, null, modifierResults, proofColors, visibleIds)}
        {catalogueTool?.Overlay && <catalogueTool.Overlay state={toolStates[catalogueTool.id] ?? catalogueTool.createState()} document={state} options={(toolOptions[catalogueTool.id] ?? {}) as Readonly<Record<string, string | number | boolean>>} context={toolContextFor(catalogueTool.id)}/>}
      </svg>
    </div>
    {/* Outside .vector-stage on purpose — same reasoning as the brush cursor
        and raster's own rulers/guides (`raster-ruler-guides.tsx`'s own doc
        comment): that element carries the zoom's CSS transform, which
        `non-scaling-stroke` does not reliably cancel for screen-space chrome.
        The selection outline/handles moved here in docs/master-plan.md
        section 4.8's own refactor — see `toScreenPoint`'s doc comment
        (`vector-coordinates.ts`) for the svgedit-verified reasoning: this
        layer carries no scale transform at all, so a handle's own radius is
        simply a constant, never divided by zoom, the same way the CSS
        cascade regression (commit `5ba9856`) could not have happened here —
        there is nothing left for a stray `stroke-width` rule to defeat. */}
    {bounds && !catalogueTool?.editsPathPoints && (() => {
      const corners = [
        toScreenPoint({ x: bounds.x, y: bounds.y }, workspaceSize, viewport, canvasBounds),
        toScreenPoint({ x: bounds.x + bounds.width, y: bounds.y }, workspaceSize, viewport, canvasBounds),
        toScreenPoint({ x: bounds.x + bounds.width, y: bounds.y + bounds.height }, workspaceSize, viewport, canvasBounds),
        toScreenPoint({ x: bounds.x, y: bounds.y + bounds.height }, workspaceSize, viewport, canvasBounds),
      ];
      return <svg className="vector-selection-overlay" width={workspaceSize.width} height={workspaceSize.height} aria-hidden="true">
        <polygon className="vector-selection" points={corners.map((corner) => `${corner.x},${corner.y}`).join(" ")}/>
        {corners.map((corner, index) => <circle key={index} className="vector-handle" cx={corner.x} cy={corner.y} r={5}/>)}
      </svg>;
    })()}
    {catalogueTool?.ScreenOverlay && <svg className="vector-selection-overlay" width={workspaceSize.width} height={workspaceSize.height} aria-hidden="true">
      <catalogueTool.ScreenOverlay state={toolStates[catalogueTool.id] ?? catalogueTool.createState()} document={state} options={(toolOptions[catalogueTool.id] ?? {}) as Readonly<Record<string, string | number | boolean>>} context={toolContextFor(catalogueTool.id)}/>
    </svg>}
    {showGuides && guideOverlay}
    {showRulers && rulers}
    {contextMenu.node}
  </div>;
}
