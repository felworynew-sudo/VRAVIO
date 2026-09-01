import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { compositeRasterDocument, computeAlignOffsets, computeDistributeOffsets, createAdjustmentLayer, createRasterLayer, isRasterDocumentState, layerContentBounds, translateLayerPixels, type AlignEdge, type RasterAdjustment, type RasterDocumentState, type RasterRect } from "@vravio/env-raster";
import { useShellStore, type Language } from "./store";
import type { EnvironmentKind } from "@vravio/kernel";
import { DockLayout } from "./DockLayout";
import { environmentMeta } from "./environment";
import { rasterToolGroups, toolById, toolsFor, type ToolDefinition, type ToolOption } from "./tools";
import { useDocuments } from "./useDocuments";
import { activeCommandContext, ensureCommandsRegistered } from "./commands";
import { kernel } from "./kernel";
import { EnvironmentIcon } from "./EnvironmentIcon";
import { localized, text } from "./i18n";
import { SettingsDialog } from "./SettingsDialog";
import { NewDocumentDialog } from "./NewDocumentDialog";
import { clearDiagnostics, diagnostic, readDiagnostics, type DiagnosticEntry } from "./diagnostics";
import { FilterGalleryDialog } from "./FilterGalleryDialog";
import { LiquifyDialog } from "./LiquifyDialog";
import { rawExtensionOf, rawFileExtensions, type DecodedRaw } from "./rawDecode";
import { CameraRawDialog } from "./CameraRawDialog";
import { renderTextLayerPixels } from "./textRender";
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
  const [cameraRawImport, setCameraRawImport] = useState<{ buffer: ArrayBuffer; name: string } | null>(null);
  const [cameraRawReopen, setCameraRawReopen] = useState<{ buffer: ArrayBuffer; name: string } | null>(null);
  const active = documents.find((document) => document.id === store.activeDocumentId) ?? null;
  const activeToolId = active ? store.activeToolByDocument[active.id] : undefined;
  const activeTool = toolById(activeToolId);
  const activeRawOrigin = active?.origin?.kind === "asset" && kernel.assets.get(active.origin.assetId)?.mime === "image/x-raw" ? active.origin : null;
  const commands = useMemo(() => kernel.commands.search(query), [query]);
  const themeStyle = { "--focus": store.preferences.focusColor, "--raster": store.preferences.rasterColor, "--vector": store.preferences.vectorColor, "--audio": store.preferences.audioColor, "--video": store.preferences.videoColor, "--canvas-surround": store.preferences.canvasSurround, "--guide": store.preferences.guideColor } as CSSProperties;

  const openDecodedRaster = (name: string, decoded: DecodedRaw): string => {
    store.openDocument("raster", { name, width: decoded.width, height: decoded.height, resolution: 72, resolutionUnit: "ppi", backgroundColor: null, pixelAspectRatio: 1 });
    const id = useShellStore.getState().activeDocumentId!;
    kernel.documents.update<RasterDocumentState>(id, (state) => { state.layers[0]!.pixels = decoded.pixels.slice(); });
    return id;
  };

  const importImage = async (file: File) => {
    const extension = rawExtensionOf(file.name);
    if (extension && (rawFileExtensions as readonly string[]).includes(extension)) {
      setCameraRawImport({ buffer: await file.arrayBuffer(), name: file.name });
      return;
    }
    const bitmap = await createImageBitmap(file); store.openDocument("raster", { name: file.name, width: bitmap.width, height: bitmap.height, resolution: 72, resolutionUnit: "ppi", backgroundColor: null, pixelAspectRatio: 1 });
    const id = useShellStore.getState().activeDocumentId; if (!id) return;
    const surface = window.document.createElement("canvas"); surface.width = bitmap.width; surface.height = bitmap.height; const context = surface.getContext("2d"); if (!context) return; context.drawImage(bitmap, 0, 0); bitmap.close();
    kernel.documents.update<RasterDocumentState>(id, (state) => { state.layers[0]!.pixels = context.getImageData(0, 0, state.width, state.height).data; });
  };
  const download = (blob: Blob, name: string) => { const url = URL.createObjectURL(blob), anchor = window.document.createElement("a"); anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 0); };
  const exportPng = async () => { if (!active || !isRasterDocumentState(active.state)) return; const surface = window.document.createElement("canvas"); surface.width = active.state.width; surface.height = active.state.height; surface.getContext("2d")?.putImageData(new ImageData(compositeRasterDocument(active.state) as Uint8ClampedArray<ArrayBuffer>, active.state.width, active.state.height), 0, 0); const blob = await new Promise<Blob | null>((resolve) => surface.toBlob(resolve, "image/png")); if (blob) download(blob, active.name.replace(/\.[^.]+$/, "") + ".png"); };
  const saveProject = () => { if (!active) return; const replacer = (_key: string, value: unknown) => value instanceof Uint8ClampedArray ? { __type: "Uint8ClampedArray", data: Array.from(value) } : value; download(new Blob([JSON.stringify(active.state, replacer)], { type: "application/json" }), active.name.replace(/\.[^.]+$/, "") + ".vravio.json"); };
  const applyFilter = (pixels: Uint8ClampedArray, label: string) => { if (!active || !isRasterDocumentState(active.state)) return; const id=active.id,layerId=active.state.activeLayerId,before=active.state.layers.find((item)=>item.id===layerId)?.pixels.slice();if(!before)return;const assign=(value:Uint8ClampedArray)=>{kernel.documents.update<RasterDocumentState>(id,(state)=>{const layer=state.layers.find((item)=>item.id===layerId);if(layer)layer.pixels=value.slice();});};const history=kernel.historyByDocument.get(id);if(history)void history.execute({label:`Filter: ${label}`,redo:()=>assign(pixels),undo:()=>assign(before)}); };
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
  const activeTextLayer = (() => { if (!active || !isRasterDocumentState(active.state)) return null; const state = active.state; return state.layers.find((layer) => layer.id === state.activeLayerId && layer.kind === "text" && layer.text) ?? null; })();
  const unionBounds = (boxes: RasterRect[]): RasterRect => { const left = Math.min(...boxes.map((box) => box.x)), top = Math.min(...boxes.map((box) => box.y)), right = Math.max(...boxes.map((box) => box.x + box.width)), bottom = Math.max(...boxes.map((box) => box.y + box.height)); return { x: left, y: top, width: right - left, height: bottom - top }; };
  const alignOrDistributeLayers = (kind: "align" | "distribute", edge: AlignEdge) => {
    if (!active || !isRasterDocumentState(active.state)) return;
    const state = active.state, ids = (selectedLayerIds.length ? selectedLayerIds : [state.activeLayerId]).filter((id) => state.layers.some((layer) => layer.id === id));
    if (kind === "distribute" ? ids.length < 3 : ids.length < 1) return;
    const targets = state.layers.filter((layer) => ids.includes(layer.id));
    const bounds = targets.map((layer) => layerContentBounds(layer.pixels, state.width, state.height));
    const offsets = kind === "align"
      ? computeAlignOffsets(bounds, edge, ids.length > 1 ? unionBounds(bounds) : { x: 0, y: 0, width: state.width, height: state.height })
      : computeDistributeOffsets(bounds, edge);
    if (!offsets.some((offset) => offset.dx || offset.dy)) return;
    type LayerSnapshot = { id: string; pixels: Uint8ClampedArray };
    const id = active.id, before: LayerSnapshot[] = targets.map((layer) => ({ id: layer.id, pixels: layer.pixels.slice() }));
    const after: LayerSnapshot[] = targets.map((layer, index) => ({ id: layer.id, pixels: translateLayerPixels(layer.pixels, state.width, state.height, offsets[index]!.dx, offsets[index]!.dy) }));
    const assign = (list: LayerSnapshot[]) => { kernel.documents.update<RasterDocumentState>(id, (current) => { for (const item of list) { const layer = current.layers.find((entry) => entry.id === item.id); if (layer) layer.pixels = item.pixels.slice(); } }); };
    const history = kernel.historyByDocument.get(id);
    if (history) void history.execute({ label: kind === "align" ? `Align: ${edge}` : `Distribute: ${edge}`, redo: () => assign(after), undo: () => assign(before) });
  };

  const addImageAdjustment = (kind: RasterAdjustment["kind"], name: string) => {
    if (!active || !isRasterDocumentState(active.state)) return;
    kernel.documents.update<RasterDocumentState>(active.id, (current) => { const layer = createAdjustmentLayer(current.width, current.height, kind, name); current.layers.push(layer); current.activeLayerId = layer.id; });
  };
  const duplicateActiveLayer = () => {
    if (!active || !isRasterDocumentState(active.state)) return;
    const state = active.state, source = state.layers.find((layer) => layer.id === state.activeLayerId);
    if (!source) return;
    kernel.documents.update<RasterDocumentState>(active.id, (current) => {
      const index = current.layers.findIndex((layer) => layer.id === source.id);
      const bilingual = source.name.match(/^(.*?)\s*\(([^()]*)\)\s*$/);
      const duplicateName = bilingual ? `${bilingual[1]} copy (${bilingual[2]} копия)` : `${source.name} copy`;
      const copy = { ...source, id: crypto.randomUUID(), pixels: source.pixels.slice(), effects: structuredClone(source.effects), name: duplicateName };
      current.layers.splice(index + 1, 0, copy);
      current.activeLayerId = copy.id;
    });
  };
  const deleteActiveLayer = () => {
    if (!active || !isRasterDocumentState(active.state)) return;
    kernel.documents.update<RasterDocumentState>(active.id, (current) => {
      const index = current.layers.findIndex((layer) => layer.id === current.activeLayerId); if (index < 0) return;
      current.layers.splice(index, 1);
      if (!current.layers.length) current.layers.push(createRasterLayer(current.width, current.height, "Layer 1 (Слой 1)"));
      current.activeLayerId = current.layers[Math.min(index, current.layers.length - 1)]!.id;
    });
  };
  const toggleActiveTextStyle = (key: "bold" | "italic" | "underline") => {
    if (!active || !isRasterDocumentState(active.state)) return;
    const state = active.state, layer = state.layers.find((item) => item.id === state.activeLayerId);
    if (!layer?.text) return;
    const nextText = { ...layer.text, [key]: !layer.text[key] };
    kernel.documents.update<RasterDocumentState>(active.id, (current) => {
      const target = current.layers.find((item) => item.id === layer.id); if (!target?.text) return;
      target.text = nextText; target.pixels = renderTextLayerPixels(nextText, current.width, current.height);
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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const modifier = event.ctrlKey || event.metaKey;
      const key = physicalShortcutKey(event);
      const target = event.target as HTMLElement | null;
      const editing = target?.tagName === "INPUT" || target?.tagName === "SELECT" || target?.tagName === "TEXTAREA" || target?.isContentEditable;
      const mappedCommand = kernel.keymap.resolve(event);
      if ((!editing || mappedCommand === "view.commandPalette") && mappedCommand) {
        event.preventDefault();
        void kernel.commands.execute(mappedCommand, activeCommandContext());
        return;
      }
      if (!editing && modifier && !event.shiftKey && key === "n") { event.preventDefault(); store.requestNewDocument("raster"); }
      if (!editing && modifier && event.shiftKey && key === "n") { event.preventDefault(); void kernel.commands.execute("layer.new", activeCommandContext()); }
      if (!editing && modifier && key === "o") { event.preventDefault(); openImageRef.current?.click(); }
      if (!editing && modifier && key === "z") { event.preventDefault(); void kernel.commands.execute(event.shiftKey ? "edit.redo" : "edit.undo", activeCommandContext()); }
      if (!editing && modifier && key === "s") { event.preventDefault(); void kernel.commands.execute("file.save", activeCommandContext()); }
      if (!editing && modifier && key === "w") { event.preventDefault(); void kernel.commands.execute("file.close", activeCommandContext()); }
      if (!editing && modifier && key === "t") { event.preventDefault(); window.dispatchEvent(new Event("vravio-transform-start")); }
      if (!editing && modifier && key === "r") { event.preventDefault(); store.updatePreferences({ showRulers: !store.preferences.showRulers }); }
      if (!editing && modifier && key === ";") { event.preventDefault(); store.updatePreferences({ showGuides: !store.preferences.showGuides }); }
      if (!editing && modifier && key === "a") { event.preventDefault(); void kernel.commands.execute(event.shiftKey ? "select.none" : "select.all", activeCommandContext()); }
      if (!editing && modifier && event.shiftKey && key === "i") { event.preventDefault(); void kernel.commands.execute("select.invert", activeCommandContext()); }
      if (!editing && modifier && !event.shiftKey && key === "d") { event.preventDefault(); void kernel.commands.execute("select.none", activeCommandContext()); }
      if (!editing && modifier && key === "0") { event.preventDefault(); void kernel.commands.execute("view.fit", activeCommandContext()); }
      if (!editing && modifier && key === "1") { event.preventDefault(); void kernel.commands.execute("view.actual", activeCommandContext()); }
      if (!editing && modifier && (key === "+" || key === "=")) { event.preventDefault(); void kernel.commands.execute("view.zoomIn", activeCommandContext()); }
      if (!editing && modifier && key === "-") { event.preventDefault(); void kernel.commands.execute("view.zoomOut", activeCommandContext()); }
      if (!editing && modifier && event.shiftKey && key === "x") { event.preventDefault(); if (active && isRasterDocumentState(active.state)) setLiquifyOpen(true); }
      if (!editing && modifier && !event.shiftKey && key === "j") { event.preventDefault(); duplicateActiveLayer(); }
      if (!editing && modifier && !event.shiftKey && key === "m") { event.preventDefault(); addImageAdjustment("curves", "Curves (Кривые)"); }
      if (!editing && modifier && !event.shiftKey && key === "u") { event.preventDefault(); addImageAdjustment("hueSaturation", "Hue/Saturation (Тон/Насыщенность)"); }
      if (!editing && modifier && !event.shiftKey && key === "b") { event.preventDefault(); addImageAdjustment("colorBalance", "Color Balance (Цветовой баланс)"); }
      if (!editing && modifier && !event.shiftKey && key === "i") { event.preventDefault(); addImageAdjustment("invert", "Invert (Инверсия)"); }
      if (event.key === "Escape") { store.setPaletteOpen(false); store.setSettingsOpen(false); store.cancelNewDocument(); }
      if (!modifier && !editing && active) {
        if (key === "d") { event.preventDefault(); store.resetColors(); return; }
        if (key === "x") { event.preventDefault(); store.swapColors(); return; }
        if ((key === "[" || key === "]") && activeTool) {
          const sizeOption = activeTool.options.find((option) => option.id === "size" && option.type === "number");
          if (sizeOption?.type === "number") { event.preventDefault(); const current = Number(store.toolOptions[activeTool.id]?.size ?? sizeOption.defaultValue); store.setToolOption(activeTool.id, "size", Math.max(sizeOption.min, Math.min(sizeOption.max, current + (key === "]" ? Math.max(1, Math.round(current * .1)) : -Math.max(1, Math.round(current * .1)))))); return; }
        }
        if (/^[0-9]$/.test(key) && activeTool?.options.some((option) => option.id === "opacity")) { event.preventDefault(); store.setToolOption(activeTool.id, event.shiftKey ? "flow" : "opacity", key === "0" ? 100 : Number(key) * 10); return; }
        const matching = toolsFor(active.kind).filter((item) => item.shortcut.toLocaleLowerCase() === key);
        const currentIndex = matching.findIndex((item) => item.id === activeToolId);
        const tool = event.shiftKey && matching.length > 1 ? matching[(currentIndex + 1 + matching.length) % matching.length] : matching[0];
        if (tool) { event.preventDefault(); store.setTool(active.id, tool.id); }
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
          ["New… (Новый…)", "Ctrl+N", () => store.requestNewDocument("raster")], ["Open… (Открыть…)", "Ctrl+O", () => openImageRef.current?.click()], ["Save project (Сохранить проект)", "Ctrl+S", saveProject], ["Export PNG… (Экспортировать PNG…)", "Ctrl+Alt+Shift+S", () => void exportPng()], ["Close (Закрыть)", "Ctrl+W", () => active && store.closeDocument(active.id)],
        ]}/>
        <Menu label="Edit (Правка)" language={store.language} open={openMenu === "edit"} onToggle={() => setOpenMenu(openMenu === "edit" ? null : "edit")} items={[["Undo (Отменить)", "Ctrl+Z", () => void kernel.commands.execute("edit.undo", activeCommandContext())], ["Redo (Повторить)", "Ctrl+Shift+Z", () => void kernel.commands.execute("edit.redo", activeCommandContext())], ["Free Transform (Свободная трансформация)", "Ctrl+T", () => window.dispatchEvent(new Event("vravio-transform-start"))]]}/>
        <Menu label="Image (Изображение)" language={store.language} open={openMenu === "image"} onToggle={() => setOpenMenu(openMenu === "image" ? null : "image")} items={[
          ["Brightness/Contrast… (Яркость/Контраст…)", "", () => addImageAdjustment("brightnessContrast", "Brightness/Contrast (Яркость/Контраст)"), !active || !isRasterDocumentState(active.state)],
          ["Levels… (Уровни…)", "Ctrl+Shift+L", () => addImageAdjustment("levels", "Levels (Уровни)"), !active || !isRasterDocumentState(active.state)],
          ["Curves… (Кривые…)", "Ctrl+M", () => addImageAdjustment("curves", "Curves (Кривые)"), !active || !isRasterDocumentState(active.state)],
          ["Hue/Saturation… (Тон/Насыщенность…)", "Ctrl+U", () => addImageAdjustment("hueSaturation", "Hue/Saturation (Тон/Насыщенность)"), !active || !isRasterDocumentState(active.state)],
          ["Color Balance… (Цветовой баланс…)", "Ctrl+B", () => addImageAdjustment("colorBalance", "Color Balance (Цветовой баланс)"), !active || !isRasterDocumentState(active.state)],
          ["Invert (Инверсия)", "Ctrl+I", () => addImageAdjustment("invert", "Invert (Инверсия)"), !active || !isRasterDocumentState(active.state)],
          ["Posterize… (Постеризация…)", "", () => addImageAdjustment("posterize", "Posterize (Постеризация)"), !active || !isRasterDocumentState(active.state)],
          ["Threshold… (Порог…)", "", () => addImageAdjustment("threshold", "Threshold (Порог)"), !active || !isRasterDocumentState(active.state)],
          ["Image Size… (Размер изображения…)", "Ctrl+Alt+I", () => {}, true],
          ["Canvas Size… (Размер холста…)", "Ctrl+Alt+C", () => {}, true],
        ]}/>
        <Menu label="Layer (Слой)" language={store.language} open={openMenu === "layer"} onToggle={() => setOpenMenu(openMenu === "layer" ? null : "layer")} items={[
          ["New Layer (Новый слой)", "Ctrl+Shift+N", () => void kernel.commands.execute("layer.new", activeCommandContext())],
          ["Duplicate Layer (Дублировать слой)", "Ctrl+J", duplicateActiveLayer, !active || !isRasterDocumentState(active.state)],
          ["Delete Layer (Удалить слой)", "", deleteActiveLayer, !active || !isRasterDocumentState(active.state)],
          ["Layer Style… (Стиль слоя…)", "", () => window.dispatchEvent(new Event("vravio-layer-style-open")), !active || active.kind !== "raster"],
          ["Merge Down (Объединить с нижним)", "Ctrl+E", () => {}, true],
          ["Flatten Image (Свести изображение)", "", () => {}, true],
        ]}/>
        <Menu label="Type (Текст)" language={store.language} open={openMenu === "type"} onToggle={() => setOpenMenu(openMenu === "type" ? null : "type")} items={[
          ["Faux Bold (Псевдо-полужирный)", "", () => toggleActiveTextStyle("bold"), !activeTextLayer],
          ["Faux Italic (Псевдо-курсив)", "", () => toggleActiveTextStyle("italic"), !activeTextLayer],
          ["Underline (Подчёркнутый)", "", () => toggleActiveTextStyle("underline"), !activeTextLayer],
          ["Warp Text… (Деформация текста…)", "", () => {}, true],
          ["Convert to Shape (Преобразовать в фигуру)", "", () => {}, true],
          ["Create Work Path (Создать рабочий контур)", "", () => {}, true],
        ]}/>
        <Menu label="Select (Выделение)" language={store.language} open={openMenu === "select"} onToggle={() => setOpenMenu(openMenu === "select" ? null : "select")} items={[["All (Всё)", "Ctrl+A", () => void kernel.commands.execute("select.all", activeCommandContext())], ["Deselect (Снять выделение)", "Ctrl+D", () => void kernel.commands.execute("select.none", activeCommandContext())], ["Inverse (Инверсия)", "Ctrl+Shift+I", () => void kernel.commands.execute("select.invert", activeCommandContext())]]}/>
        <Menu label="Filter (Фильтр)" language={store.language} open={openMenu === "filter"} onToggle={() => setOpenMenu(openMenu === "filter" ? null : "filter")} items={[["Filter Gallery… (Галерея фильтров…)", "", () => setFilterGalleryOpen(true), !active || active.kind!=="raster"], ["Camera Raw Filter… (Фильтр Camera Raw…)", "", () => void openCameraRawReprocess(), !activeRawOrigin], ["Liquify… (Пластика…)", "Ctrl+Shift+X", () => setLiquifyOpen(true), !active || !isRasterDocumentState(active.state)], ["Blur Gallery (Галерея размытия)", "", () => setFilterGalleryOpen(true), !active || active.kind!=="raster"], ["Sharpen (Усиление резкости)", "", () => setFilterGalleryOpen(true), !active || active.kind!=="raster"], ["Noise (Шум)", "", () => setFilterGalleryOpen(true), !active || active.kind!=="raster"], ["Stylize (Стилизация)", "", () => setFilterGalleryOpen(true), !active || active.kind!=="raster"]]}/>
        <Menu label="Plugins (Плагины)" language={store.language} open={openMenu === "plugins"} onToggle={() => setOpenMenu(openMenu === "plugins" ? null : "plugins")} items={[
          ["Manage Plugins… (Управление плагинами…)", "", () => {}, true],
        ]}/>
        <Menu label="View (Просмотр)" language={store.language} open={openMenu === "view"} onToggle={() => setOpenMenu(openMenu === "view" ? null : "view")} items={[["Fit on Screen (Подогнать по экрану)", "Ctrl+0", () => void kernel.commands.execute("view.fit", activeCommandContext())], ["Actual Pixels (Пиксель в пиксель)", "Ctrl+1", () => void kernel.commands.execute("view.actual", activeCommandContext())], ["Zoom In (Приблизить)", "Ctrl++", () => void kernel.commands.execute("view.zoomIn", activeCommandContext())], ["Zoom Out (Отдалить)", "Ctrl+-", () => void kernel.commands.execute("view.zoomOut", activeCommandContext())], [`${store.preferences.showRulers ? "✓ " : ""}Rulers (Линейки)`, "Ctrl+R", () => store.updatePreferences({ showRulers: !store.preferences.showRulers })], [`${store.preferences.showGuides ? "✓ " : ""}Guides (Направляющие)`, "Ctrl+;", () => store.updatePreferences({ showGuides: !store.preferences.showGuides })], ["Clear Guides (Удалить направляющие)", "", () => window.dispatchEvent(new Event("vravio-guides-clear")), !active || active.kind !== "raster"]]}/>
        <Menu label="Window (Окно)" language={store.language} open={openMenu === "window"} onToggle={() => setOpenMenu(openMenu === "window" ? null : "window")} items={[["Settings (Настройки)", "", () => store.setSettingsOpen(true)], ["Command Palette (Палитра команд)", "Ctrl+K", () => store.setPaletteOpen(true)]]}/>
        <Menu label="Help (Справка)" language={store.language} open={openMenu === "help"} onToggle={() => setOpenMenu(openMenu === "help" ? null : "help")} items={[["Diagnostics log (Журнал диагностики)", "", () => setDiagnosticsOpen(true)], ["About VRAVIO (О VRAVIO)", "", () => window.alert("VRAVIO — local-first creative suite")]]}/>
      </nav>
      <input ref={openImageRef} hidden type="file" accept={`image/png,image/jpeg,image/webp,image/gif,${rawFileExtensions.map((extension) => `.${extension}`).join(",")}`} onChange={(event) => { const file = event.target.files?.[0]; if (file) void importImage(file); event.currentTarget.value = ""; }}/>
      <button className="palette-button" onClick={() => store.setPaletteOpen(true)}>⌘ {store.language === "ru" ? "Команды" : "Commands"} <kbd>Ctrl K</kbd></button>
      <button className="settings-button" onClick={() => store.setSettingsOpen(true)} aria-label={store.language === "ru" ? "Настройки" : "Settings"} title={store.language === "ru" ? "Настройки" : "Settings"}>⚙</button>
    </header>

    {documents.length > 1 && <div className="document-tabs" role="tablist" aria-label="Documents (Документы)">
      {documents.map((document) => <div className="tab-wrap" key={document.id} data-kind={document.kind}>
        <button role="tab" aria-selected={document.id === store.activeDocumentId} onClick={() => store.activateDocument(document.id)}>
          <EnvironmentIcon kind={document.kind} className="tab-environment-icon" />{localized(document.name, store.language)}{document.dirty && <i>●</i>}
        </button>
        <button className="tab-close" aria-label={`Close ${document.name}`} onClick={() => store.closeDocument(document.id)}>×</button>
      </div>)}
    </div>}

    <OptionsBar language={store.language} tool={activeTool} values={activeTool ? { ...(store.toolOptions[activeTool.id] ?? {}), ...(activeTool.options.some((option) => option.id === "color") ? { color: store.foregroundColor } : {}) } : {}} transform={transformMetrics} onTransformCommit={() => window.dispatchEvent(new Event("vravio-transform-commit"))} onTransformCancel={() => window.dispatchEvent(new Event("vravio-transform-cancel"))} onChange={(id, value) => { if (!activeTool) return; store.setToolOption(activeTool.id, id, value); if (id === "color") store.setForegroundColor(String(value)); }} alignSelectionCount={active && isRasterDocumentState(active.state) ? (selectedLayerIds.length || 1) : 0} onAlign={(edge) => alignOrDistributeLayers("align", edge)} onDistribute={(edge) => alignOrDistributeLayers("distribute", edge)} />

    <main className="workspace" data-has-toolbar={active?.kind === "raster" || active?.kind === "vector"}>
      {(active?.kind === "raster" || active?.kind === "vector") && <aside className="toolbar" aria-label="Tools (Инструменты)">
        <ToolPalette kind={active.kind} language={store.language} activeToolId={activeToolId} openGroup={openToolGroup} onOpenGroup={setOpenToolGroup} onSelect={(toolId) => { store.setTool(active.id, toolId); setOpenToolGroup(null); }} />
        {active.kind === "raster" && <ColorWells foreground={store.foregroundColor} background={store.backgroundColor} onForeground={store.setForegroundColor} onBackground={store.setBackgroundColor} onSwap={store.swapColors} onReset={store.resetColors} />}
      </aside>}
      {active ? <DockLayout /> : <WelcomeScreen language={store.language} requestNewDocument={store.requestNewDocument} />}
    </main>
    <footer className="status-bar"><span>{localized(active ? environmentMeta[active.kind].label : "Ready (Готово)", store.language)}</span><span>{active ? `${Math.round((store.viewports[active.id]?.zoom ?? 1) * 100)}% · ` : ""}sRGB · 0 B</span></footer>

    {store.paletteOpen && <div className="dialog-backdrop" onMouseDown={() => store.setPaletteOpen(false)}>
      <section className="command-palette" role="dialog" aria-modal="true" aria-label="Command palette (Палитра команд)" onMouseDown={(event) => event.stopPropagation()}>
        <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder={store.language === "ru" ? "Введите команду…" : "Type a command…"} />
        <div>{commands.map((command) => <button key={command.id} disabled={command.isEnabled?.(activeCommandContext()) === false} onClick={() => { void kernel.commands.execute(command.id, activeCommandContext()); store.setPaletteOpen(false); }}><span>{localized(command.label, store.language)}</span>{command.shortcut && <kbd>{command.shortcut}</kbd>}</button>)}</div>
      </section>
    </div>}

    <SettingsDialog />
    {diagnosticsOpen && <div className="dialog-backdrop" onMouseDown={() => setDiagnosticsOpen(false)}><section className="diagnostics-dialog" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}><header><strong>Diagnostics log (Журнал диагностики)</strong><button onClick={() => setDiagnosticsOpen(false)}>×</button></header><div className="diagnostics-list">{diagnostics.length ? [...diagnostics].reverse().map((entry, index) => <article data-level={entry.level} key={`${entry.time}-${index}`}><time>{new Date(entry.time).toLocaleTimeString()}</time><b>{entry.area}</b><span>{entry.message}</span>{entry.detail && <pre>{entry.detail}</pre>}</article>) : <p>No events recorded (Событий пока нет).</p>}</div><footer><button onClick={() => { clearDiagnostics(); setDiagnostics([]); }}>Clear (Очистить)</button><button onClick={() => { const blob = new Blob([JSON.stringify(diagnostics, null, 2)], { type: "application/json" }); download(blob, `vravio-diagnostics-${Date.now()}.json`); }}>Export JSON (Экспорт JSON)</button></footer></section></div>}
    {filterGalleryOpen && active && isRasterDocumentState(active.state) && (()=>{const state=active.state;if(!isRasterDocumentState(state))return null;const layer=state.layers.find((item)=>item.id===state.activeLayerId);return layer?<FilterGalleryDialog layer={layer} onApply={applyFilter} onClose={()=>setFilterGalleryOpen(false)}/>:null;})()}
    {liquifyOpen && active && isRasterDocumentState(active.state) && (()=>{const state=active.state;if(!isRasterDocumentState(state))return null;const layer=state.layers.find((item)=>item.id===state.activeLayerId);return layer?<LiquifyDialog layer={layer} language={store.language} onApply={applyFilter} onClose={()=>setLiquifyOpen(false)}/>:null;})()}
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

type MainMenuItem = readonly [label: string, shortcut: string, action: () => void, disabled?: boolean];
function Menu({ label, language, open, onToggle, items }: { label: string; language: Language; open: boolean; onToggle(): void; items: readonly MainMenuItem[] }) {
  return <div className="main-menu"><button className={open ? "active" : ""} onClick={onToggle}>{localized(label, language)}</button>{open && <div className="main-menu-dropdown">{items.map(([itemLabel, shortcut, action, disabled]) => <button key={itemLabel} disabled={disabled} onClick={() => { action(); onToggle(); }}><span>{localized(itemLabel, language)}</span><kbd>{shortcut}</kbd></button>)}</div>}</div>;
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
      <button className={group.some((tool) => tool.id === activeToolId) ? "active" : ""} title={`${localized(selected.label, language)} [${selected.shortcut}]`} aria-label={localized(selected.label, language)} onClick={() => onSelect(selected.id)}><ToolGlyph tool={selected} /></button>
      {group.length > 1 && <button className="tool-group-arrow" aria-label={language === "ru" ? "Показать группу инструментов" : "Show tool group"} onClick={() => onOpenGroup(openGroup === groupId ? null : groupId)}>▾</button>}
      {openGroup === groupId && <div className="tool-flyout">{group.map((tool) => <button key={tool.id} className={tool.id === activeToolId ? "active" : ""} onClick={() => onSelect(tool.id)}><ToolGlyph tool={tool} /><span>{localized(tool.label, language)}</span><kbd>{tool.shortcut}</kbd></button>)}</div>}
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
        <strong>{localized(meta.label, language)}</strong>
        <small>{language === "ru" ? meta.descriptionRu : meta.description}</small>
      </button>)}
    </div>
  </div></div>;
}

