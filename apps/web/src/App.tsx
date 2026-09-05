import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { confineToSelection, cropRasterDocument, decodePsd, defaultAdjustment, findSmartCrop, layerDocumentPixels, setLayerPixels, compositeRasterDocument, computeAlignOffsets, computeDistributeOffsets, createRasterLayer, isRasterDocumentState, layerContentBounds, translateLayerPixels, type AlignEdge, type RasterAdjustment, type RasterDocumentState, type RasterRect } from "@vravio/env-raster";
import { BusyAnnouncement, BusyCursor } from "./BusyCursor";
import { withBusyPainted } from "./busy";
import { useShellStore, type Language } from "./store";
import type { EnvironmentKind, RenderBackend } from "@vravio/kernel";
import { DockLayout } from "./DockLayout";
import { environmentMeta } from "./environment";
import { rasterToolGroups, toolById, toolsFor, type ToolDefinition, type ToolOption } from "./tools";
import { useDocuments } from "./useDocuments";
import { activeCommandContext, ensureCommandsRegistered } from "./commands";
import { kernel } from "./kernel";
import { EnvironmentIcon } from "./EnvironmentIcon";
import { localized, resolveLabel, text } from "./i18n";
import { OptionRow } from "./ui/molecules/OptionRow";
import { SettingsDialog } from "./SettingsDialog";
import { NewDocumentDialog } from "./NewDocumentDialog";
import { clearDiagnostics, diagnostic, readDiagnostics, type DiagnosticEntry } from "./diagnostics";
import { FilterGalleryDialog } from "./FilterGalleryDialog";
import { LiquifyDialog } from "./LiquifyDialog";
import { rawExtensionOf, rawFileExtensions, type DecodedRaw } from "./rawDecode";
import { CameraRawDialog } from "./CameraRawDialog";
import { CameraRawFilterDialog } from "./CameraRawFilterDialog";
import { ExportDialog } from "./ExportDialog";
import { decodeImportedImage } from "./imageImport";
import { PerformanceOverlay } from "./PerformanceOverlay";
import { renderTextLayerPixels } from "./textRender";
import { AdjustmentDialog } from "./raster-adjustments/AdjustmentDialog";
import { rasterAdjustmentById, rasterAdjustments } from "./raster-adjustments/registry";
import type { RasterAdjustmentDefinition } from "./raster-adjustments/types";
import { adjustedPixels } from "./raster-adjustments/apply";
import { windowsFor } from "./windows/registry";
import { windowTitle } from "./windows/types";
import { PANEL_CHANGED_EVENT, readVisiblePanelIds, requestPanelVisibility } from "./windows/runtime";
import { duplicateActiveVectorShape, deleteActiveVectorShapes, reorderActiveVectorShape } from "./vector-commands";
import { isVectorDocumentState } from "@vravio/env-vector";
import { luminanceHistogram } from "./raster-adjustments/histogram";
import "./styles.css";

