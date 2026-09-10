import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { WARP_PRESETS, confineToSelection, cropRasterDocument, decodePsd, defaultAdjustment, findSmartCrop, layerDocumentPixels, setLayerPixels, compositeRasterDocument, computeAlignOffsets, computeDistributeOffsets, createRasterLayer, isRasterDocumentState, layerContentBounds, translateLayerPixels, type AlignEdge, type RasterAdjustment, type RasterDocumentState, type RasterRect } from "@vravio/env-raster";
import { maskToRgba, rgbaToMask } from "./raster-pixel-buffers";
import { BusyAnnouncement, BusyCursor } from "./BusyCursor";
import { withBusyPainted } from "./busy";
import { interfacePaletteForTheme, useShellStore, type Language } from "./store";
import type { EnvironmentKind, RenderBackend } from "@vravio/kernel";
import { CLEAN_CANVAS_EVENT, DockLayout } from "./DockLayout";
import { environmentMeta } from "./environment";
import { toolById, toolsFor, type ToolDefinition, type ToolOption } from "./tools";
import { smartCropRatios } from "./environments/raster/commands/definitions/smart-crop";
import { pluginsFor } from "./plugins/registry";
import { PLUGIN_RUN_EVENT } from "./plugins/usePluginRuns";
import { readToolbarLayout, TOOLBAR_CHANGED_EVENT } from "./toolbar/layout";
import { useDocuments } from "./useDocuments";
import { activeCommandContext, ensureCommandsRegistered } from "./commands";
import { kernel } from "./kernel";
import { closeWindow, isDesktop, minimizeWindow, toggleMaximizeWindow } from "./desktop-window";
import { EnvironmentIcon } from "./EnvironmentIcon";
import { localized, resolveLabel, text } from "./i18n";
import { useCloseOnOutsideClick } from "./useCloseOnOutsideClick";
import { OptionRow } from "./ui/molecules/OptionRow";
import { SettingsDialog } from "./SettingsDialog";
import { ModalHost } from "./modals/ModalHost";
import { errorModal, openModal } from "./modals/runtime";
import { clearDiagnostics, diagnostic, readDiagnostics, type DiagnosticEntry } from "./diagnostics";
import { FilterGalleryDialog } from "./FilterGalleryDialog";
import { LiquifyDialog } from "./LiquifyDialog";
import { rawExtensionOf, rawFileExtensions, type DecodedRaw } from "./rawDecode";
import { CameraRawDialog } from "./CameraRawDialog";
import { CameraRawFilterDialog } from "./CameraRawFilterDialog";
import { ExportDialog } from "./ExportDialog";
import { PrintDialog } from "./PrintDialog";
import { ContextualBar } from "./ContextualBar";
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
import { applyPathfinderOp, attachActiveTextToPath, convertActiveTextToOutlines, createSymbolFromActiveSelection, detachActiveTextFromPath, detachActiveVectorInstance, duplicateActiveVectorShape, deleteActiveVectorShapes, groupActiveVectorShapes, reorderActiveVectorShape, ungroupActiveVectorGroup } from "./vector-commands";
import { importedShapesFromJson, isVectorDocumentState, type VectorDocumentState } from "@vravio/env-vector";
import { exportVectorDocumentToSvg } from "./vector-svg-export";
import { vectorTextMeasurer } from "./vector-text-metrics";
import { importSvgToJson } from "./vector-svg-wasm";
import { luminanceHistogram } from "./raster-adjustments/histogram";
import { HomeScreen } from "./bridge/HomeScreen";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { applyWorkspacePreset, resetWorkspacePreset, selectedWorkspacePreset, workspacePresetsFor } from "./workspace-presets";
import { decodeAudioFileToWav } from "./audioImport";
import { decodeWav, isAudioDocumentState } from "@vravio/env-audio";
import { addClipFromAsset as addAudioClipFromAsset } from "./audio-commands";
import { probeVideoMetadata } from "./videoImport";
import { addClipFromAsset as addVideoClipFromAsset } from "./video-commands";
import { isVideoDocumentState } from "@vravio/env-video";
import "./styles.css";

