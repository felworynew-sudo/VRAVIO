import type { EnvironmentKind } from "@vravio/kernel";

export type ToolOption =
  | { id: string; label: string; type: "number"; min: number; max: number; step: number; defaultValue: number; unit?: string }
  | { id: string; label: string; type: "boolean"; defaultValue: boolean }
  | { id: string; label: string; type: "color"; defaultValue: string }
  | { id: string; label: string; type: "select"; defaultValue: string; values: readonly { value: string; label: string }[] };

export interface ToolDefinition {
  id: string;
  kind: EnvironmentKind;
  icon: string;
  iconFile?: string;
  label: string;
  shortcut: string;
  options: readonly ToolOption[];
}

const size: ToolOption = { id: "size", label: "Size (Размер)", type: "number", min: 1, max: 1000, step: 1, defaultValue: 24, unit: "px" };
const opacity: ToolOption = { id: "opacity", label: "Opacity (Непрозрачность)", type: "number", min: 0, max: 100, step: 1, defaultValue: 100, unit: "%" };
const color: ToolOption = { id: "color", label: "Color (Цвет)", type: "color", defaultValue: "#5be0b3" };
const brushTipOptions: readonly ToolOption[] = [size,
  { id: "hardness", label: "Hardness (Жёсткость)", type: "number", min: 0, max: 100, step: 1, defaultValue: 82, unit: "%" },
  { id: "spacing", label: "Spacing (Интервал)", type: "number", min: 1, max: 1000, step: 1, defaultValue: 12, unit: "%" },
  { id: "roundness", label: "Roundness (Округлость)", type: "number", min: 1, max: 100, step: 1, defaultValue: 100, unit: "%" },
  { id: "angle", label: "Angle (Угол)", type: "number", min: -180, max: 180, step: 1, defaultValue: 0, unit: "°" },
];