export function App() {
  ensureCommandsRegistered();
  const store = useShellStore();
  const documents = useDocuments();
  const [query, setQuery] = useState("");
  const [openToolGroup, setOpenToolGroup] = useState<string | null>(null);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const openImageRef = useRef<HTMLInputElement>(null);
  const [transformMetrics, setTransformMetrics] = useState<{ active: boolean; x: number; y: number; width: number; height: number; rotation: number } | null>(null);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [diagnostics, setDiagnostics] = useState<DiagnosticEntry[]>([]);
  const [filterGalleryOpen, setFilterGalleryOpen] = useState(false);
  const [liquifyOpen, setLiquifyOpen] = useState(false);
  const [cameraRawFilterOpen, setCameraRawFilterOpen] = useState(false);
  const [cameraRawImport, setCameraRawImport] = useState<{ buffer: ArrayBuffer; name: string } | null>(null);
  const [cameraRawReopen, setCameraRawReopen] = useState<{ buffer: ArrayBuffer; name: string } | null>(null);
  const [renderBackend, setRenderBackend] = useState<RenderBackend | null>(kernel.gpu.active);
  const [exportOpen, setExportOpen] = useState(false);
  const [adjustmentDialog, setAdjustmentDialog] = useState<{ documentId: string; layerId: string; definitionId: RasterAdjustment["kind"]; initialValue: RasterAdjustment } | null>(null);
  const [, setPanelRevision] = useState(0);
  const active = documents.find((document) => document.id === store.activeDocumentId) ?? null;
  const activeToolId = active ? store.activeToolByDocument[active.id] : undefined;
  const activeTool = toolById(activeToolId);
  const activeRawOrigin = active?.origin?.kind === "asset" && kernel.assets.get(active.origin.assetId)?.mime === "image/x-raw" ? active.origin : null;
  const commands = useMemo(() => kernel.commands.search(query), [query]);
  const themeStyle = { "--focus": store.preferences.focusColor, "--raster": store.preferences.rasterColor, "--vector": store.preferences.vectorColor, "--audio": store.preferences.audioColor, "--video": store.preferences.videoColor, "--canvas-surround": store.preferences.canvasSurround, "--guide": store.preferences.guideColor } as CSSProperties;

  const openDecodedRaster = (name: string, decoded: DecodedRaw): string => {
    store.openDocument("raster", { name, width: decoded.width, height: decoded.height, resolution: 72, resolutionUnit: "ppi", backgroundColor: null, pixelAspectRatio: 1 });
    const id = useShellStore.getState().activeDocumentId!;
    kernel.documents.update<RasterDocumentState>(id, (state) => { setLayerPixels(state.layers[0]!, decoded.pixels, state.width, state.height); });
    return id;
  };

  const importPsd = async (file: File) => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let result: ReturnType<typeof decodePsd>;
    try { result = decodePsd(bytes); } catch (error) { diagnostic("error", "file.import", `Could not decode ${file.name}: ${error instanceof Error ? error.message : String(error)}`); return; }
    for (const warning of result.warnings) diagnostic("warn", "file.import", warning);
    store.openDocument("raster", { name: file.name, width: result.document.width, height: result.document.height, resolution: 72, resolutionUnit: "ppi", backgroundColor: null, pixelAspectRatio: 1 });
    const id = useShellStore.getState().activeDocumentId; if (!id) return;
    kernel.documents.update<RasterDocumentState>(id, (state) => { state.layers = result.document.layers; state.activeLayerId = result.document.activeLayerId; });
  };

  const importImage = async (file: File) => {
    const extension = rawExtensionOf(file.name);
    if (extension && (rawFileExtensions as readonly string[]).includes(extension)) {
      setCameraRawImport({ buffer: await file.arrayBuffer(), name: file.name });
      return;
    }
    if (extension === "psd" || extension === "psb") { await importPsd(file); return; }
    const source = await decodeImportedImage(file);
    if (!source) { diagnostic("error", "file.import", `Could not decode ${file.name}`); return; }
    store.openDocument("raster", { name: file.name, width: source.width, height: source.height, resolution: 72, resolutionUnit: "ppi", backgroundColor: null, pixelAspectRatio: 1 });
    const id = useShellStore.getState().activeDocumentId; if (!id) return;
    const surface = window.document.createElement("canvas"); surface.width = source.width; surface.height = source.height; const context = surface.getContext("2d"); if (!context) return; context.drawImage(source.image, 0, 0, source.width, source.height); source.release();
    kernel.documents.update<RasterDocumentState>(id, (state) => { setLayerPixels(state.layers[0]!, context.getImageData(0, 0, state.width, state.height).data, state.width, state.height); });
  };
  const download = (blob: Blob, name: string) => { void kernel.platform.fs.saveFile({ name, mime: blob.type || "application/octet-stream", data: blob }).catch((error) => diagnostic("error", "file.save", error instanceof Error ? error.message : String(error), error)); };
  const projectFileName = (name: string) => `${name.replace(/\s*\([^()]*\)\s*$/, "").replace(/\.[^.]+$/, "").trim() || "untitled"}.vravio.json`;
  const projectBlob = () => { const replacer = (_key: string, value: unknown) => value instanceof Uint8ClampedArray ? { __type: "Uint8ClampedArray", data: Array.from(value) } : value; return new Blob([JSON.stringify(active?.state, replacer)], { type: "application/json" }); };
  /** Save writes through the platform port and clears the dirty flag; Save a Copy deliberately leaves it set. */
  const saveProject = async (markClean = true) => {
    if (!active) return;
    try {
      await kernel.platform.fs.saveFile({ name: projectFileName(active.name), mime: "application/json", data: projectBlob() });
      if (markClean) kernel.documents.markSaved(active.id);
    } catch (error) { diagnostic("error", "file.save", error instanceof Error ? error.message : String(error), error); }
  };
  const applyFilter = (pixels: Uint8ClampedArray, label: string) => { if (!active || !isRasterDocumentState(active.state)) return; const id=active.id,layerId=active.state.activeLayerId,state0=active.state,target=state0.layers.find((item)=>item.id===layerId);if(!target)return;
    // Filters run over the layer's own buffer, but the selection mask is in
    // canvas coordinates, so both sides are brought into canvas space before
    // the rule is applied and trimmed again on the way in.
    const before=layerDocumentPixels(target,state0.width,state0.height).slice();
    const filtered=pixels.length===before.length?pixels:layerDocumentPixels({...target,pixels,bounds:target.bounds,width:target.width,height:target.height},state0.width,state0.height);const assign=(value:Uint8ClampedArray)=>{kernel.documents.update<RasterDocumentState>(id,(state)=>{const layer=state.layers.find((item)=>item.id===layerId);if(layer)setLayerPixels(layer,value,state.width,state.height);});};
    // The same rule as every other tool: a filter may not touch pixels outside
    // the selection. Filters run over the whole layer, so the confinement is
    // what makes "apply to the selection" mean anything at all.
    const selection=active.state.selection;
    const confined=selection?confineToSelection(before,filtered,selection.mask):filtered;
    const history=kernel.historyByDocument.get(id);if(history)void history.execute({label:`Filter: ${label}`,memoryEstimate:before.byteLength+confined.byteLength,redo:()=>assign(confined),undo:()=>assign(before)}); };
  const openCameraRawReprocess = async () => {
    if (!active) return;
    const source = active.origin?.kind === "asset" ? active.origin : null;
    if (!source || kernel.assets.get(source.assetId)?.mime !== "image/x-raw") return;
    try {
      await kernel.assetsReady;
      const bytes = await kernel.assets.read(source.assetId, source.rev ?? undefined);
      if (!bytes) throw new Error("RAW source is missing from AssetStore");
      setCameraRawReopen({ buffer: bytes.slice().buffer, name: source.name });
    } catch (error) {
      diagnostic("error", "camera-raw.asset-read", error instanceof Error ? error.message : String(error), { documentId: active.id });
    }
  };

  const selectedLayerIds = active ? store.selectedLayerIdsByDocument[active.id] ?? [] : [];
  const activeRasterState = active && isRasterDocumentState(active.state) ? active.state : null;
  const editingMaskLayerId = active ? store.editingMaskLayerIdByDocument[active.id] ?? null : null;
  const maskForegroundIsWhite = active ? store.maskForegroundIsWhiteByDocument[active.id] ?? false : false;
  const effectiveForegroundColor = editingMaskLayerId ? (maskForegroundIsWhite ? "#ffffff" : "#000000") : store.foregroundColor;
  const effectiveBackgroundColor = editingMaskLayerId ? (maskForegroundIsWhite ? "#000000" : "#ffffff") : store.backgroundColor;
  const activeTextLayer = (() => { if (!active || !isRasterDocumentState(active.state)) return null; const state = active.state; return state.layers.find((layer) => layer.id === state.activeLayerId && layer.kind === "text" && layer.text) ?? null; })();
  const activeImageShape = (() => { if (!active || !isVectorDocumentState(active.state)) return false; const state = active.state; return state.shapes.find((shape) => shape.id === state.activeShapeId)?.kind === "image"; })();
  const unionBounds = (boxes: RasterRect[]): RasterRect => { const left = Math.min(...boxes.map((box) => box.x)), top = Math.min(...boxes.map((box) => box.y)), right = Math.max(...boxes.map((box) => box.x + box.width)), bottom = Math.max(...boxes.map((box) => box.y + box.height)); return { x: left, y: top, width: right - left, height: bottom - top }; };
  const alignOrDistributeLayers = (kind: "align" | "distribute", edge: AlignEdge) => {
    if (!active || !isRasterDocumentState(active.state)) return;
    const state = active.state, ids = (selectedLayerIds.length ? selectedLayerIds : [state.activeLayerId]).filter((id) => state.layers.some((layer) => layer.id === id));
    if (kind === "distribute" ? ids.length < 3 : ids.length < 1) return;
    const targets = state.layers.filter((layer) => ids.includes(layer.id));
    const bounds = targets.map((layer) => layerContentBounds(layerDocumentPixels(layer, state.width, state.height), state.width, state.height));
    const offsets = kind === "align"
      ? computeAlignOffsets(bounds, edge, ids.length > 1 ? unionBounds(bounds) : { x: 0, y: 0, width: state.width, height: state.height })
      : computeDistributeOffsets(bounds, edge);
    if (!offsets.some((offset) => offset.dx || offset.dy)) return;
    type LayerSnapshot = { id: string; pixels: Uint8ClampedArray };
    const id = active.id, before: LayerSnapshot[] = targets.map((layer) => ({ id: layer.id, pixels: layerDocumentPixels(layer, state.width, state.height).slice() }));
    const after: LayerSnapshot[] = targets.map((layer, index) => ({ id: layer.id, pixels: translateLayerPixels(layerDocumentPixels(layer, state.width, state.height), state.width, state.height, offsets[index]!.dx, offsets[index]!.dy) }));
    const assign = (list: LayerSnapshot[]) => { kernel.documents.update<RasterDocumentState>(id, (current) => { for (const item of list) { const layer = current.layers.find((entry) => entry.id === item.id); if (layer) setLayerPixels(layer, item.pixels, current.width, current.height); } }); };
    const history = kernel.historyByDocument.get(id);
    if (history) void history.execute({ label: kind === "align" ? `Align: ${edge}` : `Distribute: ${edge}`, memoryEstimate: [...before, ...after].reduce((sum, item) => sum + item.pixels.byteLength, 0), redo: () => assign(after), undo: () => assign(before) });
  };

  const openImageAdjustment = (definition: RasterAdjustmentDefinition) => {
    if (!active || !isRasterDocumentState(active.state)) return;
    const state = active.state;
    const layer = state.layers.find((item) => item.id === state.activeLayerId);
    if (!layer || layer.kind !== "pixel") { diagnostic("warn", "adjustment.open", "Direct adjustments require an editable pixel layer", { layerId: layer?.id, kind: layer?.kind }); return; }
    setAdjustmentDialog({ documentId: active.id, layerId: layer.id, definitionId: definition.id, initialValue: defaultAdjustment(definition.id) });
  };

  const previewImageAdjustment = (value: RasterAdjustment | null) => {
    if (!adjustmentDialog) return;
    const document = kernel.documents.get<RasterDocumentState>(adjustmentDialog.documentId); if (!document || !isRasterDocumentState(document.state)) return;
    if (!value) { window.dispatchEvent(new CustomEvent("vravio-raster-preview", { detail: { documentId: document.id, pixels: null } })); return; }
    const target = document.state.layers.find((layer) => layer.id === adjustmentDialog.layerId); if (!target) return;
    const before = layerDocumentPixels(target, document.state.width, document.state.height), confined = adjustedPixels(before, value, document.state.selection);
    const layers = document.state.layers.map((layer) => layer.id === target.id ? { ...layer, pixels: layer.pixels.slice(), effects: structuredClone(layer.effects) } : layer);
    const previewState = { ...document.state, layers }; const previewLayer = layers.find((layer) => layer.id === target.id)!; setLayerPixels(previewLayer, confined, previewState.width, previewState.height);
    window.dispatchEvent(new CustomEvent("vravio-raster-preview", { detail: { documentId: document.id, pixels: compositeRasterDocument(previewState) } }));
  };

  const applyImageAdjustment = (value: RasterAdjustment) => {
    if (!adjustmentDialog) return;
    const document = kernel.documents.get<RasterDocumentState>(adjustmentDialog.documentId); if (!document || !isRasterDocumentState(document.state)) return;
    const target = document.state.layers.find((layer) => layer.id === adjustmentDialog.layerId); if (!target || target.kind !== "pixel") return;
    const before = layerDocumentPixels(target, document.state.width, document.state.height).slice(), confined = adjustedPixels(before, value, document.state.selection);
    const assign = (pixels: Uint8ClampedArray) => { kernel.documents.update<RasterDocumentState>(document.id, (state) => { const layer = state.layers.find((item) => item.id === target.id); if (layer) setLayerPixels(layer, pixels, state.width, state.height); }); };
    const definition = rasterAdjustmentById.get(value.kind), history = kernel.historyByDocument.get(document.id);
    if (history) void history.execute({ label: `Adjustment: ${definition?.name.en ?? value.kind}`, memoryEstimate: before.byteLength + confined.byteLength, redo: () => assign(confined), undo: () => assign(before) }); else assign(confined);
    previewImageAdjustment(null); setAdjustmentDialog(null);
  };
  /**
   * Adds a watermark as an ordinary editable text layer pinned to a corner, so the text,
   * font and opacity stay adjustable in the Type panel instead of being baked in.
   */
  const addWatermark = (corner: "topLeft" | "topRight" | "bottomLeft" | "bottomRight" = "bottomRight") => {
    if (!active || !isRasterDocumentState(active.state)) return;
    const state = active.state;
    const fontSize = Math.max(14, Math.round(Math.min(state.width, state.height) / 22));
    const margin = Math.round(fontSize * 0.9);
    const value = localized(active.name, store.language).replace(/\.[^.]+$/, "") || "VRAVIO";
    const right = corner === "topRight" || corner === "bottomRight";
    const bottom = corner === "bottomLeft" || corner === "bottomRight";
    const layer = createRasterLayer(state.width, state.height, "Watermark (Водяной знак)");
    layer.kind = "text";
    layer.opacity = .45;
    layer.text = {
      value, x: right ? state.width - margin : margin, y: bottom ? state.height - margin - fontSize * 1.2 : margin,
      fontFamily: "Arial", fontSize, lineHeight: 1.2, letterSpacing: 0, align: right ? "right" : "left", color: "#ffffff",
    };
    setLayerPixels(layer, renderTextLayerPixels(layer.text, state.width, state.height), state.width, state.height);
    kernel.documents.update<RasterDocumentState>(active.id, (current) => { current.layers.push(layer); current.activeLayerId = layer.id; });
  };

  /**
   * Crops to the most interesting region of the requested aspect ratio.
   *
   * Runs on gradients and saturation rather than a model, so there is nothing to download and
   * it works on landscapes and product shots where face detection has nothing to find.
   */
  const smartCrop = async (aspect: number, label: string) => {
    if (!active || !isRasterDocumentState(active.state)) return;
    const state = active.state;
    // Compositing the document and scoring every region of it takes seconds on a
    // large file, with nothing on screen to say so.
    const { rect, score } = await withBusyPainted(
      localized("Finding a crop (Подбор кадра)", store.language),
      () => findSmartCrop(compositeRasterDocument(state), state.width, state.height, { aspect }),
    );
    if (rect.width < 8 || rect.height < 8) { diagnostic("warn", "smartcrop", "Suggested crop was too small to apply", { documentId: active.id }); return; }
    diagnostic("info", "smartcrop", `${label}: ${rect.width}×${rect.height} at ${rect.x},${rect.y}`, { score: Math.round(score * 1000) / 1000 });
    const history = kernel.historyByDocument.get(active.id);
    if (!history) return;
    const documentId = active.id;
    const clone = (snapshot: RasterDocumentState): RasterDocumentState => ({
      ...snapshot,
      layers: snapshot.layers.map((layer) => ({ ...layer, pixels: layer.pixels.slice(), ...(layer.mask ? { mask: { ...layer.mask, pixels: layer.mask.pixels.slice() } } : {}) })),
      selection: snapshot.selection ? { mask: snapshot.selection.mask.slice(), bounds: { ...snapshot.selection.bounds } } : null,
      guides: snapshot.guides.map((guide) => ({ ...guide })),
    });
    const assign = (snapshot: RasterDocumentState): void => { kernel.documents.update<RasterDocumentState>(documentId, (current) => { Object.assign(current, clone(snapshot)); }); };
    const before = clone(state), after = cropRasterDocument(before, rect);
    void history.execute({ label: `Smart Crop (Умное кадрирование): ${label}`, redo: () => assign(after), undo: () => assign(before) });
    store.setViewport(documentId, { mode: "fit", panX: 0, panY: 0 });
  };

  const toggleActiveTextStyle = (key: "bold" | "italic" | "underline") => {
    if (!active || !isRasterDocumentState(active.state)) return;
    const state = active.state, layer = state.layers.find((item) => item.id === state.activeLayerId);
    if (!layer?.text) return;
    const nextText = { ...layer.text, [key]: !layer.text[key] };
    kernel.documents.update<RasterDocumentState>(active.id, (current) => {
      const target = current.layers.find((item) => item.id === layer.id); if (!target?.text) return;
      target.text = nextText; setLayerPixels(target, renderTextLayerPixels(nextText, current.width, current.height), current.width, current.height);
    });
  };

  useEffect(() => {
    const onTransformState = (event: Event) => setTransformMetrics((event as CustomEvent).detail ?? null);
    window.addEventListener("vravio-transform-state", onTransformState);
    return () => window.removeEventListener("vravio-transform-state", onTransformState);
  }, []);

  useEffect(() => {
    const refresh = () => setDiagnostics(readDiagnostics());
    refresh(); window.addEventListener("vravio-diagnostics-change", refresh);
    return () => window.removeEventListener("vravio-diagnostics-change", refresh);
  }, []);

  useEffect(() => { const refresh = () => setPanelRevision((value) => value + 1); window.addEventListener(PANEL_CHANGED_EVENT, refresh); return () => window.removeEventListener(PANEL_CHANGED_EVENT, refresh); }, []);

  useEffect(() => {
    const save = () => void saveProject();
    const saveCopy = () => void saveProject(false);
    const openExport = () => setExportOpen(true);
    const openFile = () => openImageRef.current?.click();
    const openLiquify = () => { if (active && isRasterDocumentState(active.state)) setLiquifyOpen(true); };
    const openAdjustment = (event: Event) => { const definition = rasterAdjustmentById.get((event as CustomEvent<{ kind: RasterAdjustment["kind"] }>).detail.kind); if (definition) openImageAdjustment(definition); };
    // Save As and Save both go through the platform picker, so they share a handler until
    // the web build can remember a file handle to write back to silently.
    window.addEventListener("vravio-file-save", save);
    window.addEventListener("vravio-file-save-as", save);
    window.addEventListener("vravio-file-save-copy", saveCopy);
    window.addEventListener("vravio-file-export", openExport);
    window.addEventListener("vravio-file-open", openFile);
    window.addEventListener("vravio-liquify-open", openLiquify);
    window.addEventListener("vravio-adjustment-open", openAdjustment);
    return () => {
      window.removeEventListener("vravio-file-save", save);
      window.removeEventListener("vravio-file-save-as", save);
      window.removeEventListener("vravio-file-save-copy", saveCopy);
      window.removeEventListener("vravio-file-export", openExport);
      window.removeEventListener("vravio-file-open", openFile);
      window.removeEventListener("vravio-liquify-open", openLiquify);
      window.removeEventListener("vravio-adjustment-open", openAdjustment);
    };
  });

  useEffect(() => {
    const subscription = kernel.gpu.subscribe((event) => {
      setRenderBackend(event.current);
      diagnostic("info", "render.backend", `${event.previous ?? "none"} → ${event.current}`, { reason: event.reason });
    });
    void kernel.gpuReady.then(setRenderBackend).catch((error) => diagnostic("error", "render.backend", error instanceof Error ? error.message : String(error)));
    return () => subscription.dispose();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const modifier = event.ctrlKey || event.metaKey;
      const key = physicalShortcutKey(event);
      const target = event.target as HTMLElement | null;
      const editing = target?.tagName === "INPUT" || target?.tagName === "SELECT" || target?.tagName === "TEXTAREA" || target?.isContentEditable;
      const mappedCommand = kernel.keymap.resolve(event, active ? ["global", active.kind] : ["global"]);
      if ((!editing || mappedCommand === "view.commandPalette") && mappedCommand) {
        event.preventDefault();
        void kernel.commands.execute(mappedCommand, { ...activeCommandContext(), shiftKey: event.shiftKey });
        return;
      }
      if (!editing && modifier && (key === "+" || key === "=")) { event.preventDefault(); void kernel.commands.execute("view.zoomIn", activeCommandContext()); }
      if (!editing && modifier && key === "-") { event.preventDefault(); void kernel.commands.execute("view.zoomOut", activeCommandContext()); }
      if (event.key === "Escape") { store.setPaletteOpen(false); store.setSettingsOpen(false); store.cancelNewDocument(); }
      if (!modifier && !editing && active) {
        if (key === "d") { event.preventDefault(); if (editingMaskLayerId) store.setMaskForegroundWhite(active.id, false); else store.resetColors(); return; }
        if (key === "x") { event.preventDefault(); if (editingMaskLayerId) store.swapMaskColors(active.id); else store.swapColors(); return; }
        if ((key === "[" || key === "]") && activeTool) {
          const sizeOption = activeTool.options.find((option) => option.id === "size" && option.type === "number");
          if (sizeOption?.type === "number") { event.preventDefault(); const current = Number(store.toolOptions[activeTool.id]?.size ?? sizeOption.defaultValue); store.setToolOption(activeTool.id, "size", Math.max(sizeOption.min, Math.min(sizeOption.max, current + (key === "]" ? Math.max(1, Math.round(current * .1)) : -Math.max(1, Math.round(current * .1)))))); return; }
        }
        if (/^[0-9]$/.test(key) && activeTool?.options.some((option) => option.id === "opacity")) { event.preventDefault(); store.setToolOption(activeTool.id, event.shiftKey ? "flow" : "opacity", key === "0" ? 100 : Number(key) * 10); return; }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [store, active]);

  return <div className="app" data-theme={store.theme} style={themeStyle}>
    <header className="menu-bar">
      <strong className={active ? "brand compact" : "brand full"}><img src={active ? "/логотип цветная плашка.svg" : "/логотип белый.svg"} alt="VRAVIO" /></strong>
      <nav aria-label={store.language === "ru" ? "Главное меню" : "Main menu"}>
        <Menu label="File (Файл)" language={store.language} open={openMenu === "file"} onToggle={() => setOpenMenu(openMenu === "file" ? null : "file")} items={[
          ["New… (Новый…)", "Ctrl+N", () => store.requestNewDocument("raster")],
          ["Open… (Открыть…)", "Ctrl+O", () => openImageRef.current?.click()],
          ["Import… (Импортировать…)", "", () => openImageRef.current?.click()],
          ["Save (Сохранить)", "Ctrl+S", () => void saveProject(), !active],
          ["Save As… (Сохранить как…)", "Ctrl+Shift+S", () => void saveProject(), !active],
          ["Save a Copy… (Сохранить копию…)", "Ctrl+Alt+S", () => void saveProject(false), !active],
          ["Export… (Экспортировать…)", "Ctrl+Shift+E", () => setExportOpen(true), !active || !isRasterDocumentState(active.state)],
          ["Print… (Печать…)", "Ctrl+P", () => window.print(), !active],
          ["Close (Закрыть)", "Ctrl+W", () => active && store.closeDocument(active.id), !active],
        ]}/>
        <Menu label="Edit (Правка)" language={store.language} open={openMenu === "edit"} onToggle={() => setOpenMenu(openMenu === "edit" ? null : "edit")} items={[["Undo (Отменить)", "Ctrl+Z", () => void kernel.commands.execute("edit.undo", activeCommandContext())], ["Redo (Повторить)", "Ctrl+Shift+Z", () => void kernel.commands.execute("edit.redo", activeCommandContext())], ["Free Transform (Свободная трансформация)", "Ctrl+T", () => window.dispatchEvent(new Event("vravio-transform-start"))]]}/>
        {active?.kind === "raster" && <Menu label="Image (Изображение)" language={store.language} open={openMenu === "image"} onToggle={() => setOpenMenu(openMenu === "image" ? null : "image")} items={[
          { label: "Adjustments (Коррекция)", items: rasterAdjustments.map((definition) => [`${definition.name.en}… (${definition.name.ru}…)`, definition.shortcut ?? "", () => openImageAdjustment(definition), !activeRasterState || activeRasterState.layers.find((layer) => layer.id === activeRasterState.activeLayerId)?.kind !== "pixel"] as MainMenuItem) },
          ["Smart Crop 1:1 (Умное кадрирование 1:1)", "", () => { void smartCrop(1, "1:1"); }, !active || !isRasterDocumentState(active.state)],
          ["Smart Crop 16:9 (Умное кадрирование 16:9)", "", () => { void smartCrop(16 / 9, "16:9"); }, !active || !isRasterDocumentState(active.state)],
          ["Smart Crop 4:5 (Умное кадрирование 4:5)", "", () => { void smartCrop(4 / 5, "4:5"); }, !active || !isRasterDocumentState(active.state)],
          ["Image Size… (Размер изображения…)", "Ctrl+Alt+I", () => {}, true],
          ["Canvas Size… (Размер холста…)", "Ctrl+Alt+C", () => {}, true],
        ]}/>}
        {active?.kind === "raster" && <Menu label="Layer (Слой)" language={store.language} open={openMenu === "layer"} onToggle={() => setOpenMenu(openMenu === "layer" ? null : "layer")} items={[
          ["Duplicate Layer (Дублировать слой)", "Ctrl+J", () => void kernel.commands.execute("layer.duplicate", activeCommandContext()), !active || !isRasterDocumentState(active.state)],
          ["Delete Layer (Удалить слой)", "", () => void kernel.commands.execute("layer.delete", activeCommandContext()), !active || !isRasterDocumentState(active.state)],
          ["New 3D Text Layer… (Новый объёмный текстовый слой…)", "", () => void kernel.commands.execute("layer.new3DText", activeCommandContext()), !active || !isRasterDocumentState(active.state)],
          ["New 3D Extrusion from Layer (Экструдировать слой в 3D)", "", () => void kernel.commands.execute("layer.new3DExtrude", activeCommandContext()), !active || !isRasterDocumentState(active.state)],
          ["Add Watermark (Добавить водяной знак)", "", () => addWatermark("bottomRight"), !active || !isRasterDocumentState(active.state)],
          ["Layer Style… (Стиль слоя…)", "", () => window.dispatchEvent(new Event("vravio-layer-style-open")), !active || active.kind !== "raster"],
          ["Merge Down (Объединить с нижним)", "Ctrl+E", () => {}, true],
          ["Flatten Image (Свести изображение)", "", () => {}, true],
        ]}/>}
        {active?.kind === "vector" && <Menu label="Object (Объект)" language={store.language} open={openMenu === "object"} onToggle={() => setOpenMenu(openMenu === "object" ? null : "object")} items={[
          ["Duplicate (Дублировать)", "Ctrl+J", () => active && duplicateActiveVectorShape(active.id)],
          ["Delete (Удалить)", "Delete", () => active && deleteActiveVectorShapes(active.id)],
          ["Bring to Front (На передний план)", "", () => active && reorderActiveVectorShape(active.id, "front")],
          ["Bring Forward (Переместить выше)", "", () => active && reorderActiveVectorShape(active.id, "forward")],
          ["Send Backward (Переместить ниже)", "", () => active && reorderActiveVectorShape(active.id, "backward")],
          ["Send to Back (На задний план)", "", () => active && reorderActiveVectorShape(active.id, "back")],
          ["Edit Image in Raster Environment… (Открыть картинку в растровой среде…)", "", () => active && void kernel.commands.execute("image.openElsewhere", { activeDocumentId: active.id }), !activeImageShape],
          ["Edit Image as a Copy… (Открыть картинку копией…)", "", () => active && void kernel.commands.execute("image.openElsewhereBranch", { activeDocumentId: active.id }), !activeImageShape],
        ]}/>}
        {active?.kind === "raster" && <Menu label="Type (Текст)" language={store.language} open={openMenu === "type"} onToggle={() => setOpenMenu(openMenu === "type" ? null : "type")} items={[
          ["Faux Bold (Псевдо-полужирный)", "", () => toggleActiveTextStyle("bold"), !activeTextLayer],
          ["Faux Italic (Псевдо-курсив)", "", () => toggleActiveTextStyle("italic"), !activeTextLayer],
          ["Underline (Подчёркнутый)", "", () => toggleActiveTextStyle("underline"), !activeTextLayer],
          ["Warp Text… (Деформация текста…)", "", () => {}, true],
          ["Convert to Shape (Преобразовать в фигуру)", "", () => {}, true],
          ["Create Work Path (Создать рабочий контур)", "", () => {}, true],
        ]}/>}
        {active?.kind === "raster" && <Menu label="Filter (Фильтр)" language={store.language} open={openMenu === "filter"} onToggle={() => setOpenMenu(openMenu === "filter" ? null : "filter")} items={[["Filter Gallery… (Галерея фильтров…)", "", () => setFilterGalleryOpen(true), !active || active.kind!=="raster"], ["Camera Raw Filter… (Фильтр Camera Raw…)", "", () => setCameraRawFilterOpen(true), !active || !isRasterDocumentState(active.state)], ["Reprocess Original RAW… (Переобработать исходный RAW…)", "", () => void openCameraRawReprocess(), !activeRawOrigin], ["Liquify… (Пластика…)", "Ctrl+Shift+X", () => setLiquifyOpen(true), !active || !isRasterDocumentState(active.state)], ["Blur Gallery (Галерея размытия)", "", () => setFilterGalleryOpen(true), !active || active.kind!=="raster"], ["Sharpen (Усиление резкости)", "", () => setFilterGalleryOpen(true), !active || active.kind!=="raster"], ["Noise (Шум)", "", () => setFilterGalleryOpen(true), !active || active.kind!=="raster"], ["Stylize (Стилизация)", "", () => setFilterGalleryOpen(true), !active || active.kind!=="raster"]]}/>}
        <Menu label="Plugins (Плагины)" language={store.language} open={openMenu === "plugins"} onToggle={() => setOpenMenu(openMenu === "plugins" ? null : "plugins")} items={[
          ["Manage Plugins… (Управление плагинами…)", "", () => {}, true],
        ]}/>
        <Menu label="Window (Окно)" language={store.language} open={openMenu === "window"} onToggle={() => setOpenMenu(openMenu === "window" ? null : "window")} items={[...windowMenuItems(active?.kind, store.language), ["Settings (Настройки)", "", () => store.setSettingsOpen(true)], ["Command Palette (Палитра команд)", "Ctrl+K", () => store.setPaletteOpen(true)]]}/>
        <Menu label="Help (Справка)" language={store.language} open={openMenu === "help"} onToggle={() => setOpenMenu(openMenu === "help" ? null : "help")} items={[["Diagnostics log (Журнал диагностики)", "", () => setDiagnosticsOpen(true)], ["About VRAVIO (О VRAVIO)", "", () => window.alert("VRAVIO — local-first creative suite")]]}/>
      </nav>
      <input ref={openImageRef} hidden type="file" accept={`image/png,image/jpeg,image/webp,image/gif,image/avif,image/svg+xml,.svg,.psd,.psb,${rawFileExtensions.map((extension) => `.${extension}`).join(",")}`} onChange={(event) => { const file = event.target.files?.[0]; if (file) void importImage(file); event.currentTarget.value = ""; }}/>
      <button className="palette-button" onClick={() => store.setPaletteOpen(true)}>⌘ {store.language === "ru" ? "Команды" : "Commands"} <kbd>Ctrl K</kbd></button>
      <button className="settings-button" onClick={() => store.setSettingsOpen(true)} aria-label={store.language === "ru" ? "Настройки" : "Settings"} title={store.language === "ru" ? "Настройки" : "Settings"}>⚙</button>
    </header>

    {documents.length > 1 && <div className="document-tabs" role="tablist" aria-label="Documents (Документы)">
      {documents.map((document) => <div className="tab-wrap" key={document.id} data-kind={document.kind} data-linked={document.provenance ? "" : undefined}>
        <button role="tab" aria-selected={document.id === store.activeDocumentId} onClick={() => store.activateDocument(document.id)}>
          <EnvironmentIcon kind={document.kind} className="tab-environment-icon" />{localized(document.name, store.language)}{document.dirty && <i>●</i>}
          {/* A tab opened out of another keeps its own result when the parent
              undoes, so the two can end up showing different pictures. Nothing
              else on screen would say why. */}
          {kernel.roundtrip.isOutOfSync(document.id) && <b className="tab-out-of-sync" title={store.language === "ru" ? "Исходный документ показывает не то, что вы применили. Примените ещё раз, чтобы отдать текущую версию." : "The parent document is not showing what you applied. Apply again to send the current version."}>↑</b>}
        </button>
        <button className="tab-close" aria-label={`Close ${document.name}`} onClick={() => store.closeDocument(document.id)}>×</button>
      </div>)}
    </div>}

    <OptionsBar language={store.language} tool={activeTool} pixelsPerInch={active && isRasterDocumentState(active.state) ? active.state.resolution : undefined} values={activeTool ? { ...(store.toolOptions[activeTool.id] ?? {}), ...(activeTool.options.some((option) => option.id === "color") ? { color: effectiveForegroundColor } : {}) } : {}} transform={transformMetrics} onTransformCommit={() => window.dispatchEvent(new Event("vravio-transform-commit"))} onTransformCancel={() => window.dispatchEvent(new Event("vravio-transform-cancel"))} onChange={(id, value) => { if (!activeTool) return; store.setToolOption(activeTool.id, id, value); if (id === "color") { if (editingMaskLayerId && active) store.setMaskForegroundWhite(active.id, String(value).toLowerCase() !== "#000000"); else store.setForegroundColor(String(value)); } }} alignSelectionCount={active && isRasterDocumentState(active.state) ? (selectedLayerIds.length || 1) : 0} onAlign={(edge) => alignOrDistributeLayers("align", edge)} onDistribute={(edge) => alignOrDistributeLayers("distribute", edge)} />

    <main className="workspace" data-has-toolbar={active?.kind === "raster" || active?.kind === "vector"}>
      {(active?.kind === "raster" || active?.kind === "vector") && <aside className="toolbar" aria-label="Tools (Инструменты)">
        <ToolPalette kind={active.kind} language={store.language} activeToolId={activeToolId} openGroup={openToolGroup} onOpenGroup={setOpenToolGroup} onSelect={(toolId) => { store.setTool(active.id, toolId); setOpenToolGroup(null); }} />
        {active.kind === "raster" && <ColorWells foreground={effectiveForegroundColor} background={effectiveBackgroundColor} monochrome={Boolean(editingMaskLayerId)} onForeground={(color) => editingMaskLayerId ? store.setMaskForegroundWhite(active.id, color.toLowerCase() !== "#000000") : store.setForegroundColor(color)} onBackground={(color) => editingMaskLayerId ? store.setMaskForegroundWhite(active.id, color.toLowerCase() === "#000000") : store.setBackgroundColor(color)} onSwap={() => editingMaskLayerId ? store.swapMaskColors(active.id) : store.swapColors()} onReset={() => editingMaskLayerId ? store.setMaskForegroundWhite(active.id, false) : store.resetColors()} />}
      </aside>}
      {active ? <DockLayout /> : <WelcomeScreen language={store.language} requestNewDocument={store.requestNewDocument} />}
    </main>
    <footer className="status-bar"><span>{active ? resolveLabel(environmentMeta[active.kind].label, store.language) : text(store.language, "Ready", "Готово")}</span><span>{active ? `${Math.round((store.viewports[active.id]?.zoom ?? 1) * 100)}% · ` : ""}sRGB · {renderBackend ?? "detecting"}</span></footer>
    {store.preferences.showPerformanceOverlay && <PerformanceOverlay documentId={active?.id ?? null} />}

    {store.paletteOpen && <div className="dialog-backdrop" onMouseDown={() => store.setPaletteOpen(false)}>
      <section className="command-palette" role="dialog" aria-modal="true" aria-label="Command palette (Палитра команд)" onMouseDown={(event) => event.stopPropagation()}>
        <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder={store.language === "ru" ? "Введите команду…" : "Type a command…"} />
        <div>{commands.map((command) => <button key={command.id} disabled={command.isEnabled?.(activeCommandContext()) === false} onClick={() => { void kernel.commands.execute(command.id, activeCommandContext()); store.setPaletteOpen(false); }}><span>{localized(command.label, store.language)}</span>{command.shortcut && <kbd>{command.shortcut}</kbd>}</button>)}</div>
      </section>
    </div>}

    <SettingsDialog />
    <BusyCursor />
    <BusyAnnouncement />
    {diagnosticsOpen && <div className="dialog-backdrop" onMouseDown={() => setDiagnosticsOpen(false)}><section className="diagnostics-dialog" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}><header><strong>Diagnostics log (Журнал диагностики)</strong><button onClick={() => setDiagnosticsOpen(false)}>×</button></header><div className="diagnostics-list">{diagnostics.length ? [...diagnostics].reverse().map((entry, index) => <article data-level={entry.level} key={`${entry.time}-${index}`}><time>{new Date(entry.time).toLocaleTimeString()}</time><b>{entry.area}</b><span>{entry.message}</span>{entry.detail && <pre>{entry.detail}</pre>}</article>) : <p>No events recorded (Событий пока нет).</p>}</div><footer><button onClick={() => { clearDiagnostics(); setDiagnostics([]); }}>Clear (Очистить)</button><button onClick={() => { const blob = new Blob([JSON.stringify(diagnostics, null, 2)], { type: "application/json" }); download(blob, `vravio-diagnostics-${Date.now()}.json`); }}>Export JSON (Экспорт JSON)</button></footer></section></div>}
    {filterGalleryOpen && active && isRasterDocumentState(active.state) && (()=>{const state=active.state;if(!isRasterDocumentState(state))return null;const layer=state.layers.find((item)=>item.id===state.activeLayerId);return layer?<FilterGalleryDialog layer={layer} onApply={applyFilter} onClose={()=>setFilterGalleryOpen(false)}/>:null;})()}
    {liquifyOpen && active && isRasterDocumentState(active.state) && (()=>{const state=active.state;if(!isRasterDocumentState(state))return null;const layer=state.layers.find((item)=>item.id===state.activeLayerId);return layer?<LiquifyDialog layer={layer} language={store.language} onApply={applyFilter} onClose={()=>setLiquifyOpen(false)}/>:null;})()}
    {cameraRawFilterOpen && active && isRasterDocumentState(active.state) && (()=>{const state=active.state;if(!isRasterDocumentState(state))return null;const layer=state.layers.find((item)=>item.id===state.activeLayerId);return layer?<CameraRawFilterDialog layer={layer} language={store.language} onApply={applyFilter} onClose={()=>setCameraRawFilterOpen(false)}/>:null;})()}
    {cameraRawImport && <CameraRawDialog
      buffer={cameraRawImport.buffer}
      filename={cameraRawImport.name}
      language={store.language}
      mode="open"
      onCancel={() => setCameraRawImport(null)}
      onConfirm={async (decoded) => {
        const id = openDecodedRaster(cameraRawImport.name, decoded);
        await kernel.assetsReady;
        const assetId = await kernel.assets.importAsset(new Uint8Array(cameraRawImport.buffer), { kind: "image", mime: "image/x-raw", name: cameraRawImport.name });
        kernel.documents.addAssetRef(id, assetId);
        kernel.documents.setOrigin(id, { kind: "asset", assetId, rev: 0, name: cameraRawImport.name });
        setCameraRawImport(null);
      }}
    />}
    {cameraRawReopen && <CameraRawDialog
      buffer={cameraRawReopen.buffer}
      filename={cameraRawReopen.name}
      language={store.language}
      mode="reprocess"
      onCancel={() => setCameraRawReopen(null)}
      onConfirm={(decoded) => { applyFilter(decoded.pixels, "Camera Raw"); setCameraRawReopen(null); }}
    />}
    {exportOpen && active && isRasterDocumentState(active.state) && <ExportDialog state={active.state} documentName={active.name} language={store.language} onCancel={() => setExportOpen(false)} onExport={async (blob, fileName) => { download(blob, fileName); setExportOpen(false); }}/>}
    {adjustmentDialog && (() => { const document = kernel.documents.get<RasterDocumentState>(adjustmentDialog.documentId), definition = rasterAdjustmentById.get(adjustmentDialog.definitionId), layer = document?.state.layers.find((item) => item.id === adjustmentDialog.layerId); if (!document || !definition || !layer) return null; return <AdjustmentDialog definition={definition} initialValue={adjustmentDialog.initialValue} language={store.language} histogram={luminanceHistogram(layerDocumentPixels(layer, document.state.width, document.state.height))} onPreview={previewImageAdjustment} onCancel={() => { previewImageAdjustment(null); setAdjustmentDialog(null); }} onApply={applyImageAdjustment}/>; })()}
    {store.newDocumentKind && <NewDocumentDialog key={store.newDocumentKind} />}
  </div>;
}

