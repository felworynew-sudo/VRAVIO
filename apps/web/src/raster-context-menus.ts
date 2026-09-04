import type { RasterDocumentState, SelectionCombineMode } from "@vravio/env-raster";
import { enterQuadTransformMode, enterWarpTransformMode, pendingBounds, type MoveState, type QuadTransformMode } from "./environments/raster/tools/definitions/move";
import type { ToolContext } from "./environments/raster/tools/types";
import { useContextMenu } from "./ContextMenu";
import { text } from "./i18n";
import type { Language } from "./store";

/**
 * The two right-click menus that belong to a gesture already in progress
 * rather than to any one pointer event — split out of `RasterWorkspace.tsx`
 * purely to bring its own line count down (docs/migration-plan.md §8).
 * Neither has a pointer gesture of its own to hang a hook off, the same
 * category raster.move's Skew/Distort/Perspective/Warp menu and the pen
 * tool's Finish/Close/Delete-Point/Delete-Path menu (`VectorWorkspace.tsx`)
 * are in, so both stay host-level chrome that calls straight into the tool's
 * own state via a freshly built `toolContextFor`.
 */
export function useRasterContextMenus(params: {
  activeToolId: string | undefined;
  toolOptions: Record<string, Record<string, string | number | boolean>>;
  setToolOption: (toolId: string, optionId: string, value: string | number | boolean) => void;
  language: Language;
  state: RasterDocumentState;
  toolContextFor: (toolId: string, canvas: HTMLCanvasElement | null) => ToolContext<unknown>;
  canvas: HTMLCanvasElement | null;
  selectionLike: boolean;
}) {
  const { activeToolId, toolOptions, setToolOption, language, state, toolContextFor, canvas, selectionLike } = params;
  const selectionContextMenu = useContextMenu();
  const transformContextMenu = useContextMenu();

  const onSelectionContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    if (!selectionLike || !activeToolId) return;
    const currentMode = String(toolOptions[activeToolId]?.mode ?? "replace");
    const modes: { value: SelectionCombineMode; english: string; russian: string }[] = [
      { value: "replace", english: "Replace Selection", russian: "Заменить выделение" },
      { value: "add", english: "Add to Selection", russian: "Добавить к выделению" },
      { value: "subtract", english: "Subtract from Selection", russian: "Вычесть из выделения" },
      { value: "intersect", english: "Intersect with Selection", russian: "Пересечь с выделением" },
    ];
    selectionContextMenu.open(event, modes.map((entry) => ({
      label: (currentMode === entry.value ? "✓ " : "") + text(language, entry.english, entry.russian),
      onSelect: () => setToolOption(activeToolId, "mode", entry.value),
    })));
  };

  // The transform tool's own right-click menu: Photoshop's Edit > Transform submodes, offered
  // only once a Free Transform is actually active on a pixel layer (a text transform stays on
  // the rectangular path — quad-warping live text has no defined meaning here).
  const onTransformContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    const context = toolContextFor("raster.move", canvas) as ToolContext<MoveState>;
    const pending = context.state.pending;
    if (activeToolId !== "raster.move" || !pending || pending.text) return;
    const bounds = pendingBounds(pending, state.width, state.height);
    if (!bounds) return;
    const currentMode = pending.corners ? String(toolOptions["raster.move"]?.transformMode ?? "distort") : pending.mesh ? "warp" : "free";
    const enterQuadMode = (mode: QuadTransformMode) => {
      setToolOption("raster.move", "transformMode", mode);
      context.setState({ pending: enterQuadTransformMode(pending, bounds), drag: null });
    };
    const enterWarp = () => {
      context.setState({ pending: enterWarpTransformMode(pending, bounds), drag: null });
    };
    const modes: { value: QuadTransformMode; english: string; russian: string }[] = [
      { value: "skew", english: "Skew", russian: "Наклон" },
      { value: "distort", english: "Distort", russian: "Искажение" },
      { value: "perspective", english: "Perspective", russian: "Перспектива" },
    ];
    transformContextMenu.open(event, [
      ...modes.map((entry) => ({
        label: (currentMode === entry.value ? "✓ " : "") + text(language, entry.english, entry.russian),
        onSelect: () => enterQuadMode(entry.value),
      })),
      { label: (currentMode === "warp" ? "✓ " : "") + text(language, "Warp", "Деформация"), onSelect: enterWarp, separatorBefore: true },
    ]);
  };

  return { selectionContextMenu, transformContextMenu, onSelectionContextMenu, onTransformContextMenu };
}
