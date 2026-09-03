import type { EnvironmentKind } from "@vravio/kernel";
import type { LocalizedText } from "./i18n";

export const environmentMeta: Record<EnvironmentKind, { icon: string; iconFile: string; plaqueFile: string; label: LocalizedText; description: string; descriptionRu: string }> = {
  raster: { icon: "▦", iconFile: "абстракция растр.svg", plaqueFile: "абстракция растр с плашкой.svg", label: { en: "Raster", ru: "Растр" }, description: "Pixels, layers, masks, painting and filters", descriptionRu: "Пиксели, слои, маски, рисование и фильтры" },
  vector: { icon: "◇", iconFile: "абстракция вектор.svg", plaqueFile: "абстракция вектор с плашкой.svg", label: { en: "Vector", ru: "Вектор" }, description: "Paths, shapes, typography and procedural geometry", descriptionRu: "Контуры, фигуры, типографика и процедурная геометрия" },
  audio: { icon: "≋", iconFile: "Абстракция аудио.svg", plaqueFile: "Абстракция аудио с плашкой.svg", label: { en: "Audio", ru: "Аудио" }, description: "Multitrack waveform editing, effects and restoration", descriptionRu: "Многодорожечный монтаж, эффекты и восстановление звука" },
  video: { icon: "▷", iconFile: "абстракция видео.svg", plaqueFile: "Абстракция видео с плашкой.svg", label: { en: "Video", ru: "Видео" }, description: "Non-linear timeline, compositing, effects and captions", descriptionRu: "Нелинейный таймлайн, композитинг, эффекты и субтитры" },
};