export function physicalShortcutKey(event: KeyboardEvent): string {
  if (/^Key[A-Z]$/.test(event.code)) return event.code.slice(3).toLocaleLowerCase();
  if (/^Digit[0-9]$/.test(event.code)) return event.code.slice(5);
  if (event.code === "BracketLeft") return "[";
  if (event.code === "BracketRight") return "]";
  if (event.code === "Equal" || event.code === "NumpadAdd") return event.shiftKey ? "+" : "=";
  if (event.code === "Minus" || event.code === "NumpadSubtract") return "-";
  if (event.code === "Semicolon") return ";";
  return event.key.toLocaleLowerCase();
}

/**
 * The Window menu's panel list — one per environment, ticked when the panel is
 * on screen.
 *
 * Comes from that environment's own `windows/` catalogue, so a new panel
 * appears here by existing rather than by being listed a second time. An
 * environment with no catalogue gets an empty list, which is the honest answer
 * for audio and video: `MediaWorkspace` is a self-contained editor (bin,
 * transport, clip inspector all built in) with nothing wired to the dockable
 * side panels, so there is genuinely nothing to offer — not raster's list.
 */
function windowMenuItems(kind: string | undefined, language: Language): readonly MainMenuItem[] {
  if (!kind) return [];
  const visible = readVisiblePanelIds(kind);
  return windowsFor(kind).map((panel) => [
    // Resolved to one language here rather than handed over as
    // "English (Русский)" for `localized()` to split: the tick used to be
    // prefixed to the combined string, and `localized()` returns only the
    // parenthesised half, so in Russian it was parsed away and the list had no
    // checkmarks at all — the one thing this list exists to show.
    `${visible.has(panel.id) ? "✓ " : ""}${windowTitle(panel, language)}`,
    "",
    () => requestPanelVisibility(kind, panel.id, !visible.has(panel.id)),
  ] as MainMenuItem);
}

