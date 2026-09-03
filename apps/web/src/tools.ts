import type { EnvironmentKind } from "@vravio/kernel";
import type { LocalizedText } from "./i18n";

export type ToolOption =
  | { id: string; label: LocalizedText; type: "number"; min: number; max: number; step: number; defaultValue: number; unit?: string }
  | { id: string; label: LocalizedText; type: "boolean"; defaultValue: boolean }
  | { id: string; label: LocalizedText; type: "color"; defaultValue: string }
  | { id: string; label: LocalizedText; type: "select"; defaultValue: string; values: readonly { value: string; label: LocalizedText }[] };

export interface ToolDefinition {
  id: string;
  kind: EnvironmentKind;
  icon: string;
  iconFile?: string;
  label: LocalizedText;
  shortcut: string;
  options: readonly ToolOption[];
}

const size: ToolOption = { id: "size", label: { en: "Size", ru: "Размер" }, type: "number", min: 1, max: 1000, step: 1, defaultValue: 24, unit: "px" };
const opacity: ToolOption = { id: "opacity", label: { en: "Opacity", ru: "Непрозрачность" }, type: "number", min: 0, max: 100, step: 1, defaultValue: 100, unit: "%" };
const color: ToolOption = { id: "color", label: { en: "Color", ru: "Цвет" }, type: "color", defaultValue: "#5be0b3" };
const brushTipOptions: readonly ToolOption[] = [size,
  { id: "hardness", label: { en: "Hardness", ru: "Жёсткость" }, type: "number", min: 0, max: 100, step: 1, defaultValue: 82, unit: "%" },
  { id: "spacing", label: { en: "Spacing", ru: "Интервал" }, type: "number", min: 1, max: 1000, step: 1, defaultValue: 12, unit: "%" },
  { id: "roundness", label: { en: "Roundness", ru: "Округлость" }, type: "number", min: 1, max: 100, step: 1, defaultValue: 100, unit: "%" },
  { id: "angle", label: { en: "Angle", ru: "Угол" }, type: "number", min: -180, max: 180, step: 1, defaultValue: 0, unit: "°" },
];