function ColorWells({ foreground, background, onForeground, onBackground, onSwap, onReset }: { foreground: string; background: string; onForeground(color: string): void; onBackground(color: string): void; onSwap(): void; onReset(): void }) {
  return <div className="color-wells" title="Foreground / Background (Основной / дополнительный цвет)">
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

function OptionsBar({ language, tool, values, transform, onTransformCommit, onTransformCancel, onChange, alignSelectionCount, onAlign, onDistribute }: { language: Language; tool: ReturnType<typeof toolById>; values: Record<string, string | number | boolean>; transform: { active: boolean; x: number; y: number; width: number; height: number; rotation: number } | null; onTransformCommit(): void; onTransformCancel(): void; onChange(id: string, value: string | number | boolean): void; alignSelectionCount: number; onAlign(edge: AlignEdge): void; onDistribute(edge: AlignEdge): void }) {
  if (transform?.active) return <div className="options-bar transform-options"><strong>Free Transform (Свободная трансформация)</strong><label>X:<input value={Math.round(transform.x)} readOnly/></label><label>Y:<input value={Math.round(transform.y)} readOnly/></label><label>W:<input value={Math.round(transform.width)} readOnly/></label><label>H:<input value={Math.round(transform.height)} readOnly/></label><label>∠:<input value={`${Math.round(transform.rotation * 10) / 10}°`} readOnly/></label><button title="Cancel (Отмена)" onClick={onTransformCancel}>×</button><button className="commit" title="Commit (Подтвердить)" onClick={onTransformCommit}>✓</button></div>;
  return <div className="options-bar"><strong>{localized(tool?.label ?? "Tool options (Параметры инструмента)", language)}</strong>{tool ? tool.options.map((option) => <OptionField key={option.id} language={language} option={option} value={values[option.id] ?? option.defaultValue} onChange={(value) => onChange(option.id, value)} />) : <span className="muted">{language === "ru" ? "Выберите или создайте документ" : "Select or create a document"}</span>}{tool?.id === "raster.move" && <AlignDistributeBar selectionCount={alignSelectionCount} onAlign={onAlign} onDistribute={onDistribute}/>}</div>;
}

function OptionField({ language, option, value, onChange }: { language: Language; option: ToolOption; value: string | number | boolean; onChange(value: string | number | boolean): void }) {
  const label = localized(option.label, language);
  if (option.type === "boolean") return <label className="option-field check"><input type="checkbox" checked={Boolean(value)} onChange={(event) => onChange(event.target.checked)} />{label}</label>;
  if (option.type === "select") return <label className="option-field">{label}<select value={String(value)} onChange={(event) => onChange(event.target.value)}>{option.values.map((item) => <option value={item.value} key={item.value}>{localized(item.label, language)}</option>)}</select></label>;
  if (option.type === "color") return <label className="option-field color-field">{label}<input type="color" value={String(value)} onChange={(event) => onChange(event.target.value)} /></label>;
  return <label className="option-field">{label}<span><input type="number" min={option.min} max={option.max} step={option.step} value={Number(value)} onChange={(event) => onChange(event.target.valueAsNumber)} />{option.unit}</span></label>;
}