type MainMenuItem = readonly [label: string, shortcut: string, action: () => void, disabled?: boolean];
type MainMenuGroup = { label: string; items: readonly MainMenuItem[] };
const isMainMenuItem = (item: MainMenuItem | MainMenuGroup): item is MainMenuItem => Array.isArray(item);
function Menu({ label, language, open, onToggle, items }: { label: string; language: Language; open: boolean; onToggle(): void; items: readonly (MainMenuItem | MainMenuGroup)[] }) {
  return <div className="main-menu"><button className={open ? "active" : ""} onClick={onToggle}>{localized(label, language)}</button>{open && <div className="main-menu-dropdown">{items.map((item) => isMainMenuItem(item) ? <button key={item[0]} disabled={item[3]} onClick={() => { item[2](); onToggle(); }}><span>{localized(item[0], language)}</span><kbd>{item[1]}</kbd></button> : <div className="main-menu-submenu" key={item.label}><button><span>{localized(item.label, language)}</span><kbd>›</kbd></button><div>{item.items.map(([itemLabel, shortcut, action, disabled]) => <button key={itemLabel} disabled={disabled} onClick={() => { action(); onToggle(); }}><span>{localized(itemLabel, language)}</span><kbd>{shortcut}</kbd></button>)}</div></div>)}</div>}</div>;
}