export const tools: readonly ToolDefinition[] = [
  { id: "raster.move", kind: "raster", icon: "↖", iconFile: "КУРСОР.svg", label: { en: "Move Tool", ru: "Перемещение" }, shortcut: "V", options: [{ id: "autoSelect", label: { en: "Auto-select", ru: "Автовыбор" }, type: "boolean", defaultValue: true }, { id: "autoSelectTarget", label: { en: "" }, type: "select", defaultValue: "layer", values: [{ value: "layer", label: { en: "Layer", ru: "Слой" } }, { value: "group", label: { en: "Group", ru: "Группа" } }] }, { id: "showTransform", label: { en: "Transform controls", ru: "Элементы трансформации" }, type: "boolean", defaultValue: true }] },
  { id: "raster.hand", kind: "raster", icon: "✋", iconFile: "РУКА.svg", label: { en: "Hand Tool", ru: "Рука" }, shortcut: "H", options: [] },
  { id: "raster.rotateView", kind: "raster", icon: "↻", iconFile: "ВРАЩЕНИЕ ВИДА.svg", label: { en: "Rotate View Tool", ru: "Вращение вида" }, shortcut: "R", options: [] },
  { id: "raster.zoom", kind: "raster", icon: "⌕", iconFile: "ЛУПА.svg", label: { en: "Zoom Tool", ru: "Масштаб" }, shortcut: "Z", options: [{ id: "dragZoom", label: { en: "Scrubby zoom", ru: "Масштабирование перетаскиванием" }, type: "boolean", defaultValue: true }] },
  { id: "raster.marquee", kind: "raster", icon: "⬚", iconFile: "ВЫДЕЛЕН.svg", label: { en: "Marquee Tool", ru: "Область выделения" }, shortcut: "M", options: [{ id: "mode", label: { en: "Mode", ru: "Режим" }, type: "select", defaultValue: "replace", values: [{ value: "replace", label: { en: "Replace", ru: "Заменить" } }, { value: "add", label: { en: "Add", ru: "Добавить" } }, { value: "subtract", label: { en: "Subtract", ru: "Вычесть" } }, { value: "intersect", label: { en: "Intersect", ru: "Пересечь" } }] }, { id: "feather", label: { en: "Feather", ru: "Растушёвка" }, type: "number", min: 0, max: 500, step: 1, defaultValue: 0, unit: "px" }] },
  { id: "raster.ellipseMarquee", kind: "raster", icon: "◯", iconFile: "ЭЛИПС.svg", label: { en: "Elliptical Marquee Tool", ru: "Овальная область" }, shortcut: "M", options: [{ id: "mode", label: { en: "Mode", ru: "Режим" }, type: "select", defaultValue: "replace", values: [{ value: "replace", label: { en: "Replace", ru: "Заменить" } }, { value: "add", label: { en: "Add", ru: "Добавить" } }, { value: "subtract", label: { en: "Subtract", ru: "Вычесть" } }, { value: "intersect", label: { en: "Intersect", ru: "Пересечь" } }] }, { id: "feather", label: { en: "Feather", ru: "Растушёвка" }, type: "number", min: 0, max: 500, step: 1, defaultValue: 0, unit: "px" }] },
  { id: "raster.lasso", kind: "raster", icon: "⌁", iconFile: "ЛАССО.svg", label: { en: "Lasso Tool", ru: "Лассо" }, shortcut: "L", options: [{ id: "mode", label: { en: "Mode", ru: "Режим" }, type: "select", defaultValue: "replace", values: [{ value: "replace", label: { en: "Replace", ru: "Заменить" } }, { value: "add", label: { en: "Add", ru: "Добавить" } }, { value: "subtract", label: { en: "Subtract", ru: "Вычесть" } }, { value: "intersect", label: { en: "Intersect", ru: "Пересечь" } }] }, { id: "feather", label: { en: "Feather", ru: "Растушёвка" }, type: "number", min: 0, max: 500, step: 1, defaultValue: 0, unit: "px" }] },
  { id: "raster.magicWand", kind: "raster", icon: "✦", iconFile: "ВОЛШЕБНАЯ ПАЛОЧКА.svg", label: { en: "Magic Wand Tool", ru: "Волшебная палочка" }, shortcut: "W", options: [{ id: "tolerance", label: { en: "Tolerance", ru: "Допуск" }, type: "number", min: 0, max: 255, step: 1, defaultValue: 32 }, { id: "allLayers", label: { en: "Sample all layers", ru: "Все слои" }, type: "boolean", defaultValue: true }] },
  { id: "raster.brush", kind: "raster", icon: "●", iconFile: "КИСТЬ.svg", label: { en: "Brush Tool", ru: "Кисть" }, shortcut: "B", options: [...brushTipOptions, opacity, color, { id: "flow", label: { en: "Flow", ru: "Подача" }, type: "number", min: 1, max: 100, step: 1, defaultValue: 100, unit: "%" }, { id: "pressureSize", label: { en: "Pen pressure: size", ru: "Нажим: размер" }, type: "boolean", defaultValue: true }, { id: "pressureOpacity", label: { en: "Pen pressure: opacity", ru: "Нажим: непрозрачность" }, type: "boolean", defaultValue: false }] },
  { id: "raster.pencil", kind: "raster", icon: "✎", iconFile: "КАРАНДАШ.svg", label: { en: "Pencil Tool", ru: "Карандаш" }, shortcut: "B", options: [size, opacity, color] },
  { id: "raster.highlighter", kind: "raster", icon: "▰", iconFile: "ВЫДЕЛИТЕЛЬ.svg", label: { en: "Highlighter Tool", ru: "Выделитель" }, shortcut: "B", options: [size, { ...opacity, defaultValue: 35 }, color] },
  { id: "raster.eraser", kind: "raster", icon: "◩", iconFile: "ЛАСТИК.svg", label: { en: "Eraser Tool", ru: "Ластик" }, shortcut: "E", options: [...brushTipOptions, opacity, { id: "flow", label: { en: "Flow", ru: "Подача" }, type: "number", min: 1, max: 100, step: 1, defaultValue: 100, unit: "%" }] },
  // No "spacing": blur sweeps a stroke as one continuous integral-image
  // pass, not discrete overlapping dabs, so there is no dab interval for
  // the option to mean anything about — see tonal-stroke.ts.
  { id: "raster.blur", kind: "raster", icon: "◌", iconFile: "РАЗМЫТИЕ.svg", label: { en: "Blur Tool", ru: "Размытие" }, shortcut: "R", options: [...brushTipOptions.filter((option) => option.id !== "spacing"), { id: "strength", label: { en: "Strength", ru: "Интенсивность" }, type: "number", min: 1, max: 100, step: 1, defaultValue: 50, unit: "%" }] },
  { id: "raster.smudge", kind: "raster", icon: "≈", iconFile: "ПАЛЕЦ.svg", label: { en: "Smudge Tool", ru: "Палец" }, shortcut: "R", options: [...brushTipOptions, { id: "strength", label: { en: "Strength", ru: "Интенсивность" }, type: "number", min: 1, max: 100, step: 1, defaultValue: 50, unit: "%" }] },
  { id: "raster.dodge", kind: "raster", icon: "☉", iconFile: "ОСВЕТЛИТЕЛЬ.svg", label: { en: "Dodge Tool", ru: "Осветлитель" }, shortcut: "O", options: [...brushTipOptions, { id: "exposure", label: { en: "Exposure", ru: "Экспозиция" }, type: "number", min: 1, max: 100, step: 1, defaultValue: 50, unit: "%" }, { id: "range", label: { en: "Range", ru: "Диапазон" }, type: "select", defaultValue: "midtones", values: [{ value: "shadows", label: { en: "Shadows", ru: "Тени" } }, { value: "midtones", label: { en: "Midtones", ru: "Полутона" } }, { value: "highlights", label: { en: "Highlights", ru: "Света" } }] }] },
  { id: "raster.burn", kind: "raster", icon: "☾", iconFile: "ЗАТЕМНИТЕЛЬ.svg", label: { en: "Burn Tool", ru: "Затемнитель" }, shortcut: "O", options: [...brushTipOptions, { id: "exposure", label: { en: "Exposure", ru: "Экспозиция" }, type: "number", min: 1, max: 100, step: 1, defaultValue: 50, unit: "%" }, { id: "range", label: { en: "Range", ru: "Диапазон" }, type: "select", defaultValue: "midtones", values: [{ value: "shadows", label: { en: "Shadows", ru: "Тени" } }, { value: "midtones", label: { en: "Midtones", ru: "Полутона" } }, { value: "highlights", label: { en: "Highlights", ru: "Света" } }] }] },
  { id: "raster.fill", kind: "raster", icon: "◒", iconFile: "Заливка.svg", label: { en: "Paint Bucket Tool", ru: "Заливка" }, shortcut: "G", options: [color, { id: "tolerance", label: { en: "Tolerance", ru: "Допуск" }, type: "number", min: 0, max: 255, step: 1, defaultValue: 32 }] },
  { id: "raster.eyedropper", kind: "raster", icon: "⌁", iconFile: "Пипетка.svg", label: { en: "Eyedropper Tool", ru: "Пипетка" }, shortcut: "I", options: [{ id: "sample", label: { en: "Sample size", ru: "Размер образца" }, type: "select", defaultValue: "point", values: [{ value: "point", label: { en: "Point", ru: "Точка" } }, { value: "3", label: { en: "3 × 3 Average" } }, { value: "5", label: { en: "5 × 5 Average" } }, { value: "11", label: { en: "11 × 11 Average" } }] }, { id: "allLayers", label: { en: "Sample all layers", ru: "Все слои" }, type: "boolean", defaultValue: true }, { id: "loupe", label: { en: "Show loupe", ru: "Показывать лупу" }, type: "boolean", defaultValue: true }] },
  { id: "raster.text", kind: "raster", icon: "T", iconFile: "ТЕКСТ.svg", label: { en: "Type Tool", ru: "Текст" }, shortcut: "T", options: [{ id: "textMode", label: { en: "Mode", ru: "Режим" }, type: "select", defaultValue: "auto", values: [{ value: "auto", label: { en: "Point / Paragraph", ru: "Точечный / Блочный" } }, { value: "path", label: { en: "Text on Path", ru: "Текст по контуру" } }, { value: "dynamicCircle", label: { en: "Dynamic Circle", ru: "Динамический круг" } }, { value: "dynamicArch", label: { en: "Dynamic Arch", ru: "Динамическая дуга" } }, { value: "dynamicBow", label: { en: "Dynamic Bow", ru: "Динамический изгиб" } }] }, color, { id: "fontSize", label: { en: "Font size", ru: "Размер шрифта" }, type: "number", min: 1, max: 1000, step: 1, defaultValue: 48, unit: "px" }, { id: "fontFamily", label: { en: "Font", ru: "Шрифт" }, type: "select", defaultValue: "Arial", values: [{ value: "Arial", label: { en: "Arial" } }, { value: "Georgia", label: { en: "Georgia" } }, { value: "Verdana", label: { en: "Verdana" } }, { value: "monospace", label: { en: "Monospace", ru: "Моноширинный" } }] }] },
  { id: "raster.shape", kind: "raster", icon: "▭", iconFile: "КВАДРАТ.svg", label: { en: "Shape Tool", ru: "Фигура" }, shortcut: "U", options: [{ id: "shapeKind", label: { en: "Shape", ru: "Фигура" }, type: "select", defaultValue: "rectangle", values: [{ value: "rectangle", label: { en: "Rectangle", ru: "Прямоугольник" } }, { value: "roundedRectangle", label: { en: "Rounded rectangle", ru: "Скруглённый прямоугольник" } }, { value: "ellipse", label: { en: "Ellipse", ru: "Эллипс" } }, { value: "line", label: { en: "Line", ru: "Линия" } }, { value: "triangle", label: { en: "Triangle", ru: "Треугольник" } }, { value: "polygon", label: { en: "Polygon", ru: "Многоугольник" } }, { value: "star", label: { en: "Star", ru: "Звезда" } }] }, { id: "shapeMode", label: { en: "Paint", ru: "Отрисовка" }, type: "select", defaultValue: "fill", values: [{ value: "fill", label: { en: "Fill", ru: "Заливка" } }, { value: "stroke", label: { en: "Stroke", ru: "Обводка" } }, { value: "both", label: { en: "Fill + stroke", ru: "Заливка и обводка" } }] }, color, { id: "strokeColor", label: { en: "Stroke color", ru: "Цвет обводки" }, type: "color", defaultValue: "#ffffff" }, { id: "strokeWidth", label: { en: "Stroke width", ru: "Толщина обводки" }, type: "number", min: 1, max: 200, step: 1, defaultValue: 4, unit: "px" }, { id: "cornerRadius", label: { en: "Corner radius", ru: "Радиус скругления" }, type: "number", min: 0, max: 400, step: 1, defaultValue: 16, unit: "px" }, { id: "sides", label: { en: "Sides", ru: "Стороны" }, type: "number", min: 3, max: 24, step: 1, defaultValue: 5 }] },
  { id: "raster.crop", kind: "raster", icon: "⌗", iconFile: "МОНТАЖ.svg", label: { en: "Crop Tool", ru: "Рамка" }, shortcut: "C", options: [] },
  { id: "raster.clone", kind: "raster", icon: "⧉", iconFile: "ШТАМП.svg", label: { en: "Clone Tool", ru: "Штамп" }, shortcut: "S", options: [...brushTipOptions, opacity, { id: "alignMode", label: { en: "Alignment", ru: "Выравнивание" }, type: "select", defaultValue: "registered", values: [{ value: "none", label: { en: "None", ru: "Нет" } }, { value: "registered", label: { en: "Registered", ru: "Совместное" } }, { value: "fixed", label: { en: "Fixed", ru: "Фиксированное" } }] }] },
  { id: "raster.spotHeal", kind: "raster", icon: "⊕", iconFile: "точечная востанавливающая кисть.svg", label: { en: "Spot Healing Brush", ru: "Точечная восстанавливающая" }, shortcut: "J", options: [...brushTipOptions, opacity, { id: "sampleAllLayers", label: { en: "Sample all layers", ru: "Все слои" }, type: "boolean", defaultValue: false }] },
  { id: "raster.patch", kind: "raster", icon: "⊞", iconFile: "заплатка.svg", label: { en: "Patch Tool", ru: "Заплатка" }, shortcut: "J", options: [{ id: "mode", label: { en: "Mode", ru: "Режим" }, type: "select", defaultValue: "source", values: [{ value: "source", label: { en: "Source", ru: "Источник" } }, { value: "destination", label: { en: "Destination", ru: "Назначение" } }] }, { id: "feather", label: { en: "Feather", ru: "Растушёвка" }, type: "number", min: 0, max: 250, step: 1, defaultValue: 0, unit: "px" }] },
  { id: "vector.select", kind: "vector", icon: "↖", iconFile: "КУРСОР.svg", label: { en: "Selection Tool", ru: "Выделение" }, shortcut: "V", options: [{ id: "transform", label: { en: "Transform handles", ru: "Маркеры трансформации" }, type: "boolean", defaultValue: true }] },
  { id: "vector.nodes", kind: "vector", icon: "◇", iconFile: "ПЕРО_1.svg", label: { en: "Node Tool", ru: "Узлы" }, shortcut: "A", options: [{ id: "showHandles", label: { en: "Bézier handles", ru: "Ручки Безье" }, type: "boolean", defaultValue: true }] },
  { id: "vector.pen", kind: "vector", icon: "⌁", iconFile: "ПЕРО.svg", label: { en: "Pen Tool", ru: "Перо" }, shortcut: "P", options: [color, { id: "strokeWidth", label: { en: "Stroke", ru: "Обводка" }, type: "number", min: 0, max: 1000, step: 0.25, defaultValue: 2, unit: "px" }] },
  { id: "vector.rectangle", kind: "vector", icon: "□", iconFile: "КВАДРАТ.svg", label: { en: "Rectangle Tool", ru: "Прямоугольник" }, shortcut: "R", options: [color, { id: "radius", label: { en: "Corner radius", ru: "Радиус углов" }, type: "number", min: 0, max: 1000, step: 1, defaultValue: 0, unit: "px" }] },
  { id: "vector.ellipse", kind: "vector", icon: "○", iconFile: "ЭЛИПС.svg", label: { en: "Ellipse Tool", ru: "Эллипс" }, shortcut: "O", options: [color] },
  { id: "vector.text", kind: "vector", icon: "T", iconFile: "ТЕКСТ.svg", label: { en: "Type Tool", ru: "Текст" }, shortcut: "T", options: [color, { id: "fontSize", label: { en: "Font size", ru: "Размер шрифта" }, type: "number", min: 1, max: 1000, step: 1, defaultValue: 48, unit: "px" }] },
];

export const rasterToolGroups: readonly (readonly string[])[] = [
  ["raster.move"],
  ["raster.marquee", "raster.ellipseMarquee", "raster.lasso", "raster.magicWand"],
  ["raster.brush", "raster.pencil", "raster.highlighter"],
  ["raster.eraser"],
  ["raster.blur", "raster.smudge"],
  // Photoshop keeps healing and cloning apart: the healing group is J, the
  // stamp is S. Folding them together hid the patch tool behind a flyout on a
  // tool it has nothing to do with.
  ["raster.spotHeal", "raster.patch"],
  ["raster.clone"],
  ["raster.dodge", "raster.burn"],
  ["raster.fill"],
  ["raster.eyedropper"],
  ["raster.text"],
  ["raster.shape"],
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