export function App() {
  ensureCommandsRegistered();
  const store = useShellStore();
  const documents = useDocuments();
  const [query, setQuery] = useState("");
  const [openToolGroup, setOpenToolGroup] = useState<string | null>(null);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [cleanCanvas, setCleanCanvas] = useState(false);
  const openImageRef = useRef<HTMLInputElement>(null);
  const importSvgAsVectorRef = useRef<HTMLInputElement>(null);
  const [transformMetrics, setTransformMetrics] = useState<{ active: boolean; x: number; y: number; width: number; height: number; rotation: number; warp?: boolean } | null>(null);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [diagnostics, setDiagnostics] = useState<DiagnosticEntry[]>([]);
  const [filterGalleryOpen, setFilterGalleryOpen] = useState(false);
  const [liquifyOpen, setLiquifyOpen] = useState(false);
  const [cameraRawFilterOpen, setCameraRawFilterOpen] = useState(false);
  const [cameraRawImport, setCameraRawImport] = useState<{ buffer: ArrayBuffer; name: string } | null>(null);
  const [cameraRawReopen, setCameraRawReopen] = useState<{ buffer: ArrayBuffer; name: string } | null>(null);
  const [renderBackend, setRenderBackend] = useState<RenderBackend | null>(kernel.gpu.active);
  const [exportOpen, setExportOpen] = useState(false);
  const [printOpen, setPrintOpen] = useState(false);
  // `targetsMask`: a mask is a layer too (CLAUDE.md's own recurring theme) — an adjustment
  // opened while a mask is being edited (`editingMaskLayerId`, the same state the color-swap
  // shortcuts below already special-case) must land on that mask's own grayscale buffer, not
  // silently fall through to the pixel layer underneath it. Captured once at open time, not
  // re-read live, so switching which mask is being edited mid-dialog doesn't retarget an
  // already-open preview.
  const [adjustmentDialog, setAdjustmentDialog] = useState<{ documentId: string; layerId: string; targetsMask: boolean; definitionId: RasterAdjustment["kind"]; initialValue: RasterAdjustment } | null>(null);
  const [, setPanelRevision] = useState(0);
  const active = documents.find((document) => document.id === store.activeDocumentId) ?? null;
  const activeToolId = active ? store.activeToolByDocument[active.id] : undefined;
  const activeTool = toolById(activeToolId);
  const activeRawOrigin = active?.origin?.kind === "asset" && kernel.assets.get(active.origin.assetId)?.mime === "image/x-raw" ? active.origin : null;
  const commands = useMemo(() => kernel.commands.search(query), [query]);
  // Every accent-colored control in the app (active toolbar buttons, checkboxes'
  // native accent-color, sliders, outlines — anywhere styles.css reads var(--focus))
  // is driven from this one variable, so tinting it to the active document's own
  // environment color here is the one change that reaches all of them, rather than
  // touching each of those rules individually. `environmentColorByKind` is the single
  // place a future environment (if VRAVIO ever grows past the kernel's current fixed
  // raster/vector/audio/video set) would need one more entry to pick up the same
  // auto-tinting and its own row in Settings' color grid — not a speculative system
  // built ahead of that need, just the one lookup this rule already goes through.
  const environmentColorByKind: Record<EnvironmentKind, string> = { raster: store.preferences.rasterColor, vector: store.preferences.vectorColor, audio: store.preferences.audioColor, video: store.preferences.videoColor };
  const interfacePalette = store.preferences.interfacePalette ?? interfacePaletteForTheme(store.theme);
  const customInterfaceStyle: Record<string, string> = store.preferences.useCustomInterfacePalette ? { "--bg": interfacePalette.background, "--surface": interfacePalette.surface, "--surface2": interfacePalette.raisedSurface, "--surface3": interfacePalette.hoverSurface, "--border": interfacePalette.border, "--text": interfacePalette.text, "--muted": interfacePalette.mutedText, "--success": interfacePalette.success, "--warning": interfacePalette.warning, "--danger": interfacePalette.danger } : {};
  const themeStyle = { "--focus": active ? environmentColorByKind[active.kind] : store.preferences.focusColor, "--raster": store.preferences.rasterColor, "--vector": store.preferences.vectorColor, "--audio": store.preferences.audioColor, "--video": store.preferences.videoColor, "--canvas-surround": store.preferences.canvasSurround, "--guide": store.preferences.guideColor, ...customInterfaceStyle } as CSSProperties & Record<string, string>;

  const openDecodedRaster = (name: string, decoded: DecodedRaw): string => {
    store.openDocument("raster", { name, width: decoded.width, height: decoded.height, resolution: 72, resolutionUnit: "ppi", backgroundColor: null, pixelAspectRatio: 1 });
    const id = useShellStore.getState().activeDocumentId!;
    kernel.documents.update<RasterDocumentState>(id, (state) => { setLayerPixels(state.layers[0]!, decoded.pixels, state.width, state.height); });
    return id;
  };

  const importPsd = async (file: File) => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let result: ReturnType<typeof decodePsd>;
    try { result = decodePsd(bytes); } catch (error) {
      // Recorded *and* said out loud. Recording alone meant dropping a corrupt
      // PSD on the window did nothing visible at all: no document, no message,
      // and the reason only in a log behind the Help menu.
      const because = error instanceof Error ? error.message : String(error);
      diagnostic("error", "file.import", `Could not decode ${file.name}: ${because}`);
      errorModal({ title: text(store.language, "Could not open the file", "Не удалось открыть файл"), message: text(store.language, `"${file.name}" is not a Photoshop file this build can read.`, `«${file.name}» — не тот файл Photoshop, который эта сборка умеет читать.`), detail: because });
      return;
    }
    for (const warning of result.warnings) diagnostic("warn", "file.import", warning);
    store.openDocument("raster", { name: file.name, width: result.document.width, height: result.document.height, resolution: 72, resolutionUnit: "ppi", backgroundColor: null, pixelAspectRatio: 1 });
    const id = useShellStore.getState().activeDocumentId; if (!id) return;
    kernel.documents.update<RasterDocumentState>(id, (state) => { state.layers = result.document.layers; state.activeLayerId = result.document.activeLayerId; });
  };

  /**
   * Stage 10 of docs/vector-plan.md: a *separate* action from the regular
   * `importImage` picker, deliberately — `.svg` is already a valid input
   * there, rasterized onto a new raster document (`decodeImportedImage`),
   * and that existing behavior stays the default for "open this picture."
   * "Open this SVG as editable vector shapes" is a different intent a user
   * has to ask for on purpose, not a silent change to what `.svg` already
   * means everywhere else in the app.
   */
  const importSvgAsVector = async (file: File) => {
    const svgText = await file.text();
    let shapes: ReturnType<typeof importedShapesFromJson>;
    try {
      shapes = importedShapesFromJson(await importSvgToJson(svgText));
    } catch (error) {
      const because = error instanceof Error ? error.message : String(error);
      diagnostic("error", "file.import", `Could not import ${file.name} as vector: ${because}`);
      errorModal({ title: text(store.language, "Could not import the file", "Не удалось импортировать файл"), message: text(store.language, `"${file.name}" is not an SVG this build can parse.`, `«${file.name}» — не тот SVG, который эта сборка умеет разобрать.`), detail: because });
      return;
    }
    // The new document's canvas is sized from the source file's own
    // width/height or viewBox — not `usvg`'s resolved shape geometry — so
    // the imported picture lands at the size its own markup actually
    // declares, the same size it would open at anywhere else.
    const viewBoxMatch = svgText.match(/viewBox=["']\s*[\d.+-]+\s+[\d.+-]+\s+([\d.]+)\s+([\d.]+)/);
    const widthMatch = svgText.match(/<svg[^>]*\swidth=["']([\d.]+)/);
    const heightMatch = svgText.match(/<svg[^>]*\sheight=["']([\d.]+)/);
    const width = Number(widthMatch?.[1] ?? viewBoxMatch?.[1]) || 1280;
    const height = Number(heightMatch?.[1] ?? viewBoxMatch?.[2]) || 720;
    store.openDocument("vector", { name: file.name, width, height, resolution: 72, resolutionUnit: "ppi", backgroundColor: null, pixelAspectRatio: 1 });
    const id = useShellStore.getState().activeDocumentId; if (!id) return;
    kernel.documents.update<VectorDocumentState>(id, (state) => {
      // Not `addShape` per shape: it forces `parentId: null` unconditionally,
      // which would flatten the very group hierarchy `importedShapesFromJson`
      // just reconstructed. Its own `parentId`/`orderKey` on every returned
      // shape are already correct for a brand-new, empty document.
      state.shapes.push(...shapes);
      state.selection = shapes.filter((shape) => shape.parentId === null).map((shape) => shape.id);
    });
  };

  const importImage = async (file: File) => {
    const extension = rawExtensionOf(file.name);
    if (extension && (rawFileExtensions as readonly string[]).includes(extension)) {
      setCameraRawImport({ buffer: await file.arrayBuffer(), name: file.name });
      return;
    }
    if (extension === "psd" || extension === "psb") { await importPsd(file); return; }
    const source = await decodeImportedImage(file);
    if (!source) {
      diagnostic("error", "file.import", `Could not decode ${file.name}`);
      errorModal({ title: text(store.language, "Could not open the file", "Не удалось открыть файл"), message: text(store.language, `"${file.name}" is not an image this build can read.`, `«${file.name}» — не то изображение, которое эта сборка умеет читать.`) });
      return;
    }
    store.openDocument("raster", { name: file.name, width: source.width, height: source.height, resolution: 72, resolutionUnit: "ppi", backgroundColor: null, pixelAspectRatio: 1 });
    const id = useShellStore.getState().activeDocumentId; if (!id) return;
    const surface = window.document.createElement("canvas"); surface.width = source.width; surface.height = source.height; const context = surface.getContext("2d"); if (!context) return; context.drawImage(source.image, 0, 0, source.width, source.height); source.release();
    kernel.documents.update<RasterDocumentState>(id, (state) => { setLayerPixels(state.layers[0]!, context.getImageData(0, 0, state.width, state.height).data, state.width, state.height); });
  };

  // The home browser is intentionally not a second importer. It only routes a
  // file to the environment that already owns its decoding and document setup.
  const openBridgeFile = async (file: File): Promise<void> => {
    const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
    if (extension === "svg") { await importSvgAsVector(file); return; }
    if (["mp3", "wav", "flac", "ogg", "aac", "m4a"].includes(extension) || file.type.startsWith("audio/")) {
      const wav = await decodeAudioFileToWav(file);
      if (!wav) throw new Error(text(store.language, "This audio format could not be decoded by this browser.", "Этот аудиоформат не удалось декодировать в текущем браузере."));
      const decoded = decodeWav(wav);
      store.openDocument("audio", { name: file.name, width: 1, height: 1, resolution: 72, resolutionUnit: "ppi", backgroundColor: null, pixelAspectRatio: 1, sampleRate: decoded.sampleRate, channels: decoded.channelData.length, audioBitDepth: 32 });
      const documentId = useShellStore.getState().activeDocumentId;
      if (!documentId) return;
      const assetId = await kernel.assets.importAsset(wav, { kind: "audio", mime: "audio/wav", name: file.name });
      await addAudioClipFromAsset(documentId, assetId, file.name, decoded.channelData[0]?.length ?? 0, decoded.sampleRate);
      return;
    }
    if (["mp4", "mov", "mkv", "webm", "avi"].includes(extension) || file.type.startsWith("video/")) {
      const frameRate = 30;
      const meta = await probeVideoMetadata(file, frameRate);
      if (!meta) throw new Error(text(store.language, "This video format could not be read by this browser.", "Этот видеоформат не удалось прочитать в текущем браузере."));
      store.openDocument("video", { name: file.name, width: meta.width, height: meta.height, resolution: 72, resolutionUnit: "ppi", backgroundColor: "#000000", pixelAspectRatio: 1, frameRate });
      const documentId = useShellStore.getState().activeDocumentId;
      if (!documentId) return;
      const assetId = await kernel.assets.importAsset(file, { kind: "video", mime: file.type || "video/mp4", name: file.name, meta: meta as unknown as Record<string, unknown> });
      await addVideoClipFromAsset(documentId, assetId, file.name, meta.durationFrames, meta.frameRate, "video", undefined, 0, meta.width, meta.height);
      return;
    }
    await importImage(file);
  };
  const download = (blob: Blob, name: string) => { void kernel.platform.fs.saveFile({ name, mime: blob.type || "application/octet-stream", data: blob }).catch((error) => diagnostic("error", "file.save", error instanceof Error ? error.message : String(error), error)); };
  /** Stage 10 of docs/vector-plan.md: the whole export pipeline is a pure
   * function (`exportVectorDocumentToSvg`) plus this one line of platform
   * glue — the same `saveFile` port every other export in this file
   * already goes through, not a bespoke vector-only save path. */
  const exportActiveVectorAsSvg = () => {
    if (!active || !isVectorDocumentState(active.state)) return;
    const svg = exportVectorDocumentToSvg(active.state, undefined, vectorTextMeasurer);
    const name = `${active.name.replace(/\s*\([^()]*\)\s*$/, "").replace(/\.[^.]+$/, "").trim() || "untitled"}.svg`;
    download(new Blob([svg], { type: "image/svg+xml" }), name);
  };
  const projectFileName = (name: string) => `${name.replace(/\s*\([^()]*\)\s*$/, "").replace(/\.[^.]+$/, "").trim() || "untitled"}.vravio.json`;
  const projectBlob = () => { const replacer = (_key: string, value: unknown) => value instanceof Uint8ClampedArray ? { __type: "Uint8ClampedArray", data: Array.from(value) } : value; return new Blob([JSON.stringify(active?.state, replacer)], { type: "application/json" }); };
  /** Save writes through the platform port and clears the dirty flag; Save a Copy deliberately leaves it set. */
  const saveProject = async (markClean = true) => {
    if (!active) return;
    try {
      await kernel.platform.fs.saveFile({ name: projectFileName(active.name), mime: "application/json", data: projectBlob() });
      if (markClean) kernel.documents.markSaved(active.id);
    } catch (error) {
      const because = error instanceof Error ? error.message : String(error);
      diagnostic("error", "file.save", because, error);
      // A save that failed silently is the worst of the three: the user walks
      // away believing the work is on disk.
      errorModal({ title: text(store.language, "Could not save", "Не удалось сохранить"), message: text(store.language, "The project was not written to disk. Nothing has been lost — try saving again, or to a different location.", "Проект не записан на диск. Ничего не потеряно — попробуйте сохранить ещё раз или в другое место."), detail: because });
    }
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
  const pathfinderDisabled = !active || !isVectorDocumentState(active.state) || active.state.selection.length < 2;
  const activeTextShape = (() => { if (!active || !isVectorDocumentState(active.state)) return false; const state = active.state; return state.shapes.find((shape) => shape.id === state.activeShapeId)?.kind === "text"; })();
  // "Attach to Path" needs exactly one text shape and one top-level path
  // shape selected together — same "two shapes selected" reading Pathfinder
  // above already uses. "Detach" only needs the active shape to actually
  // be following one right now.
  const attachToPathDisabled = (() => {
    if (!active || !isVectorDocumentState(active.state)) return true;
    const state = active.state;
    const selected = state.selection.map((id) => state.shapes.find((shape) => shape.id === id)).filter((shape) => shape !== undefined);
    return !selected.some((shape) => shape.kind === "text") || !selected.some((shape) => shape.kind === "path" && shape.parentId === null);
  })();
  const detachFromPathDisabled = (() => {
    if (!active || !isVectorDocumentState(active.state)) return true;
    const state = active.state;
    const shape = state.shapes.find((item) => item.id === state.activeShapeId);
    return !(shape?.kind === "text" && shape.pathShapeId);
  })();
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
    // A mask being edited takes the adjustment, not the pixel layer it belongs to — the same
    // targeting `editingMaskLayerId` already gives the color-swap shortcuts and the brush.
    if (editingMaskLayerId) {
      const layer = state.layers.find((item) => item.id === editingMaskLayerId);
      if (!layer?.mask) { diagnostic("warn", "adjustment.open", "No mask being edited", { layerId: editingMaskLayerId }); return; }
      setAdjustmentDialog({ documentId: active.id, layerId: layer.id, targetsMask: true, definitionId: definition.id, initialValue: defaultAdjustment(definition.id) });
      return;
    }
    const layer = state.layers.find((item) => item.id === state.activeLayerId);
    if (!layer || layer.kind !== "pixel") { diagnostic("warn", "adjustment.open", "Direct adjustments require an editable pixel layer", { layerId: layer?.id, kind: layer?.kind }); return; }
    setAdjustmentDialog({ documentId: active.id, layerId: layer.id, targetsMask: false, definitionId: definition.id, initialValue: defaultAdjustment(definition.id) });
  };

  // Recompositing the whole document (compositeRasterDocument — "over a
  // second on a large multi-layer document" by its own doc comment, tiled
  // down from there but still real work) used to run synchronously inside
  // this function, once per `onChange` — and a dragged slider or a scrubbed
  // NumberBox can fire that many times inside a single animation frame, each
  // one blocking the main thread in turn. Found live: dragging any
  // adjustment's slider (Levels, Curves, brightness — all of them, since
  // they all go through this one function) stalled hard. `RasterWorkspace`'s
  // own `schedulePreview` already solves exactly this for brush strokes by
  // coalescing to one `requestAnimationFrame` callback; this is that same
  // pattern applied here instead of a second, independent throttle.
  const adjustmentPreviewFrameRef = useRef<{ frame: number; value: RasterAdjustment | null } | null>(null);
  const runImageAdjustmentPreview = (value: RasterAdjustment | null) => {
    if (!adjustmentDialog) return;
    const document = kernel.documents.get<RasterDocumentState>(adjustmentDialog.documentId); if (!document || !isRasterDocumentState(document.state)) return;
    if (!value) { window.dispatchEvent(new CustomEvent("vravio-raster-preview", { detail: { documentId: document.id, pixels: null } })); return; }
    const target = document.state.layers.find((layer) => layer.id === adjustmentDialog.layerId); if (!target) return;
    if (adjustmentDialog.targetsMask) {
      if (!target.mask) return;
      // A mask is single-channel grayscale, not RGBA — `maskToRgba` gives `adjustedPixels` (built
      // for layer pixels) an R=G=B view to run the same adjustment math against, `rgbaToMask`
      // collapses the result back to one channel per pixel.
      const before = maskToRgba(target.mask.pixels), confined = adjustedPixels(before, value, document.state.selection);
      const layers = document.state.layers.map((layer) => layer.id === target.id ? { ...layer, mask: { ...layer.mask!, pixels: rgbaToMask(confined) } } : layer);
      window.dispatchEvent(new CustomEvent("vravio-raster-preview", { detail: { documentId: document.id, pixels: compositeRasterDocument({ ...document.state, layers }) } }));
      return;
    }
    const before = layerDocumentPixels(target, document.state.width, document.state.height), confined = adjustedPixels(before, value, document.state.selection);
    const layers = document.state.layers.map((layer) => layer.id === target.id ? { ...layer, pixels: layer.pixels.slice(), effects: structuredClone(layer.effects) } : layer);
    const previewState = { ...document.state, layers }; const previewLayer = layers.find((layer) => layer.id === target.id)!; setLayerPixels(previewLayer, confined, previewState.width, previewState.height);
    window.dispatchEvent(new CustomEvent("vravio-raster-preview", { detail: { documentId: document.id, pixels: compositeRasterDocument(previewState) } }));
  };
  const previewImageAdjustment = (value: RasterAdjustment | null) => {
    // Clearing the preview (dialog closing/cancelling) is a discrete action,
    // not a rapid-fire scrub — that one always runs immediately, cancelling
    // whatever stale frame was still pending so it cannot land after this
    // and repaint the preview it was just told to clear.
    if (!value) {
      if (adjustmentPreviewFrameRef.current) { cancelAnimationFrame(adjustmentPreviewFrameRef.current.frame); adjustmentPreviewFrameRef.current = null; }
      runImageAdjustmentPreview(null);
      return;
    }
    const pending = adjustmentPreviewFrameRef.current;
    if (pending) { pending.value = value; return; }
    const entry = { frame: 0, value };
    adjustmentPreviewFrameRef.current = entry;
    entry.frame = requestAnimationFrame(() => {
      adjustmentPreviewFrameRef.current = null;
      runImageAdjustmentPreview(entry.value);
    });
  };

  const applyImageAdjustment = (value: RasterAdjustment) => {
    if (!adjustmentDialog) return;
    const document = kernel.documents.get<RasterDocumentState>(adjustmentDialog.documentId); if (!document || !isRasterDocumentState(document.state)) return;
    const target = document.state.layers.find((layer) => layer.id === adjustmentDialog.layerId); if (!target) return;
    const definition = rasterAdjustmentById.get(value.kind), history = kernel.historyByDocument.get(document.id);
    if (adjustmentDialog.targetsMask) {
      if (!target.mask) return;
      const before = maskToRgba(target.mask.pixels), confined = adjustedPixels(before, value, document.state.selection);
      const beforeMask = target.mask.pixels.slice(), afterMask = rgbaToMask(confined);
      const assignMask = (pixels: Uint8ClampedArray) => { kernel.documents.update<RasterDocumentState>(document.id, (state) => { const layer = state.layers.find((item) => item.id === target.id); if (layer?.mask) layer.mask.pixels = pixels; }); };
      if (history) void history.execute({ label: `Mask Adjustment: ${definition?.name.en ?? value.kind}`, memoryEstimate: beforeMask.byteLength + afterMask.byteLength, redo: () => assignMask(afterMask), undo: () => assignMask(beforeMask) }); else assignMask(afterMask);
      previewImageAdjustment(null); setAdjustmentDialog(null);
      return;
    }
    if (target.kind !== "pixel") return;
    const before = layerDocumentPixels(target, document.state.width, document.state.height).slice(), confined = adjustedPixels(before, value, document.state.selection);
    const assign = (pixels: Uint8ClampedArray) => { kernel.documents.update<RasterDocumentState>(document.id, (state) => { const layer = state.layers.find((item) => item.id === target.id); if (layer) setLayerPixels(layer, pixels, state.width, state.height); }); };
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

  // docs/master-plan.md §8.3: every custom dropdown (the top File/Edit/…
  // menus and the toolbar's tool-group flyouts) only ever closed by
  // clicking the exact button that opened it — there was no outside-click
  // handler anywhere in the codebase for either one, confirmed by grepping
  // for `document.addEventListener` before writing this. `.closest()` still
  // matches the toggle button itself and anything inside the open dropdown,
  // so their own onClick handlers (which already toggle/act-then-close) run
  // exactly as before. Shared `useCloseOnOutsideClick` — see its own
  // comment for why this is a hook and not another one-off effect: a
  // second dropdown (DockLayout.tsx's adjustment-layer list) already
  // needed the identical fix once this one shipped.
  useCloseOnOutsideClick(openMenu !== null, ".main-menu", () => setOpenMenu(null));
  useCloseOnOutsideClick(openToolGroup !== null, ".tool-group", () => setOpenToolGroup(null));

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
    const openPrint = () => setPrintOpen(true);
    const openFile = () => openImageRef.current?.click();
    const openLiquify = () => { if (active && isRasterDocumentState(active.state)) setLiquifyOpen(true); };
    const openAdjustment = (event: Event) => { const definition = rasterAdjustmentById.get((event as CustomEvent<{ kind: RasterAdjustment["kind"] }>).detail.kind); if (definition) openImageAdjustment(definition); };
    // Save As and Save both go through the platform picker, so they share a handler until
    // the web build can remember a file handle to write back to silently.
    window.addEventListener("vravio-file-save", save);
    window.addEventListener("vravio-file-save-as", save);
    window.addEventListener("vravio-file-save-copy", saveCopy);
    window.addEventListener("vravio-file-export", openExport);
    window.addEventListener("vravio-file-print", openPrint);
    window.addEventListener("vravio-file-open", openFile);
    window.addEventListener("vravio-liquify-open", openLiquify);
    window.addEventListener("vravio-adjustment-open", openAdjustment);
    return () => {
      window.removeEventListener("vravio-file-save", save);
      window.removeEventListener("vravio-file-save-as", save);
      window.removeEventListener("vravio-file-save-copy", saveCopy);
      window.removeEventListener("vravio-file-export", openExport);
      window.removeEventListener("vravio-file-print", openPrint);
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
      const scopes = active ? ["global", active.kind] : ["global"];
      let mappedCommand = kernel.keymap.resolve(event, scopes);
      // Photoshop treats a bare Backspace as Delete's alias on Windows — the
      // owner's own reference table: "Backspace — то же самое, что Delete в
      // большинстве случаев". Left unbound (the catalogue carries one shortcut
      // per command, and Delete already holds that slot for `layer.clear` —
      // see its own comment on why Backspace isn't just bound there too), a
      // bare Backspace with focus outside any input falls straight through to
      // the browser's native default action: navigate back, which an SPA
      // "handles" by silently reloading and restoring whatever the last
      // autosave snapshot happens to be — found live, chasing what looked
      // like a random document swap. Resolved by retrying as Delete's own
      // binding rather than a second copy of it, so the two can never drift
      // apart; modified Backspace (Alt/Ctrl+Backspace) is untouched; those are
      // Fill's own separate bindings (fill-shortcuts.ts).
      if (!mappedCommand && event.key === "Backspace" && !event.ctrlKey && !event.metaKey && !event.altKey) {
        mappedCommand = kernel.keymap.resolve({ code: "Delete", key: "Delete", ctrlKey: false, metaKey: false, altKey: false, shiftKey: event.shiftKey }, scopes);
      }
      if ((!editing || mappedCommand === "view.commandPalette") && mappedCommand) {
        event.preventDefault();
        void kernel.commands.execute(mappedCommand, { ...activeCommandContext(), shiftKey: event.shiftKey });
        return;
      }
      if (!editing && modifier && (key === "+" || key === "=")) { event.preventDefault(); void kernel.commands.execute("view.zoomIn", activeCommandContext()); }
      if (!editing && modifier && key === "-") { event.preventDefault(); void kernel.commands.execute("view.zoomOut", activeCommandContext()); }
      if (event.key === "Escape") { store.setPaletteOpen(false); store.setSettingsOpen(false); }
      if (!editing && active && event.code === "Tab") {
        event.preventDefault();
        setCleanCanvas((current) => { const next = !current; window.dispatchEvent(new CustomEvent(CLEAN_CANVAS_EVENT, { detail: next })); return next; });
        return;
      }
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

  return <div className="app" data-theme={store.theme} data-home={!active} data-clean-canvas={cleanCanvas || undefined} data-has-toolbar={active?.kind === "raster" || active?.kind === "vector"} style={themeStyle}>
    <header className="menu-bar">
      <strong className={active ? "brand compact" : "brand full"}><img src={active ? `${import.meta.env.BASE_URL}логотип цветная плашка.svg` : `${import.meta.env.BASE_URL}логотип белый.svg`} alt="VRAVIO" /></strong>
      <button className="home-button" onClick={() => store.showHome()} aria-label={text(store.language, "Home", "Главная")} title={text(store.language, "Home", "Главная")}><i style={{ "--icon-mask": `url("${import.meta.env.BASE_URL}ГЛАВНАЯ.svg")` } as CSSProperties}/></button>
      <nav aria-label={store.language === "ru" ? "Главное меню" : "Main menu"}>
        {/* Image/SVG-specific entries (Import…, Import SVG, Export…, Export as SVG, Print…) only
            show for the environments they actually mean something in — raster/vector. Found
            live: these sat in every environment's File menu regardless, greyed out for Audio/
            Video rather than simply absent, which read as "these belong here but are broken"
            instead of "these don't apply here." Audio/Video each already have their own real
            Import/Export in their own toolbar, not a gap this menu needs to fill. */}
        <Menu label="File (Файл)" language={store.language} open={openMenu === "file"} onToggle={() => setOpenMenu(openMenu === "file" ? null : "file")} items={[
          ["New… (Новый…)", "Ctrl+N", () => store.requestNewDocument("raster")],
          ["Open… (Открыть…)", "Ctrl+O", () => openImageRef.current?.click()],
          ...(active?.kind === "raster" || active?.kind === "vector" ? [["Import… (Импортировать…)", "", () => openImageRef.current?.click()] as MainMenuItem] : []),
          ...(active?.kind === "vector" ? [["Import SVG as Vector… (Импортировать SVG как вектор…)", "", () => importSvgAsVectorRef.current?.click()] as MainMenuItem] : []),
          ["Save (Сохранить)", "Ctrl+S", () => void saveProject(), !active],
          ["Save As… (Сохранить как…)", "Ctrl+Shift+S", () => void saveProject(), !active],
          ["Save a Copy… (Сохранить копию…)", "Ctrl+Alt+S", () => void saveProject(false), !active],
          ...(active?.kind === "raster" ? [["Export… (Экспортировать…)", "Ctrl+Shift+E", () => setExportOpen(true), !isRasterDocumentState(active.state)] as MainMenuItem] : []),
          ...(active?.kind === "vector" ? [["Export as SVG… (Экспортировать в SVG…)", "", exportActiveVectorAsSvg, !isVectorDocumentState(active.state)] as MainMenuItem] : []),
          ...(active?.kind === "raster" ? [["Print… (Печать…)", "Ctrl+P", () => setPrintOpen(true), !isRasterDocumentState(active.state)] as MainMenuItem] : []),
          ["Settings… (Настройки…)", "", () => store.setSettingsOpen(true)],
          ["Close (Закрыть)", "Ctrl+W", () => active && store.closeDocument(active.id), !active],
        ]}/>
        <Menu label="Edit (Правка)" language={store.language} open={openMenu === "edit"} onToggle={() => setOpenMenu(openMenu === "edit" ? null : "edit")} items={[
          ["Undo (Отменить)", "Ctrl+Z", () => void kernel.commands.execute("edit.undo", activeCommandContext())],
          ["Redo (Повторить)", "Ctrl+Shift+Z", () => void kernel.commands.execute("edit.redo", activeCommandContext())],
          // Free Transform is raster/vector's own interactive transform tool
          // (`vravio-transform-start`) — meaningless for Audio/Video, which have their own
          // transform controls (clip keyframes, the Video Inspector's x/y/scale fields) already
          // reachable in their own workspace, not through this menu at all.
          ...(active?.kind === "raster" || active?.kind === "vector" ? [["Free Transform (Свободная трансформация)", "Ctrl+T", () => window.dispatchEvent(new Event("vravio-transform-start"))] as MainMenuItem] : []),
        ]}/>
        {active?.kind === "raster" && <Menu label="Image (Изображение)" language={store.language} open={openMenu === "image"} onToggle={() => setOpenMenu(openMenu === "image" ? null : "image")} items={[
          { label: "Adjustments (Коррекция)", items: rasterAdjustments.map((definition) => [`${definition.name.en}… (${definition.name.ru}…)`, definition.shortcut ?? "", () => openImageAdjustment(definition), !activeRasterState || activeRasterState.layers.find((layer) => layer.id === activeRasterState.activeLayerId)?.kind !== "pixel"] as MainMenuItem) },
          // One command with a `ratio` argument, one entry per ratio it offers:
          // adding a fourth used to mean a fourth hand-wired menu line.
          { label: "Smart Crop (Умное кадрирование)", items: Object.keys(smartCropRatios).map((ratio) => [ratio, "", () => { void kernel.commands.execute("image.smartCrop", activeCommandContext(), { ratio }); }, !active || !isRasterDocumentState(active.state)] as MainMenuItem) },
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
          ["Group (Сгруппировать)", "Ctrl+G", () => active && groupActiveVectorShapes(active.id)],
          ["Ungroup (Разгруппировать)", "Ctrl+Shift+G", () => active && ungroupActiveVectorGroup(active.id)],
          ["Create Symbol from Selection (Создать символ из выделения)", "", () => active && createSymbolFromActiveSelection(active.id)],
          ["Break Link to Symbol (Разорвать связь с символом)", "", () => active && detachActiveVectorInstance(active.id)],
          ["Bring to Front (На передний план)", "", () => active && reorderActiveVectorShape(active.id, "front")],
          ["Bring Forward (Переместить выше)", "", () => active && reorderActiveVectorShape(active.id, "forward")],
          ["Send Backward (Переместить ниже)", "", () => active && reorderActiveVectorShape(active.id, "backward")],
          ["Send to Back (На задний план)", "", () => active && reorderActiveVectorShape(active.id, "back")],
          { label: "Pathfinder (Обработка контуров)", items: [
            ["Unite (Объединить)", "", () => active && void applyPathfinderOp(active.id, "union"), pathfinderDisabled],
            ["Subtract (Вычесть)", "", () => active && void applyPathfinderOp(active.id, "subtract"), pathfinderDisabled],
            ["Intersect (Пересечь)", "", () => active && void applyPathfinderOp(active.id, "intersect"), pathfinderDisabled],
            ["Exclude (Исключить)", "", () => active && void applyPathfinderOp(active.id, "exclude"), pathfinderDisabled],
          ] },
          ["Convert to Outlines (Преобразовать в контуры)", "", () => active && void convertActiveTextToOutlines(active.id), !activeTextShape],
          ["Attach Text to Path (Прикрепить текст к контуру)", "", () => active && attachActiveTextToPath(active.id), attachToPathDisabled],
          ["Detach Text from Path (Открепить текст от контура)", "", () => active && detachActiveTextFromPath(active.id), detachFromPathDisabled],
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
          // The active environment's plugins, and only those: `pluginsFor`
          // answers from each plugin's own manifest, and returns nothing at all
          // for an environment with no plugin surface. Nothing here lists
          // environments or switches on them — an environment that cannot host
          // plugins simply has none to show, rather than showing some greyed
          // out (there is nothing there to enable). Each one runs through its
          // own environment's door via `usePluginRuns`.
          ...pluginsFor(active?.kind).map((entry) => [
            resolveLabel(entry.manifest.label, store.language),
            "",
            () => window.dispatchEvent(new CustomEvent(PLUGIN_RUN_EVENT, { detail: { pluginId: entry.manifest.id } })),
            false,
          ] as MainMenuItem),
          ["Manage Plugins… (Управление плагинами…)", "", () => {}, true],
        ]}/>
        <Menu label="Window (Окно)" language={store.language} open={openMenu === "window"} onToggle={() => setOpenMenu(openMenu === "window" ? null : "window")} items={[
          ...(active && workspacePresetsFor(active.kind).length ? [{ label: "Workspace (Рабочая среда)", items: [
            ...workspacePresetsFor(active.kind).map((preset) => [
              `${preset.label.en} (${preset.label.ru})${selectedWorkspacePreset(active.kind) === preset.id ? " ✓" : ""}`,
              "",
              () => applyWorkspacePreset(active.kind, preset.id),
            ] as MainMenuItem),
            ["Reset Workspace (Сбросить рабочую среду)", "", () => resetWorkspacePreset(active.kind)] as MainMenuItem,
          ] }] as MainMenuGroup[] : []),
          ...windowMenuItems(active?.kind, store.language),
          ["Settings (Настройки)", "", () => store.setSettingsOpen(true)],
          ["Command Palette (Палитра команд)", "Ctrl+K", () => store.setPaletteOpen(true)],
        ]}/>
        <Menu label="Help (Справка)" language={store.language} open={openMenu === "help"} onToggle={() => setOpenMenu(openMenu === "help" ? null : "help")} items={[["Diagnostics log (Журнал диагностики)", "", () => setDiagnosticsOpen(true)], ["About VRAVIO (О VRAVIO)", "", () => window.alert("VRAVIO — local-first creative suite")]]}/>
      </nav>
      <button className="settings-button" onClick={() => store.setSettingsOpen(true)} aria-label={store.language === "ru" ? "Настройки" : "Settings"} title={store.language === "ru" ? "Настройки" : "Settings"}><img src={`${import.meta.env.BASE_URL}НАСТРОЙКИ.svg`} alt=""/></button>
      {/* Fills the gap between the menu and the window controls (or, on the
          web build, just trailing space) — its own element rather than relying
          on <nav>'s width, so there is always a real draggable strip here
          regardless of how many menus fit. Inert on the web build: the
          attribute means nothing without Tauri's injected drag handler. */}
      <div className="titlebar-drag" data-tauri-drag-region="true"/>
      {active && store.preferences.showCommandPaletteButton && <button className="palette-button" onClick={() => store.setPaletteOpen(true)} title={store.language === "ru" ? "Палитра команд (Ctrl+K)" : "Command Palette (Ctrl+K)"} aria-label={store.language === "ru" ? "Палитра команд, Ctrl+K" : "Command Palette, Ctrl+K"}><i aria-hidden="true" style={{ "--icon-mask": `url("${import.meta.env.BASE_URL}ПАЛИТРА-КОМАНД.svg")` } as CSSProperties}/></button>}
      {active && <WorkspaceSwitcher kind={active.kind} language={store.language}/>} 
      <input ref={openImageRef} hidden type="file" accept={`image/png,image/jpeg,image/webp,image/gif,image/avif,image/svg+xml,.svg,.psd,.psb,${rawFileExtensions.map((extension) => `.${extension}`).join(",")}`} onChange={(event) => { const file = event.target.files?.[0]; if (file) void importImage(file); event.currentTarget.value = ""; }}/>
      <input ref={importSvgAsVectorRef} hidden type="file" accept="image/svg+xml,.svg" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importSvgAsVector(file); event.currentTarget.value = ""; }}/>
      {/* Native window chrome, folded into the same row as the menu — the
          OS title bar is switched off entirely (tauri.conf.json's
          decorations: false), so without this the window would have no way
          to minimize, maximize or close at all. Absent on the web build,
          where the browser's own chrome already does this job. */}
      {isDesktop && <div className="window-controls">
        <button aria-label={store.language === "ru" ? "Свернуть" : "Minimize"} onClick={() => void minimizeWindow()}>
          <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><line x1="1" y1="5" x2="9" y2="5" stroke="currentColor" strokeWidth="1"/></svg>
        </button>
        <button aria-label={store.language === "ru" ? "Развернуть" : "Maximize"} onClick={() => void toggleMaximizeWindow()}>
          <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><rect x="1.5" y="1.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1"/></svg>
        </button>
        <button className="window-close" aria-label={store.language === "ru" ? "Закрыть" : "Close"} onClick={() => void closeWindow()}>
          <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><line x1="1" y1="1" x2="9" y2="9" stroke="currentColor" strokeWidth="1"/><line x1="9" y1="1" x2="1" y2="9" stroke="currentColor" strokeWidth="1"/></svg>
        </button>
      </div>}
    </header>

    {(active?.kind === "raster" || active?.kind === "vector") && <aside className="toolbar" aria-label="Tools (Инструменты)">
      <ToolPalette kind={active.kind} language={store.language} activeToolId={activeToolId} openGroup={openToolGroup} onOpenGroup={setOpenToolGroup} onSelect={(toolId) => { store.setTool(active.id, toolId); setOpenToolGroup(null); }} />
      {active.kind === "raster" && <ColorWells foreground={effectiveForegroundColor} background={effectiveBackgroundColor} monochrome={Boolean(editingMaskLayerId)} onForeground={(color) => editingMaskLayerId ? store.setMaskForegroundWhite(active.id, color.toLowerCase() !== "#000000") : store.setForegroundColor(color)} onBackground={(color) => editingMaskLayerId ? store.setMaskForegroundWhite(active.id, color.toLowerCase() === "#000000") : store.setBackgroundColor(color)} onSwap={() => editingMaskLayerId ? store.swapMaskColors(active.id) : store.swapColors()} onReset={() => editingMaskLayerId ? store.setMaskForegroundWhite(active.id, false) : store.resetColors()} />}
    </aside>}

    {documents.length > 0 && <div className="document-tabs" role="tablist" aria-label="Documents (Документы)">
      {documents.map((document) => <div className="tab-wrap" key={document.id} data-kind={document.kind} data-linked={document.provenance ? "" : undefined}>
        <button role="tab" aria-selected={document.id === store.activeDocumentId} onClick={() => store.activateDocument(document.id)}>
          <EnvironmentIcon kind={document.kind} className="tab-environment-icon" />{localized(document.name, store.language)}
          {(document.dirty || document.id === store.activeDocumentId) && <i className={`tab-save-state${document.dirty ? " dirty" : ""}`} title={document.dirty ? text(store.language, "Modified", "Изменён") : text(store.language, "Saved", "Сохранено")} aria-label={document.dirty ? text(store.language, "Modified", "Изменён") : text(store.language, "Saved", "Сохранено")} style={document.dirty ? undefined : { "--icon-mask": `url("${import.meta.env.BASE_URL}СОХРАНЕНО.svg")` } as CSSProperties}/>} 
          {/* A tab opened out of another keeps its own result when the parent
              undoes, so the two can end up showing different pictures. Nothing
              else on screen would say why. */}
          {kernel.roundtrip.isOutOfSync(document.id) && <b className="tab-out-of-sync" title={store.language === "ru" ? "Исходный документ показывает не то, что вы применили. Примените ещё раз, чтобы отдать текущую версию." : "The parent document is not showing what you applied. Apply again to send the current version."}>↑</b>}
        </button>
        <button className="tab-close" aria-label={`Close ${document.name}`} onClick={() => store.closeDocument(document.id)}>×</button>
      </div>)}
    </div>}

    {(active?.kind === "raster" || active?.kind === "vector") && <OptionsBar language={store.language} tool={activeTool} pixelsPerInch={isRasterDocumentState(active.state) ? active.state.resolution : undefined} values={activeTool ? { ...(store.toolOptions[activeTool.id] ?? {}), ...(activeTool.options.some((option) => option.id === "color") ? { color: effectiveForegroundColor } : {}) } : {}} transform={transformMetrics} onTransformCommit={() => window.dispatchEvent(new Event("vravio-transform-commit"))} onTransformCancel={() => window.dispatchEvent(new Event("vravio-transform-cancel"))} onChange={(id, value) => { if (!activeTool) return; store.setToolOption(activeTool.id, id, value); if (id === "color") { if (editingMaskLayerId) store.setMaskForegroundWhite(active.id, String(value).toLowerCase() !== "#000000"); else store.setForegroundColor(String(value)); } }} alignSelectionCount={isRasterDocumentState(active.state) ? (selectedLayerIds.length || 1) : 0} onAlign={(edge) => alignOrDistributeLayers("align", edge)} onDistribute={(edge) => alignOrDistributeLayers("distribute", edge)} smartGuides={store.preferences.smartGuides} snapToGrid={store.preferences.snapToGrid} onToggleSmartGuides={(smartGuides) => store.updatePreferences({ smartGuides })} onToggleSnapToGrid={(snapToGrid) => store.updatePreferences({ snapToGrid })} />}

    <main className="workspace">
      {active ? <DockLayout /> : <HomeScreen language={store.language} requestNewDocument={store.requestNewDocument} openFile={openBridgeFile} />}
      {active && <ContextualBar documentId={active.id} state={active.state} language={store.language} visible={store.preferences.contextualBar} />}
    </main>
    {active && <footer className="status-bar"><span>{resolveLabel(environmentMeta[active.kind].label, store.language)}</span><span>{isAudioDocumentState(active.state) ? `${(active.state.sampleRate / 1000).toLocaleString()} kHz · ${active.state.channels === 1 ? text(store.language, "Mono", "Моно") : text(store.language, "Stereo", "Стерео")} · ${active.state.bitDepth} bit` : isVideoDocumentState(active.state) ? `${active.state.width}×${active.state.height} · ${active.state.frameRate} fps` : `${Math.round((store.viewports[active.id]?.zoom ?? 1) * 100)}% · sRGB · ${renderBackend ?? "detecting"}`}</span></footer>}
    {store.preferences.showPerformanceOverlay && <PerformanceOverlay documentId={active?.id ?? null} />}

    {store.paletteOpen && <div className="dialog-backdrop" onMouseDown={() => store.setPaletteOpen(false)}>
      <section className="command-palette" role="dialog" aria-modal="true" aria-label="Command palette (Палитра команд)" onMouseDown={(event) => event.stopPropagation()}>
        <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder={store.language === "ru" ? "Введите команду…" : "Type a command…"} />
        <div>{commands.map((command) => <button key={command.id} disabled={command.isEnabled?.(activeCommandContext()) === false} onClick={() => { void kernel.commands.execute(command.id, activeCommandContext()); store.setPaletteOpen(false); }}><span>{localized(command.label, store.language)}</span>{command.shortcut && <kbd>{command.shortcut}</kbd>}</button>)}</div>
      </section>
    </div>}

    <SettingsDialog />
    <ModalHost />
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
    {printOpen && active && isRasterDocumentState(active.state) && <PrintDialog state={active.state} language={store.language} onCancel={() => setPrintOpen(false)}/>}
    {adjustmentDialog && (() => { const document = kernel.documents.get<RasterDocumentState>(adjustmentDialog.documentId), definition = rasterAdjustmentById.get(adjustmentDialog.definitionId), layer = document?.state.layers.find((item) => item.id === adjustmentDialog.layerId); if (!document || !definition || !layer) return null; const pixels = layerDocumentPixels(layer, document.state.width, document.state.height); return <AdjustmentDialog definition={definition} initialValue={adjustmentDialog.initialValue} language={store.language} histogram={luminanceHistogram(pixels)} pixels={pixels} onPreview={previewImageAdjustment} onCancel={() => { previewImageAdjustment(null); setAdjustmentDialog(null); }} onApply={applyImageAdjustment}/>; })()}
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
 * for audio and video: `AudioWorkspace`/`VideoWorkspace` are each a self-
 * contained editor (bin, transport, clip inspector all built in) with nothing
 * wired to the dockable side panels, so there is genuinely nothing to offer —
 * not raster's list.
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
  // import.meta.env.BASE_URL, not a hardcoded '/' — see EnvironmentIcon.tsx's own comment on why (GitHub Pages serves this app under /VRAVIO/, not the domain root).
  return tool.iconFile ? <span className="tool-svg-icon" aria-hidden="true" style={{ "--tool-mask": `url("${import.meta.env.BASE_URL}${tool.iconFile}")` } as CSSProperties} /> : <span>{tool.icon}</span>;
}

function ToolPalette({ kind, language, activeToolId, openGroup, onOpenGroup, onSelect }: { kind: "raster" | "vector"; language: Language; activeToolId: string | undefined; openGroup: string | null; onOpenGroup(group: string | null): void; onSelect(toolId: string): void }) {
  // The arrangement, not the catalogue: which tools are in the palette, in
  // what order, and grouped how, is the user's to change (stage 8). The
  // default is still Photoshop's grouping out of `tools.ts`, so a palette
  // nobody has rearranged looks exactly as it did.
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const refresh = () => setRevision((value) => value + 1);
    window.addEventListener(TOOLBAR_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(TOOLBAR_CHANGED_EVENT, refresh);
  }, []);
  const layout = useMemo(
    () => readToolbarLayout(kind),
    // `revision` is the dependency that matters: the layout lives in storage,
    // not in React, so nothing else would tell this to read it again.
    [kind, revision],
  );
  const groups = useMemo(() => layout.groups.map((ids) => ids.map((id) => toolById(id)).filter((tool): tool is ToolDefinition => Boolean(tool))), [layout]);
  // A hidden tool keeps its shortcut — hiding declutters the palette, it does
  // not take the tool away, and silently breaking a key the user knows would be
  // worse than a crowded palette. But then pressing it leaves no slot lit, and
  // a palette showing nothing selected while a tool is plainly active is a
  // palette telling a lie. The edit button lights instead: it is both the
  // honest answer to "which tool is this?" and exactly where you would go to
  // put the tool back.
  const activeIsHidden = Boolean(activeToolId && layout.hidden.includes(activeToolId));
  const editLabel = text(language, "Customise toolbar", "Настроить панель инструментов");
  // master-plan.md §1.9 item 13: a group's own visible icon used to fall
  // straight back to `group[0]` — the group's declared first tool —
  // whenever the globally active tool wasn't a member of that group,
  // losing which tool in the group was actually used last. Photoshop
  // remembers that per group, independent of whatever tool is active
  // elsewhere; picking a tool from a flyout records it here, and it wins
  // over `group[0]` right up until `activeToolId` itself becomes a member
  // of the group again (which then takes priority, since it's the true
  // current state, not a memory of a past one).
  const [lastToolInGroup, setLastToolInGroup] = useState<Record<string, string>>({});
  const select = (groupId: string, toolId: string) => { setLastToolInGroup((current) => ({ ...current, [groupId]: toolId })); onSelect(toolId); };
  return <>{groups.map((group) => {
    if (!group.length) return null;
    const groupId = group.map((tool) => tool.id).join("|");
    const remembered = group.find((tool) => tool.id === lastToolInGroup[groupId]);
    const selected = group.find((tool) => tool.id === activeToolId) ?? remembered ?? group[0]!;
    return <div className="tool-group" key={groupId}>
      <button className={group.some((tool) => tool.id === activeToolId) ? "active" : ""} title={`${resolveLabel(selected.label, language)} [${selected.shortcut}]`} aria-label={resolveLabel(selected.label, language)} onClick={() => select(groupId, selected.id)}><ToolGlyph tool={selected} /></button>
      {group.length > 1 && <button className="tool-group-arrow" aria-label={language === "ru" ? "Показать группу инструментов" : "Show tool group"} onClick={() => onOpenGroup(openGroup === groupId ? null : groupId)}>▾</button>}
      {openGroup === groupId && <div className="tool-flyout">{group.map((tool) => <button key={tool.id} className={tool.id === activeToolId ? "active" : ""} onClick={() => select(groupId, tool.id)}><ToolGlyph tool={tool} /><span>{resolveLabel(tool.label, language)}</span><kbd>{tool.shortcut}</kbd></button>)}</div>}
    </div>;
  })}
    {/* Photoshop's own affordance, in Photoshop's own place: the palette says
        what it holds, and this is where you change that. */}
    <button
      className={`toolbar-edit${activeIsHidden ? " active" : ""}`}
      onClick={() => openModal("toolbar-editor", { kind })}
      title={activeIsHidden ? `${resolveLabel(toolById(activeToolId)!.label, language)} — ${text(language, "hidden from the palette", "скрыт с панели")}` : editLabel}
      aria-label={editLabel}
    >…</button>
  </>;
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
    <button className="swap-colors" onClick={onSwap} title="Swap colors [X]" aria-label="Swap colors"><span className="swap-colors-icon" style={{ "--swap-colors-mask": `url("${import.meta.env.BASE_URL}ПОМЕНЯТЬ-ЦВЕТА.svg")` } as CSSProperties} /></button>
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
    {alignButtons.map(([edge, icon, title]) => <button key={edge} disabled={!canAlign} title={title} aria-label={title} onClick={() => onAlign(edge)}><i style={{ "--icon-mask": `url("${import.meta.env.BASE_URL}${icon}")` } as CSSProperties}/></button>)}
    <span className="align-bar-sep"/>
    {distributeButtons.map(([edge, icon, title]) => <button key={edge} disabled={!canDistribute} title={title} aria-label={title} onClick={() => onDistribute(edge)}><i style={{ "--icon-mask": `url("${import.meta.env.BASE_URL}${icon}")` } as CSSProperties}/></button>)}
  </div>;
}

/**
 * Quick on/off for the two independent snap questions
 * (`ShellPreferences.smartGuides`/`snapToGrid` — the single source of truth
 * `VectorWorkspace.tsx` already reads and `SettingsDialog.tsx` already
 * exposes in full) shown right in the tool options bar, not just buried in
 * Settings — the owner's own ask, after finding the snapping too
 * aggressive, was "somewhere I can reach without opening a dialog."
 *
 * The icons are hand-drawn inline SVG rather than files under `icons/` —
 * that directory is Illustrator-exported artwork the owner manages
 * separately (see this session's own standing rule not to touch it), and
 * two small glyphs don't warrant asking for new ones there.
 */
function SnapControls({ language, smartGuides, snapToGrid, onToggleSmartGuides, onToggleSnapToGrid }: { language: Language; smartGuides: boolean; snapToGrid: boolean; onToggleSmartGuides(value: boolean): void; onToggleSnapToGrid(value: boolean): void }) {
  return <div className="snap-controls">
    <button className={smartGuides ? "active" : ""} aria-pressed={smartGuides} title={text(language, "Snap to objects (Smart Guides)", "Привязка к объектам (быстрые направляющие)")} onClick={() => onToggleSmartGuides(!smartGuides)}>
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
        <path d="M4 1h4v6.2a2 2 0 1 0 4 0V1h-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
        <path d="M4 1v6.2a4 4 0 0 0 8 0" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
        <rect x="3" y="0.5" width="2.4" height="3" fill="currentColor"/>
        <rect x="10.6" y="0.5" width="2.4" height="3" fill="currentColor"/>
      </svg>
    </button>
    <button className={snapToGrid ? "active" : ""} aria-pressed={snapToGrid} title={text(language, "Snap to grid", "Привязка к сетке")} onClick={() => onToggleSnapToGrid(!snapToGrid)}>
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
        <rect x="1" y="1" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.3"/>
        <path d="M6 1v14M10 1v14M1 6h14M1 10h14" stroke="currentColor" strokeWidth="1"/>
      </svg>
    </button>
  </div>;
}

/**
 * Photoshop's warp-style row: the style dropdown, the orientation toggle and the Bend slider,
 * shown in the options bar while a Warp is open.
 *
 * The choice is local state rather than a saved tool option on purpose. A warp style is a
 * property of *this* warp — Photoshop reopens Warp at Custom every time — and the mesh itself
 * is the real record of it; a remembered option would be a second copy of that, free to drift
 * from the mesh the moment the user drags an anchor by hand (CLAUDE.md §4).
 */
function WarpStyleControls({ language }: { language: Language }) {
  const [style, setStyle] = useState<string>("custom");
  const [bend, setBend] = useState(50);
  const [vertical, setVertical] = useState(false);
  const apply = (next: { style?: string; bend?: number; vertical?: boolean }) => {
    const detail = { style: next.style ?? style, bend: next.bend ?? bend, vertical: next.vertical ?? vertical };
    window.dispatchEvent(new CustomEvent("vravio-warp-preset", { detail }));
  };
  const preset = WARP_PRESETS.find((entry) => entry.id === style);
  return <>
    <label>{text(language, "Warp", "Деформация")}:<select value={style} onChange={(event) => { setStyle(event.target.value); apply({ style: event.target.value }); }}>
      <option value="custom">{text(language, "Custom", "Заказная")}</option>
      {WARP_PRESETS.map((entry) => <option key={entry.id} value={entry.id}>{language === "ru" ? entry.label.ru : entry.label.en}</option>)}
    </select></label>
    {/* Orientation is offered only for the styles that have a vertical twin — a checkbox that
        does nothing on Fisheye would be the dead setting CLAUDE.md §3 forbids. */}
    {preset?.orientable && <button className={vertical ? "active" : undefined} title={text(language, "Change warp orientation", "Изменить ориентацию деформации")} onClick={() => { setVertical(!vertical); apply({ vertical: !vertical }); }}>{vertical ? "↕" : "↔"}</button>}
    {style !== "custom" && <label>{text(language, "Bend", "Изгиб")}:<input type="range" min={-100} max={100} step={1} value={bend} onChange={(event) => { setBend(Number(event.target.value)); apply({ bend: Number(event.target.value) }); }}/><input type="number" min={-100} max={100} value={bend} onChange={(event) => { setBend(Number(event.target.value)); apply({ bend: Number(event.target.value) }); }}/></label>}
  </>;
}

function OptionsBar({ language, tool, values, transform, pixelsPerInch, onTransformCommit, onTransformCancel, onChange, alignSelectionCount, onAlign, onDistribute, smartGuides, snapToGrid, onToggleSmartGuides, onToggleSnapToGrid }: { language: Language; tool: ReturnType<typeof toolById>; values: Record<string, string | number | boolean>; transform: { active: boolean; x: number; y: number; width: number; height: number; rotation: number; warp?: boolean } | null; pixelsPerInch?: number | undefined; onTransformCommit(): void; onTransformCancel(): void; onChange(id: string, value: string | number | boolean): void; alignSelectionCount: number; onAlign(edge: AlignEdge): void; onDistribute(edge: AlignEdge): void; smartGuides: boolean; snapToGrid: boolean; onToggleSmartGuides(value: boolean): void; onToggleSnapToGrid(value: boolean): void }) {
  if (transform?.active) return <div className="options-bar transform-options"><strong>Free Transform (Свободная трансформация)</strong>{transform.warp && <WarpStyleControls language={language}/>}<label>X:<input value={Math.round(transform.x)} readOnly/></label><label>Y:<input value={Math.round(transform.y)} readOnly/></label><label>W:<input value={Math.round(transform.width)} readOnly/></label><label>H:<input value={Math.round(transform.height)} readOnly/></label><label>∠:<input value={`${Math.round(transform.rotation * 10) / 10}°`} readOnly/></label><button title="Cancel (Отмена)" onClick={onTransformCancel}>×</button><button className="commit" title="Commit (Подтвердить)" onClick={onTransformCommit}>✓</button></div>;
  return <div className="options-bar"><strong>{tool ? resolveLabel(tool.label, language) : text(language, "Tool options", "Параметры инструмента")}</strong>{tool ? tool.options.map((option) => <OptionRow key={option.id} language={language} option={option} pixelsPerInch={pixelsPerInch} value={values[option.id] ?? option.defaultValue} onChange={(value) => onChange(option.id, value)} />) : <span className="muted">{language === "ru" ? "Выберите или создайте документ" : "Select or create a document"}</span>}{tool?.id === "raster.move" && <AlignDistributeBar selectionCount={alignSelectionCount} onAlign={onAlign} onDistribute={onDistribute}/>}{tool?.kind === "vector" && <SnapControls language={language} smartGuides={smartGuides} snapToGrid={snapToGrid} onToggleSmartGuides={onToggleSmartGuides} onToggleSnapToGrid={onToggleSnapToGrid}/>}</div>;
}