function ToolGlyph({ tool }: { tool: ToolDefinition }) {
  return tool.iconFile ? <span className="tool-svg-icon" aria-hidden="true" style={{ "--tool-mask": `url("/${tool.iconFile}")` } as CSSProperties} /> : <span>{tool.icon}</span>;
}

function ToolPalette({ kind, language, activeToolId, openGroup, onOpenGroup, onSelect }: { kind: "raster" | "vector"; language: Language; activeToolId: string | undefined; openGroup: string | null; onOpenGroup(group: string | null): void; onSelect(toolId: string): void }) {
  const available = toolsFor(kind);
  const groups = kind === "raster" ? rasterToolGroups.map((ids) => ids.map((id) => toolById(id)).filter((tool): tool is ToolDefinition => Boolean(tool))) : available.map((tool) => [tool]);
  return <>{groups.map((group) => {
    if (!group.length) return null;
    const groupId = group.map((tool) => tool.id).join("|");
    const selected = group.find((tool) => tool.id === activeToolId) ?? group[0]!;
    return <div className="tool-group" key={groupId}>
      <button className={group.some((tool) => tool.id === activeToolId) ? "active" : ""} title={`${resolveLabel(selected.label, language)} [${selected.shortcut}]`} aria-label={resolveLabel(selected.label, language)} onClick={() => onSelect(selected.id)}><ToolGlyph tool={selected} /></button>
      {group.length > 1 && <button className="tool-group-arrow" aria-label={language === "ru" ? "Показать группу инструментов" : "Show tool group"} onClick={() => onOpenGroup(openGroup === groupId ? null : groupId)}>▾</button>}
      {openGroup === groupId && <div className="tool-flyout">{group.map((tool) => <button key={tool.id} className={tool.id === activeToolId ? "active" : ""} onClick={() => onSelect(tool.id)}><ToolGlyph tool={tool} /><span>{resolveLabel(tool.label, language)}</span><kbd>{tool.shortcut}</kbd></button>)}</div>}
    </div>;
  })}</>;
}

