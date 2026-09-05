import type { LocalizedText } from "../i18n";

/**
 * The menu a command belongs to.
 *
 * One constant per category rather than the string re-typed at each of eighty
 * definitions: `category` is what groups commands in the palette and, once
 * menus are generated from `surfaces`, what decides which menu a command lands
 * in — so two definitions differing by a stray space would silently split a
 * menu in two.
 */
export const CATEGORY_FILE: LocalizedText = { en: "File", ru: "Файл" };
export const CATEGORY_LAYER: LocalizedText = { en: "Layer", ru: "Слой" };
export const CATEGORY_EDIT: LocalizedText = { en: "Edit", ru: "Правка" };
export const CATEGORY_SELECT: LocalizedText = { en: "Select", ru: "Выделение" };
export const CATEGORY_VIEW: LocalizedText = { en: "View", ru: "Просмотр" };
export const CATEGORY_FILTER: LocalizedText = { en: "Filter", ru: "Фильтр" };
export const CATEGORY_IMAGE: LocalizedText = { en: "Image", ru: "Изображение" };
export const CATEGORY_3D: LocalizedText = { en: "3D", ru: "3D" };
export const CATEGORY_OBJECT: LocalizedText = { en: "Object", ru: "Объект" };
export const CATEGORY_TOOLS: LocalizedText = { en: "Tools", ru: "Инструменты" };