export const tools: readonly ToolDefinition[] = [
  { id: "raster.move", kind: "raster", icon: "↖", iconFile: "КУРСОР.svg", label: "Move Tool (Перемещение)", shortcut: "V", options: [{ id: "autoSelect", label: "Auto-select (Автовыбор)", type: "boolean", defaultValue: true }, { id: "showTransform", label: "Transform controls (Элементы трансформации)", type: "boolean", defaultValue: true }] },
  { id: "raster.hand", kind: "raster", icon: "✋", iconFile: "РУКА.svg", label: "Hand Tool (Рука)", shortcut: "H", options: [] },
  { id: "raster.rotateView", kind: "raster", icon: "↻", iconFile: "ВРАЩЕНИЕ ВИДА.svg", label: "Rotate View Tool (Вращение вида)", shortcut: "R", options: [] },
  { id: "raster.zoom", kind: "raster", icon: "⌕", iconFile: "ЛУПА.svg", label: "Zoom Tool (Масштаб)", shortcut: "Z", options: [{ id: "dragZoom", label: "Scrubby zoom (Масштабирование перетаскиванием)", type: "boolean", defaultValue: true }] },
  { id: "raster.marquee", kind: "raster", icon: "⬚", iconFile: "ВЫДЕЛЕН.svg", label: "Marquee Tool (Область выделения)", shortcut: "M", options: [{ id: "mode", label: "Mode (Режим)", type: "select", defaultValue: "replace", values: [{ value: "replace", label: "Replace (Заменить)" }, { value: "add", label: "Add (Добавить)" }, { value: "subtract", label: "Subtract (Вычесть)" }, { value: "intersect", label: "Intersect (Пересечь)" }] }, { id: "feather", label: "Feather (Растушёвка)", type: "number", min: 0, max: 500, step: 1, defaultValue: 0, unit: "px" }] },
  { id: "raster.ellipseMarquee", kind: "raster", icon: "◯", iconFile: "ЭЛИПС.svg", label: "Elliptical Marquee Tool (Овальная область)", shortcut: "M", options: [{ id: "mode", label: "Mode (Режим)", type: "select", defaultValue: "replace", values: [{ value: "replace", label: "Replace (Заменить)" }, { value: "add", label: "Add (Добавить)" }, { value: "subtract", label: "Subtract (Вычесть)" }, { value: "intersect", label: "Intersect (Пересечь)" }] }, { id: "feather", label: "Feather (Растушёвка)", type: "number", min: 0, max: 500, step: 1, defaultValue: 0, unit: "px" }] },
  { id: "raster.lasso", kind: "raster", icon: "⌁", iconFile: "ЛАССО.svg", label: "Lasso Tool (Лассо)", shortcut: "L", options: [{ id: "mode", label: "Mode (Режим)", type: "select", defaultValue: "replace", values: [{ value: "replace", label: "Replace (Заменить)" }, { value: "add", label: "Add (Добавить)" }, { value: "subtract", label: "Subtract (Вычесть)" }, { value: "intersect", label: "Intersect (Пересечь)" }] }, { id: "feather", label: "Feather (Растушёвка)", type: "number", min: 0, max: 500, step: 1, defaultValue: 0, unit: "px" }] },
  { id: "raster.magicWand", kind: "raster", icon: "✦", iconFile: "ВОЛШЕБНАЯ ПАЛОЧКА.svg", label: "Magic Wand Tool (Волшебная палочка)", shortcut: "W", options: [{ id: "tolerance", label: "Tolerance (Допуск)", type: "number", min: 0, max: 255, step: 1, defaultValue: 32 }, { id: "allLayers", label: "Sample all layers (Все слои)", type: "boolean", defaultValue: true }] },
  { id: "raster.brush", kind: "raster", icon: "●", iconFile: "КИСТЬ.svg", label: "Brush Tool (Кисть)", shortcut: "B", options: [...brushTipOptions, opacity, color, { id: "flow", label: "Flow (Подача)", type: "number", min: 1, max: 100, step: 1, defaultValue: 100, unit: "%" }, { id: "pressureSize", label: "Pen pressure: size (Нажим: размер)", type: "boolean", defaultValue: true }, { id: "pressureOpacity", label: "Pen pressure: opacity (Нажим: непрозрачность)", type: "boolean", defaultValue: false }] },
  { id: "raster.pencil", kind: "raster", icon: "✎", iconFile: "КАРАНДАШ.svg", label: "Pencil Tool (Карандаш)", shortcut: "B", options: [size, opacity, color] },
  { id: "raster.highlighter", kind: "raster", icon: "▰", iconFile: "ВЫДЕЛИТЕЛЬ.svg", label: "Highlighter Tool (Выделитель)", shortcut: "B", options: [size, { ...opacity, defaultValue: 35 }, color] },
  { id: "raster.eraser", kind: "raster", icon: "◩", iconFile: "ЛАСТИК.svg", label: "Eraser Tool (Ластик)", shortcut: "E", options: [...brushTipOptions, opacity, { id: "flow", label: "Flow (Подача)", type: "number", min: 1, max: 100, step: 1, defaultValue: 100, unit: "%" }] },
  { id: "raster.blur", kind: "raster", icon: "◌", iconFile: "РАЗМЫТИЕ.svg", label: "Blur Tool (Размытие)", shortcut: "R", options: [...brushTipOptions, { id: "strength", label: "Strength (Интенсивность)", type: "number", min: 1, max: 100, step: 1, defaultValue: 50, unit: "%" }] },
  { id: "raster.smudge", kind: "raster", icon: "≈", iconFile: "ПАЛЕЦ.svg", label: "Smudge Tool (Палец)", shortcut: "R", options: [...brushTipOptions, { id: "strength", label: "Strength (Интенсивность)", type: "number", min: 1, max: 100, step: 1, defaultValue: 50, unit: "%" }] },
  { id: "raster.dodge", kind: "raster", icon: "☉", iconFile: "ОСВЕТЛИТЕЛЬ.svg", label: "Dodge Tool (Осветлитель)", shortcut: "O", options: [...brushTipOptions, { id: "exposure", label: "Exposure (Экспозиция)", type: "number", min: 1, max: 100, step: 1, defaultValue: 50, unit: "%" }, { id: "range", label: "Range (Диапазон)", type: "select", defaultValue: "midtones", values: [{ value: "shadows", label: "Shadows (Тени)" }, { value: "midtones", label: "Midtones (Полутона)" }, { value: "highlights", label: "Highlights (Света)" }] }] },
  { id: "raster.burn", kind: "raster", icon: "☾", iconFile: "ЗАТЕМНИТЕЛЬ.svg", label: "Burn Tool (Затемнитель)", shortcut: "O", options: [...brushTipOptions, { id: "exposure", label: "Exposure (Экспозиция)", type: "number", min: 1, max: 100, step: 1, defaultValue: 50, unit: "%" }, { id: "range", label: "Range (Диапазон)", type: "select", defaultValue: "midtones", values: [{ value: "shadows", label: "Shadows (Тени)" }, { value: "midtones", label: "Midtones (Полутона)" }, { value: "highlights", label: "Highlights (Света)" }] }] },
  { id: "raster.fill", kind: "raster", icon: "◒", iconFile: "Заливка.svg", label: "Paint Bucket Tool (Заливка)", shortcut: "G", options: [color, { id: "tolerance", label: "Tolerance (Допуск)", type: "number", min: 0, max: 255, step: 1, defaultValue: 32 }] },
  { id: "raster.eyedropper", kind: "raster", icon: "⌁", iconFile: "Пипетка.svg", label: "Eyedropper Tool (Пипетка)", shortcut: "I", options: [{ id: "sample", label: "Sample size (Размер образца)", type: "select", defaultValue: "point", values: [{ value: "point", label: "Point (Точка)" }, { value: "3", label: "3 × 3 Average" }, { value: "5", label: "5 × 5 Average" }, { value: "11", label: "11 × 11 Average" }] }, { id: "allLayers", label: "Sample all layers (Все слои)", type: "boolean", defaultValue: true }] },
  { id: "raster.text", kind: "raster", icon: "T", iconFile: "ТЕКСТ.svg", label: "Type Tool (Текст)", shortcut: "T", options: [color, { id: "fontSize", label: "Font size (Размер шрифта)", type: "number", min: 1, max: 1000, step: 1, defaultValue: 48, unit: "px" }, { id: "fontFamily", label: "Font (Шрифт)", type: "select", defaultValue: "Arial", values: [{ value: "Arial", label: "Arial" }, { value: "Georgia", label: "Georgia" }, { value: "Verdana", label: "Verdana" }, { value: "monospace", label: "Monospace (Моноширинный)" }] }] },
  { id: "raster.crop", kind: "raster", icon: "⌗", iconFile: "МОНТАЖ.svg", label: "Crop Tool (Рамка)", shortcut: "C", options: [{ id: "deletePixels", label: "Delete cropped pixels (Удалить обрезанные пиксели)", type: "boolean", defaultValue: false }] },
  { id: "raster.clone", kind: "raster", icon: "⧉", iconFile: "ШТАМП.svg", label: "Clone Tool (Штамп)", shortcut: "S", options: [...brushTipOptions, opacity, { id: "cloneType", label: "Source (Источник)", type: "select", defaultValue: "image", values: [{ value: "image", label: "Image (Изображение)" }, { value: "pattern", label: "Pattern (Узор)" }] }, { id: "alignMode", label: "Alignment (Выравнивание)", type: "select", defaultValue: "registered", values: [{ value: "none", label: "None (Нет)" }, { value: "registered", label: "Registered (Совместное)" }, { value: "fixed", label: "Fixed (Фиксированное)" }] }] },
  { id: "raster.spotHeal", kind: "raster", icon: "⊕", iconFile: "точечная востанавливающая кисть.svg", label: "Spot Healing Brush (Точечная восстанавливающая)", shortcut: "J", options: [...brushTipOptions, opacity, { id: "sampleAllLayers", label: "Sample all layers (Все слои)", type: "boolean", defaultValue: false }] },
  { id: "raster.patch", kind: "raster", icon: "⊞", iconFile: "заплатка.svg", label: "Patch Tool (Заплатка)", shortcut: "J", options: [{ id: "mode", label: "Mode (Режим)", type: "select", defaultValue: "source", values: [{ value: "source", label: "Source (Источник)" }, { value: "destination", label: "Destination (Назначение)" }] }, { id: "feather", label: "Feather (Растушёвка)", type: "number", min: 0, max: 250, step: 1, defaultValue: 0, unit: "px" }] },
  { id: "vector.select", kind: "vector", icon: "↖", iconFile: "КУРСОР.svg", label: "Selection Tool (Выделение)", shortcut: "V", options: [{ id: "transform", label: "Transform handles (Маркеры трансформации)", type: "boolean", defaultValue: true }] },
  { id: "vector.nodes", kind: "vector", icon: "◇", iconFile: "ПЕРО_1.svg", label: "Node Tool (Узлы)", shortcut: "A", options: [{ id: "showHandles", label: "Bézier handles (Ручки Безье)", type: "boolean", defaultValue: true }] },
  { id: "vector.pen", kind: "vector", icon: "⌁", iconFile: "ПЕРО.svg", label: "Pen Tool (Перо)", shortcut: "P", options: [color, { id: "strokeWidth", label: "Stroke (Обводка)", type: "number", min: 0, max: 1000, step: 0.25, defaultValue: 2, unit: "px" }] },
  { id: "vector.rectangle", kind: "vector", icon: "□", iconFile: "КВАДРАТ.svg", label: "Rectangle Tool (Прямоугольник)", shortcut: "R", options: [color, { id: "radius", label: "Corner radius (Радиус углов)", type: "number", min: 0, max: 1000, step: 1, defaultValue: 0, unit: "px" }] },
  { id: "vector.ellipse", kind: "vector", icon: "○", iconFile: "ЭЛИПС.svg", label: "Ellipse Tool (Эллипс)", shortcut: "O", options: [color] },
  { id: "vector.text", kind: "vector", icon: "T", iconFile: "ТЕКСТ.svg", label: "Type Tool (Текст)", shortcut: "T", options: [color, { id: "fontSize", label: "Font size (Размер шрифта)", type: "number", min: 1, max: 1000, step: 1, defaultValue: 48, unit: "px" }] },
];

export const rasterToolGroups: readonly (readonly string[])[] = [
  ["raster.move"],
  ["raster.marquee", "raster.ellipseMarquee", "raster.lasso", "raster.magicWand"],
  ["raster.brush", "raster.pencil", "raster.highlighter"],
  ["raster.eraser"],
  ["raster.blur", "raster.smudge"],
  ["raster.clone", "raster.spotHeal", "raster.patch"],
  ["raster.dodge", "raster.burn"],
  ["raster.fill"],
  ["raster.eyedropper"],
  ["raster.text"],
  ["raster.crop"],
  ["raster.hand", "raster.rotateView", "raster.zoom"],
];

export function toolsFor(kind: EnvironmentKind | undefined): readonly ToolDefinition[] {
  return kind ? tools.filter((tool) => tool.kind === kind) : [];
}

export function toolById(id: string | undefined): ToolDefinition | undefined {
  return id ? tools.find((tool) => tool.id === id) : undefined;
}

export function defaultTool(kind: EnvironmentKind): string | undefined {
  return toolsFor(kind)[0]?.id;
}