function WelcomeScreen({ language, requestNewDocument }: { language: Language; requestNewDocument(kind: EnvironmentKind): void }) {
  return <div className="welcome"><div className="welcome-inner">
    <div className="welcome-hero">
      <p className="eyebrow">{text(language, "LOCAL-FIRST CREATIVE SUITE", "ЛОКАЛЬНАЯ ТВОРЧЕСКАЯ СРЕДА")}</p>
      <h1>{text(language, "One project.", "Один проект.")} {text(language, "Every medium.", "Любая среда.")}</h1>
      <p className="lead">{text(language, "Create a document to enter a workspace. Assets, revisions, history and commands stay shared across every environment.", "Создайте документ и начните работу. Ассеты, версии, история и команды остаются общими для всех сред.")}</p>
    </div>
    <div className="environment-grid">
      {(Object.entries(environmentMeta) as [keyof typeof environmentMeta, (typeof environmentMeta)[keyof typeof environmentMeta]][]).map(([kind, meta]) => <button key={kind} data-kind={kind} onClick={() => requestNewDocument(kind)}>
        <span className="environment-glow" aria-hidden="true"/>
        <EnvironmentIcon kind={kind} className="welcome-environment-icon" />
        <strong>{resolveLabel(meta.label, language)}</strong>
        <small>{language === "ru" ? meta.descriptionRu : meta.description}</small>
      </button>)}
    </div>
  </div></div>;
}

function ColorWells({ foreground, background, monochrome = false, onForeground, onBackground, onSwap, onReset }: { foreground: string; background: string; monochrome?: boolean; onForeground(color: string): void; onBackground(color: string): void; onSwap(): void; onReset(): void }) {
  return <div className={`color-wells${monochrome ? " mask-colors" : ""}`} title={monochrome ? "Layer mask colors: black hides, white reveals (Цвета маски: чёрный скрывает, белый показывает)" : "Foreground / Background (Основной / дополнительный цвет)"}>
    <label className="background-color" style={{ "--swatch": background } as CSSProperties}><input type="color" value={background} onChange={(event) => onBackground(event.target.value)} aria-label="Background color (Дополнительный цвет)" /><span /></label>
    <label className="foreground-color" style={{ "--swatch": foreground } as CSSProperties}><input type="color" value={foreground} onChange={(event) => onForeground(event.target.value)} aria-label="Foreground color (Основной цвет)" /><span /></label>
    <button className="swap-colors" onClick={onSwap} title="Swap colors [X]" aria-label="Swap colors">↔</button>
    <button className="reset-colors" onClick={onReset} title="Default colors [D]" aria-label="Default colors"><i/><i/></button>
  </div>;
}

const alignButtons: Array<[AlignEdge, string, string]> = [
  ["left", "ПО ЛЕВОМУ КРАЮ.svg", "Align left edges (Выровнять по левому краю)"],
  ["centerH", "ПО ЦЕНРУ ГОР.svg", "Align horizontal centers (Выровнять по горизонтали по центру)"],
  ["right", "ПО ПРАВОМУ КРАЮ.svg", "Align right edges (Выровнять по правому краю)"],
  ["top", "ПО ВЕРХНЕМУ КРАЮ ГОР.svg", "Align top edges (Выровнять по верхнему краю)"],
  ["centerV", "ПО ЦЕНРУ ВЕРТ.svg", "Align vertical centers (Выровнять по вертикали по центру)"],
  ["bottom", "ПО НИЖНЕМУ КРАЮ.svg", "Align bottom edges (Выровнять по нижнему краю)"],
];
const distributeButtons: Array<[AlignEdge, string, string]> = [
  ["centerH", "РАСТОЯНИЕ РАВНОЕ ГОР.svg", "Distribute horizontal centers (Равное расстояние по горизонтали)"],
  ["centerV", "РАСТОЯНИЕ РАВНОЕ.svg", "Distribute vertical centers (Равное расстояние по вертикали)"],
];

function AlignDistributeBar({ selectionCount, onAlign, onDistribute }: { selectionCount: number; onAlign(edge: AlignEdge): void; onDistribute(edge: AlignEdge): void }) {
  const canAlign = selectionCount >= 1, canDistribute = selectionCount >= 3;
  return <div className="align-bar">
    {alignButtons.map(([edge, icon, title]) => <button key={edge} disabled={!canAlign} title={title} aria-label={title} onClick={() => onAlign(edge)}><i style={{ "--icon-mask": `url("/${icon}")` } as CSSProperties}/></button>)}
    <span className="align-bar-sep"/>
    {distributeButtons.map(([edge, icon, title]) => <button key={edge} disabled={!canDistribute} title={title} aria-label={title} onClick={() => onDistribute(edge)}><i style={{ "--icon-mask": `url("/${icon}")` } as CSSProperties}/></button>)}
  </div>;
}

function OptionsBar({ language, tool, values, transform, pixelsPerInch, onTransformCommit, onTransformCancel, onChange, alignSelectionCount, onAlign, onDistribute }: { language: Language; tool: ReturnType<typeof toolById>; values: Record<string, string | number | boolean>; transform: { active: boolean; x: number; y: number; width: number; height: number; rotation: number } | null; pixelsPerInch?: number | undefined; onTransformCommit(): void; onTransformCancel(): void; onChange(id: string, value: string | number | boolean): void; alignSelectionCount: number; onAlign(edge: AlignEdge): void; onDistribute(edge: AlignEdge): void }) {
  if (transform?.active) return <div className="options-bar transform-options"><strong>Free Transform (Свободная трансформация)</strong><label>X:<input value={Math.round(transform.x)} readOnly/></label><label>Y:<input value={Math.round(transform.y)} readOnly/></label><label>W:<input value={Math.round(transform.width)} readOnly/></label><label>H:<input value={Math.round(transform.height)} readOnly/></label><label>∠:<input value={`${Math.round(transform.rotation * 10) / 10}°`} readOnly/></label><button title="Cancel (Отмена)" onClick={onTransformCancel}>×</button><button className="commit" title="Commit (Подтвердить)" onClick={onTransformCommit}>✓</button></div>;
  return <div className="options-bar"><strong>{tool ? resolveLabel(tool.label, language) : text(language, "Tool options", "Параметры инструмента")}</strong>{tool ? tool.options.map((option) => <OptionRow key={option.id} language={language} option={option} pixelsPerInch={pixelsPerInch} value={values[option.id] ?? option.defaultValue} onChange={(value) => onChange(option.id, value)} />) : <span className="muted">{language === "ru" ? "Выберите или создайте документ" : "Select or create a document"}</span>}{tool?.id === "raster.move" && <AlignDistributeBar selectionCount={alignSelectionCount} onAlign={onAlign} onDistribute={onDistribute}/>}</div>;
}


