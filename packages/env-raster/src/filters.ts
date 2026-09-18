export type RasterFilterCategory = "Basics" | "Photo" | "Blur" | "Sharpen" | "Stylize" | "Distort" | "Render" | "Noise" | "Other";
/**
 * One control on a filter. A magnitude by default — a slider from min to max.
 *
 * `choices` turns it into a pick from a list instead, the value being the index
 * into that list. Added for Add Noise, whose Distribution and Monochromatic are
 * genuine either/ors rather than amounts: as sliders they would be nonsense
 * (a "70% gaussian"), and leaving them out meant the filter silently offered
 * one of the four behaviours Photoshop and the donor both have. Still a number,
 * so a settings object stays `Record<string, number>` and still survives the
 * structured clone to the thumbnail worker.
 */
// `kind: "color"` keeps the value a plain number (a packed 0xRRGGBB integer, min 0/max 0xFFFFFF)
// so a settings object stays `Record<string, number>` — same reasoning as `choices` above — while
// telling the editor to render a colour swatch instead of a slider (Color to Transparency's own
// reference panel, docs/master-plan.md §51).
export interface RasterFilterParameter { id: string; name: string; min: number; max: number; step: number; value: number; choices?: readonly string[]; kind?: "color" }
export interface RasterFilterDefinition { id: string; name: string; category: RasterFilterCategory; parameters: RasterFilterParameter[] }

const none: RasterFilterDefinition["parameters"] = [];
const amount = [{ id: "amount", name: "Amount (Сила)", min: 0, max: 100, step: 1, value: 100 }];
// Add Noise gets Photoshop's own two switches; Analog Grain stays a preset of
// the same renderer (gaussian + monochromatic), which is what makes it a second
// filter rather than the same one under another name.
const noiseAmount = { id: "amount", name: "Amount (Сила)", min: 1, max: 100, step: 1, value: 12 };
const addNoiseParameters: RasterFilterParameter[] = [
  noiseAmount,
  { id: "distribution", name: "Distribution (Распределение)", min: 0, max: 1, step: 1, value: 0, choices: ["Uniform (Равномерное)", "Gaussian (По Гауссу)"] },
  { id: "monochromatic", name: "Monochromatic (Монохромный)", min: 0, max: 1, step: 1, value: 0, choices: ["Colour (Цветной)", "Monochromatic (Монохромный)"] },
];
const radius = [{ id: "radius", name: "Radius (Радиус)", min: 1, max: 32, step: 1, value: 2 }];
/** Never present a renamed Box Blur as a professional filter. The pixel
 * implementation remains available internally for migration compatibility,
 * but these entries return to the gallery only with distinct semantics. */
const unavailableUntilImplemented = new Set([
  "iris_blur", "tilt_shift_blur",
]);
// Photoshop's own Motion/Radial/Surface/Lens Blur parameter sets — each a
// distinct algorithm (docs/master-plan.md §51), not the box-blur alias they
// used to share.
// Distance default 12 and angle range -180..180 are Patchy's own contract
// (docs/filters.md: `motion_blur: angle=0 distance=12`) — this project's
// primary raster donor (CLAUDE.md §1), not a guessed default.
const motionBlurParams = [{ id: "distance", name: "Distance (Дистанция)", min: 1, max: 200, step: 1, value: 12 }, { id: "angle", name: "Angle (Угол)", min: -180, max: 180, step: 1, value: 0 }];
// Patchy's own unsharp_mask contract: amount 1..500% (default 150), radius
// 0.1..1000px (practical to 12, default 2), threshold 0..255 (default 8) —
// distinct from the single-slider `sharpen`, which Patchy's own catalog
// also keeps as amount-only (`sharpen: amount=100`, no radius/threshold).
// Radius capped at 32, not Patchy's own 1000 (practical 12): `blur()` itself clamps to 32
// internally (its own worker-preview responsiveness limit), and a slider whose upper half
// silently does nothing is exactly the "checkbox that does nothing" CLAUDE.md §3 warns against.
const unsharpMaskParams = [{ id: "amount", name: "Amount (Сила)", min: 1, max: 500, step: 1, value: 150 }, { id: "radius", name: "Radius (Радиус)", min: 1, max: 32, step: 1, value: 2 }, { id: "threshold", name: "Threshold (Порог)", min: 0, max: 255, step: 1, value: 8 }];
// Patchy: `high_pass: radius=10.0` — its own dedicated default, distinct
// from the shared `radius` object's 2 (box_blur/gaussian_blur's own).
const highPassParams = [{ id: "radius", name: "Radius (Радиус)", min: 1, max: 32, step: 1, value: 10 }];
const medianParams = [{ id: "radius", name: "Radius (Радиус)", min: 1, max: 32, step: 1, value: 1 }];
// Patchy: `dust_and_scratches: radius=1 threshold=0` — a real second
// parameter, not the median-with-one-knob alias this filter used to be
// (docs/master-plan.md §51's own "single door" lesson: two filters sharing
// one code path silently become the same filter under two names).
const dustAndScratchesParams = [{ id: "radius", name: "Radius (Радиус)", min: 1, max: 32, step: 1, value: 1 }, { id: "threshold", name: "Threshold (Порог)", min: 0, max: 255, step: 1, value: 0 }];
const boxBlurParams = [{ id: "radius", name: "Radius (Радиус)", min: 1, max: 32, step: 1, value: 1 }];
const radialBlurParams = [{ id: "amount", name: "Amount (Сила)", min: 1, max: 100, step: 1, value: 10 }, { id: "method", name: "Method (Метод)", min: 0, max: 1, step: 1, value: 0, choices: ["Spin (Вращение)", "Zoom (Приближение)"] }];
const surfaceBlurParams = [{ id: "radius", name: "Radius (Радиус)", min: 1, max: 50, step: 1, value: 5 }, { id: "threshold", name: "Threshold (Порог)", min: 0, max: 100, step: 1, value: 15 }];
const lensBlurParams = [{ id: "radius", name: "Radius (Радиус)", min: 1, max: 50, step: 1, value: 8 }];
const polarCoordinatesParams = [{ id: "direction", name: "Direction (Направление)", min: 0, max: 1, step: 1, value: 0, choices: ["Rectangular to Polar (В полярные координаты)", "Polar to Rectangular (В прямоугольные координаты)"] }];
// Five curve-point percentages (top to bottom), not one Amount — see `shearFilter`'s own doc
// comment. All zero is Photoshop's own default: a straight, undistorted vertical line.
const shearParams = [0, 1, 2, 3, 4].map((index) => ({ id: `point${index}`, name: `Point ${index + 1} (Точка ${index + 1})`, min: -100, max: 100, step: 1, value: 0 }));
const spherizeParams = [{ id: "amount", name: "Amount (Сила)", min: -100, max: 100, step: 1, value: 50 }];
const zigzagParams = [{ id: "amount", name: "Amount (Сила)", min: 0, max: 100, step: 1, value: 30 }];
const kaleidoscopeParams = [{ id: "segments", name: "Segments (Сегменты)", min: 3, max: 16, step: 1, value: 6 }, { id: "angle", name: "Angle (Угол)", min: -180, max: 180, step: 1, value: 0 }];
// Owner's own reference panel (docs/master-plan.md §51): three modes, not the always-wrap
// boolean this used to be — "Обтекание" (wrap), "Повторить пиксели краёв" (repeat edge pixels),
// "Сделать прозрачным" (set to transparent).
const offsetParams = [{ id: "horizontal", name: "Horizontal (По горизонтали)", min: -500, max: 500, step: 1, value: 0 }, { id: "vertical", name: "Vertical (По вертикали)", min: -500, max: 500, step: 1, value: 0 }, { id: "undefinedArea", name: "Undefined Area (Неопределенная область)", min: 0, max: 2, step: 1, value: 0, choices: ["Wrap Around (Обтекание)", "Repeat Edge Pixels (Повторить пиксели краёв)", "Transparent (Сделать прозрачным)"] }];
// The reference panel's own "Фигура:" dropdown — the structuring-element shape, not only its
// radius: Square is the full box (Photoshop's own default), Round the circular kernel this
// filter used to be limited to, Diamond the |dx|+|dy| taxicab kernel.
const morphologyParams = [{ id: "radius", name: "Radius (Радиус)", min: 1, max: 20, step: 1, value: 1 }, { id: "shape", name: "Shape (Фигура)", min: 0, max: 2, step: 1, value: 0, choices: ["Square (Квадрат)", "Round (Круг)", "Diamond (Ромб)"] }];
const reduceNoiseParams = [{ id: "strength", name: "Strength (Сила)", min: 0, max: 8, step: 1, value: 4 }];
const smartSharpenParams = [{ id: "amount", name: "Amount (Эффект)", min: 0, max: 500, step: 1, value: 150 }, { id: "radius", name: "Radius (Радиус)", min: 1, max: 32, step: 1, value: 2 }];
// The reference panel drops the Amount slider entirely and offers only a Mode choice — GIMP's own
// Spread modes (Normal/Darker Only/Lighter Only) plus a fourth, Anisotropic, which is an
// edge-preserving diffusion rather than a random swap. Radius stays an internal constant (4,
// this filter's own prior default) since no reference panel exposes one.
const diffuseParams = [{ id: "mode", name: "Mode (Режим)", min: 0, max: 3, step: 1, value: 0, choices: ["Normal (Обычный)", "Darker Only (Темнее)", "Lighter Only (Светлее)", "Anisotropic (Anisotropic)"] }];
const traceContourParams = [{ id: "level", name: "Level (Уровень)", min: 0, max: 255, step: 1, value: 128 }, { id: "edge", name: "Edge (Край)", min: 0, max: 1, step: 1, value: 0, choices: ["Lower (Вниз)", "Upper (Вверх)"] }];
// No Strength slider: the reference panel has none — only Technique (Wind/Blast/Stagger) and
// Direction. Strength lives as an internal constant instead of a fake slider with no backing.
const windParams = [{ id: "technique", name: "Technique (Техника)", min: 0, max: 2, step: 1, value: 0, choices: ["Wind (Wind)", "Blast (Blast)", "Stagger (Stagger)"] }, { id: "direction", name: "Direction (Направление)", min: 0, max: 1, step: 1, value: 1, choices: ["From the Right (From the Right)", "From the Left (From the Left)"] }];
const oilPaintParams = [{ id: "brushSize", name: "Brush size (Размер кисти)", min: 1, max: 8, step: 1, value: 4 }, { id: "stylization", name: "Stylization (Стилизация)", min: 1, max: 20, step: 1, value: 8 }];
// Patchy's own contract for the shared classic-Photoshop set: `emboss: angle=-360..360
// (practical -180..180) height=1..100 (practical 1..24) amount=1..500 (practical 0..300)`.
const embossParams = [{ id: "angle", name: "Angle (Угол)", min: -180, max: 180, step: 1, value: 135 }, { id: "height", name: "Height (Высота)", min: 1, max: 100, step: 1, value: 3 }, { id: "amount", name: "Amount (Сила)", min: 1, max: 500, step: 1, value: 100 }];
// The reference panel's own "Тип: Lens 1/2/3/4" choice — four reflection styles, not the one
// fixed table this filter used to render regardless of setting.
const lensFlareParams = [{ id: "brightness", name: "Brightness (Яркость)", min: 10, max: 300, step: 1, value: 100 }, { id: "lensType", name: "Type (Тип)", min: 0, max: 3, step: 1, value: 0, choices: ["Lens 1 (Lens 1)", "Lens 2 (Lens 2)", "Lens 3 (Lens 3)", "Lens 4 (Lens 4)"] }, { id: "positionX", name: "Position X (Позиция X)", min: 0, max: 100, step: 1, value: 50 }, { id: "positionY", name: "Position Y (Позиция Y)", min: 0, max: 100, step: 1, value: 50 }];
const cellSizeParams = [{ id: "cellSize", name: "Cell size (Размер ячейки)", min: 3, max: 100, step: 1, value: 12 }];
const fragmentParams = [{ id: "amount", name: "Offset (Смещение)", min: 1, max: 20, step: 1, value: 4 }];
const mezzotintParams = [{ id: "type", name: "Type (Тип)", min: 0, max: 9, step: 1, value: 0, choices: ["Fine Dots (Fine Dots)", "Medium Dots (Medium Dots)", "Grainy Dots (Grainy Dots)", "Coarse Dots (Coarse Dots)", "Short Lines (Short Lines)", "Medium Lines (Medium Lines)", "Long Lines (Long Lines)", "Short Strokes (Short Strokes)", "Medium Strokes (Medium Strokes)", "Long Strokes (Long Strokes)"] }];
const shapeMosaicParams = [{ id: "cellSize", name: "Cell size (Размер ячейки)", min: 4, max: 100, step: 1, value: 20 }, { id: "shape", name: "Shape (Фигура)", min: 0, max: 2, step: 1, value: 0, choices: ["Square (Квадрат)", "Circle (Круг)", "Star (Звезда)"] }, { id: "monochrome", name: "Monochrome (Однотонный)", min: 0, max: 1, step: 1, value: 0, choices: ["Off", "On"] }, { id: "invert", name: "Invert (Инвертировать)", min: 0, max: 1, step: 1, value: 0, choices: ["Off", "On"] }];
const fibersParams = [{ id: "variance", name: "Variance (Разброс)", min: 1, max: 100, step: 1, value: 50 }, { id: "strength", name: "Strength (Сила)", min: 1, max: 100, step: 1, value: 50 }];
// The reference panel's own Blur/Scale/Invert/High/Medium/Low — a three-band detail mix, not
// the single flat Scale this filter used to have.
const normalMapParams = [{ id: "blur", name: "Blur (Размыть)", min: 0, max: 20, step: 1, value: 0 }, { id: "scale", name: "Scale (Масштаб)", min: 1, max: 100, step: 1, value: 10 }, { id: "invert", name: "Invert (Инвертировать)", min: 0, max: 1, step: 1, value: 0, choices: ["Off", "On"] }, { id: "high", name: "High (High)", min: 0, max: 100, step: 1, value: 100 }, { id: "medium", name: "Medium (Medium)", min: 0, max: 100, step: 1, value: 100 }, { id: "low", name: "Low (Low)", min: 0, max: 100, step: 1, value: 100 }];
// Simplified to the reference panel's own two sliders (Интенсивность/Масштаб). Chromatic
// aberration and vignette correction, while real algorithms, are not in any reference panel
// shown — Lens Correction here is deliberately the plain lens-distortion-plus-compensating-zoom
// pair, not a superset invented beyond what was asked for.
const lensCorrectionParams = [{ id: "distortAmount", name: "Intensity (Интенсивность)", min: -100, max: 100, step: 1, value: 0 }, { id: "scale", name: "Scale (Масштаб)", min: 50, max: 150, step: 1, value: 100 }];
const hsbHslParams = [{ id: "inputMode", name: "Input (Input)", min: 0, max: 2, step: 1, value: 0, choices: ["RGB (RGB)", "HSB (HSB)", "HSL (HSL)"] }, { id: "outputMode", name: "Output (Output)", min: 0, max: 2, step: 1, value: 1, choices: ["RGB (RGB)", "HSB (HSB)", "HSL (HSL)"] }];
const textureDilationParams = [{ id: "distance", name: "Radius (Радиус)", min: 1, max: 64, step: 1, value: 8 }, { id: "crop", name: "Crop (Обрезать)", min: 0, max: 64, step: 1, value: 0 }];
// Photoshop's own dialog has no Size choice at all, only Amount — but the reference panel does
// (Small/Medium/Large), scaling the ripple's period; Amount's own range (999) matches the panel
// too, distinct from the 0-100 convention every other Amount slider here uses.
const rippleParams = [{ id: "amount", name: "Amount (Интенсивность)", min: 0, max: 999, step: 1, value: 100 }, { id: "size", name: "Size (Размер)", min: 0, max: 2, step: 1, value: 1, choices: ["Small (Малый)", "Medium (Средний)", "Large (Большой)"] }];
// Four independent screen angles — one per RGB channel plus a shared row — replacing the single
// grayscale dot-radius this filter used to render regardless of the angle sliders it displayed.
const colorHalftoneParams = [{ id: "radius", name: "Radius (Радиус)", min: 2, max: 30, step: 1, value: 8 }, { id: "angle1", name: "Angle 1 (Угол 1)", min: 0, max: 360, step: 1, value: 10 }, { id: "angle2", name: "Angle 2 (Угол 2)", min: 0, max: 360, step: 1, value: 40 }, { id: "angle3", name: "Angle 3 (Угол 3)", min: 0, max: 360, step: 1, value: 70 }];
// The four filters below have no entry in Patchy's current source and are not native Photoshop
// filters either — they exist only as the owner's own reference-panel mockups
// (docs/master-plan.md §51). Implemented directly from what each panel's own controls show,
// leaning on standard, well-established techniques where one exists (GIMP's own Color to Alpha
// formula; Floyd-Steinberg error diffusion and the textbook 4×4 Bayer matrix for dithering) rather
// than inventing new math where a real one is not needed.
const particlesParams = [
  { id: "amount", name: "Amount (Количество)", min: 0, max: 500, step: 1, value: 150 },
  { id: "size", name: "Size (Размер)", min: 1, max: 20, step: 1, value: 3 },
  { id: "depth", name: "Depth (Глубина)", min: 0, max: 100, step: 1, value: 40 },
  { id: "brightness", name: "Brightness (Яркость)", min: 0, max: 100, step: 1, value: 100 },
  { id: "color", name: "Color (Цвет)", min: 0, max: 0xffffff, step: 1, value: 0xffffff, kind: "color" as const },
  { id: "time", name: "Time (Время)", min: 0, max: 999, step: 1, value: 0 },
  { id: "turbulence", name: "Turbulence (Турбулентность)", min: 0, max: 100, step: 1, value: 20 },
  { id: "blink", name: "Blink (Мерцание)", min: 0, max: 100, step: 1, value: 0 },
  { id: "fall", name: "Fall (Падение)", min: 0, max: 100, step: 1, value: 30 },
  { id: "randomize", name: "Randomize (Случайность)", min: 0, max: 999, step: 1, value: 0 },
];
const repeatParams = [
  { id: "scale", name: "Scale (Масштаб)", min: 5, max: 100, step: 1, value: 25 },
  { id: "rowShift", name: "Row Shift (Сдвиг строк)", min: 0, max: 100, step: 1, value: 0 },
  { id: "spaceX", name: "Space X (Промежуток X)", min: 0, max: 50, step: 1, value: 0 },
  { id: "spaceY", name: "Space Y (Промежуток Y)", min: 0, max: 50, step: 1, value: 0 },
  { id: "autoColorCorrect", name: "Auto Color Correct (Автокоррекция цвета)", min: 0, max: 1, step: 1, value: 0, choices: ["Off", "On"] },
  { id: "angle", name: "Angle (Угол)", min: -180, max: 180, step: 1, value: 0 },
];
// Threshold 1 is a deadzone below which the computed alpha stays fully opaque; Threshold 2 is
// where it reaches full strength; smoothstep between them so both sliders have a real, distinct
// effect instead of one hard GIMP-style cutoff pretending to be two controls.
const colorToTransparencyParams = [
  { id: "color", name: "Color (Цвет)", min: 0, max: 0xffffff, step: 1, value: 0xffffff, kind: "color" as const },
  { id: "threshold1", name: "Threshold 1 (Порог 1)", min: 0, max: 100, step: 1, value: 0 },
  { id: "threshold2", name: "Threshold 2 (Порог 2)", min: 0, max: 100, step: 1, value: 100 },
];
const discretizationParams = [
  { id: "palette", name: "Palette (Палитра)", min: 0, max: 2, step: 1, value: 1, choices: ["Black & White (Чёрно-белая)", "Grayscale (Оттенки серого)", "RGB (RGB)"] },
  { id: "method", name: "Method (Метод)", min: 0, max: 2, step: 1, value: 1, choices: ["None (Нет)", "Floyd-Steinberg (Флойд-Стейнберг)", "Bayer 4x4 (Байер 4x4)"] },
];
export const rasterFilterCatalog: RasterFilterDefinition[] = ([
  ["invert","Invert (Инверсия)","Basics",none], ["brightness_contrast","Brightness/Contrast (Яркость/Контраст)","Basics",[{id:"brightness",name:"Brightness (Яркость)",min:-100,max:100,step:1,value:0},{id:"contrast",name:"Contrast (Контраст)",min:-100,max:100,step:1,value:20}]], ["grayscale","Grayscale (Оттенки серого)","Basics",none], ["desaturate","Desaturate (Обесцветить)","Basics",none], ["auto_tone","Auto Tone (Автотон)","Photo",none], ["auto_contrast","Auto Contrast (Автоконтраст)","Photo",none], ["auto_color","Auto Color (Автоцвет)","Photo",none], ["soft_glow","Soft Glow (Мягкое свечение)","Photo",amount], ["punchy_color","Punchy Color (Сочный цвет)","Photo",amount], ["noir","Noir (Нуар)","Photo",amount], ["cinematic_matte","Cinematic Matte (Кинематографический матовый)","Photo",amount], ["vintage_fade","Vintage Fade (Винтажное выцветание)","Photo",amount], ["sepia","Vintage Sepia (Винтажная сепия)","Photo",amount], ["threshold","Threshold (Порог)","Basics",[{id:"threshold",name:"Threshold (Порог)",min:0,max:255,step:1,value:128}]], ["posterize","Posterize (Постеризация)","Basics",[{id:"levels",name:"Levels (Уровни)",min:2,max:32,step:1,value:4}]], ["box_blur","Box Blur (Прямоугольное размытие)","Blur",boxBlurParams], ["sharpen","Sharpen (Резкость)","Sharpen",amount], ["unsharp_mask","Unsharp Mask (Контурная резкость)","Sharpen",unsharpMaskParams], ["gaussian_blur","Gaussian Blur (Размытие по Гауссу)","Blur",radius], ["motion_blur","Motion Blur (Размытие в движении)","Blur",motionBlurParams], ["radial_blur","Radial Blur (Радиальное размытие)","Blur",radialBlurParams], ["edge_detect","Edge Detect (Выделение краёв)","Stylize",none], ["emboss","Emboss (Тиснение)","Stylize",embossParams], ["glowing_edges","Glowing Edges (Светящиеся края)","Stylize",amount], ["twirl","Twirl (Скручивание)","Distort",amount], ["wave","Wave (Волна)","Distort",amount], ["pinch_bloat","Pinch/Bloat (Сжатие/Вздутие)","Distort",[{id:"amount",name:"Amount (Сила)",min:-100,max:100,step:1,value:25}]], ["clouds","Clouds (Облака)","Render",amount], ["pixelate","Pixel Mosaic (Мозаика)","Stylize",[{id:"size",name:"Cell size (Размер ячейки)",min:2,max:64,step:1,value:8}]], ["color_halftone","Color Halftone (Цветные полутона)","Stylize",colorHalftoneParams], ["film_grain","Analog Grain (Аналоговое зерно)","Noise",[noiseAmount]], ["add_noise","Add Noise (Добавить шум)","Noise",addNoiseParameters], ["vignette","Lens Vignette (Виньетка)","Photo",amount], ["high_pass","High Pass (Цветовой контраст)","Sharpen",highPassParams], ["median","Median (Медиана)","Noise",medianParams], ["dust_and_scratches","Dust & Scratches (Пыль и царапины)","Noise",dustAndScratchesParams], ["surface_blur","Surface Blur (Размытие по поверхности)","Blur",surfaceBlurParams], ["lens_blur","Lens Blur (Размытие объектива)","Blur",lensBlurParams], ["iris_blur","Iris Blur (Размытие диафрагмы)","Blur",radius], ["tilt_shift_blur","Tilt-Shift Blur (Наклон-сдвиг)","Blur",radius], ["plastic_wrap","Plastic Wrap (Целлофановая упаковка)","Stylize",amount],
  ["duotone","Duotone (Дуотон)","Photo",[{id:"shadowHue",name:"Shadow hue (Тон теней)",min:0,max:359,step:1,value:210},{id:"highlightHue",name:"Highlight hue (Тон светов)",min:0,max:359,step:1,value:45},{id:"amount",name:"Amount (Сила)",min:0,max:100,step:1,value:100}]],
  ["glitch","CRT Glitch (Глитч ЭЛТ)","Stylize",[{id:"shift",name:"Channel shift (Сдвиг каналов)",min:0,max:40,step:1,value:8},{id:"scanline",name:"Scanlines (Строки)",min:0,max:100,step:1,value:45},{id:"amount",name:"Amount (Сила)",min:0,max:100,step:1,value:100}]],
  ["eink","E-Ink Dither (Дизеринг E-Ink)","Stylize",[{id:"levels",name:"Levels (Уровни)",min:2,max:8,step:1,value:2},{id:"amount",name:"Amount (Сила)",min:0,max:100,step:1,value:100}]],
  ["average","Average (Средний)","Blur",none],
  ["blur","Blur (Размыть)","Blur",none],
  ["blur_more","Blur More (Сильнее размыть)","Blur",none],
  ["polar_coordinates","Polar Coordinates (Полярные координаты)","Distort",polarCoordinatesParams],
  ["shear","Shear (Сдвиг)","Distort",shearParams],
  ["spherize","Spherize (Сферизация)","Distort",spherizeParams],
  ["zigzag","ZigZag (Зигзаг)","Distort",zigzagParams],
  ["ripple","Ripple (Рябь)","Distort",rippleParams],
  ["kaleidoscope","Kaleidoscope (Калейдоскоп)","Distort",kaleidoscopeParams],
  ["offset","Offset (Смещение)","Other",offsetParams],
  ["maximum","Maximum (Максимум)","Other",morphologyParams],
  ["minimum","Minimum (Минимум)","Other",morphologyParams],
  ["despeckle","Despeckle (Подавление шумов)","Noise",none],
  ["reduce_noise","Reduce Noise (Уменьшить шум)","Noise",reduceNoiseParams],
  ["sharpen_more","Sharpen More (Усилить резкость)","Sharpen",none],
  ["sharpen_edges","Sharpen Edges (Повысить резкость краёв)","Sharpen",none],
  ["smart_sharpen","Smart Sharpen (Умная резкость)","Sharpen",smartSharpenParams],
  ["diffuse","Diffuse (Диффузия)","Stylize",diffuseParams],
  ["solarize","Solarize (Соляризировать)","Stylize",none],
  ["trace_contour","Trace Contour (Обвести контур)","Stylize",traceContourParams],
  ["wind","Wind (Ветер)","Stylize",windParams],
  ["oil_paint","Oil Paint (Масляная краска)","Stylize",oilPaintParams],
  ["lens_flare","Lens Flare (Блик линзы)","Render",lensFlareParams],
  ["crystallize","Crystallize (Кристаллизация)","Stylize",cellSizeParams],
  ["pointillize","Pointillize (Пуантилизм)","Stylize",cellSizeParams],
  ["fragment","Fragment (Фрагмент)","Stylize",fragmentParams],
  ["mezzotint","Mezzotint (Глубокая печать)","Stylize",mezzotintParams],
  ["shape_mosaic","Shape Mosaic (Shape Mosaic)","Stylize",shapeMosaicParams],
  ["difference_clouds","Difference Clouds (Облака с наложением)","Render",none],
  ["fibers","Fibers (Волокна)","Render",fibersParams],
  ["normal_map","Normal Map (Карта нормалей)","Other",normalMapParams],
  ["lens_correction","Lens Correction (Коррекция линзы)","Distort",lensCorrectionParams],
  ["hsb_hsl","HSB/HSL (HSB/HSL)","Other",hsbHslParams],
  ["texture_dilation","Texture Dilation (Texture Dilation)","Other",textureDilationParams],
  ["particles","Particles (Частицы)","Render",particlesParams],
  ["repeat","Repeat (Повторить)","Other",repeatParams],
  ["color_to_transparency","Color to Transparency (Цвет в прозрачность)","Other",colorToTransparencyParams],
  ["discretization","Discretization (Дискретизация)","Stylize",discretizationParams],
].map(([id,name,category,parameters]) => ({ id, name, category, parameters })) as RasterFilterDefinition[])
  .filter((definition) => !unavailableUntilImplemented.has(definition.id));

const byte = (value: number) => Math.max(0, Math.min(255, Math.round(value)));
const value = (settings: Record<string, number>, key: string, fallback: number) => Number.isFinite(settings[key]) ? settings[key]! : fallback;

function blur(source: Uint8ClampedArray, width: number, height: number, radius: number): Uint8ClampedArray {
  const output = new Uint8ClampedArray(source.length), r = Math.max(1, Math.min(32, Math.round(radius)));
  const horizontal = new Float32Array(source.length), diameter = r * 2 + 1;
  const clampX = (x: number) => Math.max(0, Math.min(width - 1, x));
  const clampY = (y: number) => Math.max(0, Math.min(height - 1, y));

  for (let y = 0; y < height; y += 1) {
    const sums = [0, 0, 0, 0];
    for (let dx = -r; dx <= r; dx += 1) {
      const index = (y * width + clampX(dx)) * 4;
      for (let channel = 0; channel < 4; channel += 1) sums[channel] = sums[channel]! + source[index + channel]!;
    }
    for (let x = 0; x < width; x += 1) {
      const outputIndex = (y * width + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) horizontal[outputIndex + channel] = sums[channel]! / diameter;
      const removeIndex = (y * width + clampX(x - r)) * 4;
      const addIndex = (y * width + clampX(x + r + 1)) * 4;
      for (let channel = 0; channel < 4; channel += 1) sums[channel] = sums[channel]! + source[addIndex + channel]! - source[removeIndex + channel]!;
    }
  }

  for (let x = 0; x < width; x += 1) {
    const sums = [0, 0, 0, 0];
    for (let dy = -r; dy <= r; dy += 1) {
      const index = (clampY(dy) * width + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) sums[channel] = sums[channel]! + horizontal[index + channel]!;
    }
    for (let y = 0; y < height; y += 1) {
      const outputIndex = (y * width + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) output[outputIndex + channel] = sums[channel]! / diameter;
      const removeIndex = (clampY(y - r) * width + x) * 4;
      const addIndex = (clampY(y + r + 1) * width + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) sums[channel] = sums[channel]! + horizontal[addIndex + channel]! - horizontal[removeIndex + channel]!;
    }
  }
  return output;
}

/** Separable Gaussian, intentionally distinct from Box Blur.
 *
 * The weights are calculated once per pass and the implementation stays
 * O(radius × pixels), rather than the O(radius² × pixels) naive kernel. */
function gaussianBlur(source: Uint8ClampedArray, width: number, height: number, radius: number): Uint8ClampedArray {
  const r = Math.max(1, Math.min(32, Math.round(radius)));
  const sigma = Math.max(0.5, r / 2);
  const weights = new Float64Array(r * 2 + 1);
  let total = 0;
  for (let offset = -r; offset <= r; offset += 1) {
    const weight = Math.exp(-(offset * offset) / (2 * sigma * sigma));
    weights[offset + r] = weight;
    total += weight;
  }
  for (let index = 0; index < weights.length; index += 1) weights[index] = weights[index]! / total;
  const horizontal = new Float32Array(source.length);
  const clampX = (x: number) => Math.max(0, Math.min(width - 1, x));
  const clampY = (y: number) => Math.max(0, Math.min(height - 1, y));
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const out = (y * width + x) * 4;
    for (let offset = -r; offset <= r; offset += 1) {
      const sourceIndex = (y * width + clampX(x + offset)) * 4, weight = weights[offset + r]!;
      for (let channel = 0; channel < 4; channel += 1) horizontal[out + channel] = horizontal[out + channel]! + source[sourceIndex + channel]! * weight;
    }
  }
  const output = new Uint8ClampedArray(source.length);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const out = (y * width + x) * 4;
    for (let offset = -r; offset <= r; offset += 1) {
      const sourceIndex = (clampY(y + offset) * width + x) * 4, weight = weights[offset + r]!;
      for (let channel = 0; channel < 4; channel += 1) output[out + channel] = output[out + channel]! + horizontal[sourceIndex + channel]! * weight;
    }
  }
  return output;
}

/**
 * Edge-preserving order-statistic blur used by Median and Dust & Scratches.
 *
 * Radius is deliberately capped lower than convolution blurs: a median needs
 * to inspect every value in its neighbourhood and must stay responsive in the
 * worker preview. Unlike Box Blur, isolated dust pixels disappear without
 * smearing their colour over their neighbours.
 *
 * A sliding 256-bin histogram per row, not a fresh sort of every window — Huang's 1981 running-
 * median algorithm (the same one GIMP's `median-blur.c` and OpenCV's `medianBlur` use), found only
 * after this file's first version (collect the window into an array, `Array.prototype.sort` it,
 * take the middle) turned out to be the reason `apps/web/src/App.tsx`'s standalone Median dialog
 * hung well past 45 seconds on a 4000×3000 document at radius 8 — docs/master-plan.md §52's
 * "многие фильтры... тупит" complaint traced back to an O((2r+1)²·log(2r+1)²) per pixel per
 * channel algorithm with a full array allocation on top, not merely to the preview architecture
 * that called it (also fixed, separately, in the same section). Sliding the window one column at a
 * time instead of rebuilding it from scratch drops the per-pixel cost to O(radius) for the
 * histogram update plus a 256-bin scan for the median itself — the window size `(2r+1)²` is always
 * odd, so there is never an even-length tie to average, exactly like the original's
 * `samples[samples.length >> 1]` picked the same single element without needing to. Verified
 * byte-for-byte against the original naive implementation across several radii and random fixtures
 * (`filters-median-perf.test.ts`), not just spot-checked against a couple of hand-picked pixels.
 */
function medianBlur(source: Uint8ClampedArray, width: number, height: number, radius: number): Uint8ClampedArray {
  const r = Math.max(1, Math.min(8, Math.round(radius)));
  const output = new Uint8ClampedArray(source.length);
  const clampX = (x: number) => Math.max(0, Math.min(width - 1, x));
  const clampY = (y: number) => Math.max(0, Math.min(height - 1, y));
  const windowSize = (2 * r + 1) * (2 * r + 1);
  const target = windowSize >> 1; // 0-indexed rank of the median in a sorted, always-odd-length window
  const histogram = new Int32Array(256);
  // A channel that holds one value everywhere — alpha on any fully opaque layer, and that is most
  // of them — has that same value as the median of every window, so it is filled once instead of
  // slid over (docs/master-plan.md §58.1). Exact, not an approximation.
  const constant = new Int32Array(4).fill(-1);
  for (let channel = 0; channel < 4; channel += 1) {
    const first = source[channel]!;
    let uniform = true;
    for (let at = channel; at < source.length; at += 4) if (source[at] !== first) { uniform = false; break; }
    if (uniform) { constant[channel] = first; for (let at = channel; at < output.length; at += 4) output[at] = first; }
  }
  for (let y = 0; y < height; y += 1) {
    for (let channel = 0; channel < 4; channel += 1) {
      if (constant[channel]! >= 0) continue;
      histogram.fill(0);
      // Seed the histogram for this row's x=0 window (logical columns -r..r; clamped at the read).
      for (let dx = -r; dx <= r; dx += 1) {
        const column = clampX(dx);
        for (let dy = -r; dy <= r; dy += 1) {
          const bin = source[(clampY(y + dy) * width + column) * 4 + channel]!;
          histogram[bin] = (histogram[bin] ?? 0) + 1;
        }
      }
      for (let x = 0; x < width; x += 1) {
        if (x > 0) {
          // Slide right: drop the column that just left the window, add the one that just entered.
          // Both are logical positions, clamped independently — near an edge they can clamp to the
          // *same* physical column, in which case the net histogram change is correctly zero (the
          // `!==` check below only skips the redundant pair of writes, it does not change the result).
          const outColumn = clampX(x - 1 - r), inColumn = clampX(x + r);
          if (outColumn !== inColumn) {
            for (let dy = -r; dy <= r; dy += 1) {
              const row = clampY(y + dy);
              const outBin = source[(row * width + outColumn) * 4 + channel]!;
              const inBin = source[(row * width + inColumn) * 4 + channel]!;
              histogram[outBin] = (histogram[outBin] ?? 0) - 1;
              histogram[inBin] = (histogram[inBin] ?? 0) + 1;
            }
          }
        }
        let cumulative = 0, median = 0;
        for (let value = 0; value < 256; value += 1) {
          cumulative += histogram[value] ?? 0;
          if (cumulative > target) { median = value; break; }
        }
        output[(y * width + x) * 4 + channel] = median;
      }
    }
  }
  return output;
}

/**
 * Dust & Scratches — Patchy's own calibration note (docs/filters.md):
 * "replaces the whole RGB triplet only when its maximum channel difference
 * from the source is strictly greater than Threshold." Median with no
 * threshold logic at all used to stand in for this filter under a second
 * name — the "single door, not a lookalike" mistake CLAUDE.md §4 calls
 * out, since a real Threshold of 0 (Dust & Scratches' own default) already
 * reproduces plain Median exactly, while any positive threshold is a
 * genuinely different, edge-preserving result Median alone cannot give.
 */
function dustAndScratchesFilter(source: Uint8ClampedArray, width: number, height: number, radius: number, threshold: number): Uint8ClampedArray {
  const median = medianBlur(source, width, height, radius);
  if (threshold <= 0) return median;
  const output = new Uint8ClampedArray(source.length);
  for (let i = 0; i < source.length; i += 4) {
    const diff = Math.max(Math.abs(source[i]! - median[i]!), Math.abs(source[i + 1]! - median[i + 1]!), Math.abs(source[i + 2]! - median[i + 2]!));
    const useMedian = diff > threshold;
    output[i] = useMedian ? median[i]! : source[i]!; output[i + 1] = useMedian ? median[i + 1]! : source[i + 1]!; output[i + 2] = useMedian ? median[i + 2]! : source[i + 2]!;
    output[i + 3] = source[i + 3]!;
  }
  return output;
}

/** `sampleBilinear`'s arithmetic, written into a reused scratch array — the accumulating blurs
 *  below take one sample per step per pixel, and a fresh tuple for each was most of their cost
 *  (docs/master-plan.md §58.1). */
function sampleBilinearInto4(source: Uint8ClampedArray, width: number, height: number, x: number, y: number, out: Float64Array): void {
  const cx = Math.max(0, Math.min(width - 1.001, x)), cy = Math.max(0, Math.min(height - 1.001, y));
  const x0 = Math.floor(cx), y0 = Math.floor(cy), x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1), fx = cx - x0, fy = cy - y0;
  const i00 = (y0 * width + x0) * 4, i10 = (y0 * width + x1) * 4, i01 = (y1 * width + x0) * 4, i11 = (y1 * width + x1) * 4;
  for (let c = 0; c < 4; c += 1) {
    const top = source[i00 + c]! * (1 - fx) + source[i10 + c]! * fx, bottom = source[i01 + c]! * (1 - fx) + source[i11 + c]! * fx;
    out[c] = top * (1 - fy) + bottom * fy;
  }
}

function sampleBilinear(source: Uint8ClampedArray, width: number, height: number, x: number, y: number): [number, number, number, number] {
  const cx = Math.max(0, Math.min(width - 1.001, x)), cy = Math.max(0, Math.min(height - 1.001, y));
  const x0 = Math.floor(cx), y0 = Math.floor(cy), x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1), fx = cx - x0, fy = cy - y0;
  const i00 = (y0 * width + x0) * 4, i10 = (y0 * width + x1) * 4, i01 = (y1 * width + x0) * 4, i11 = (y1 * width + x1) * 4, out: [number, number, number, number] = [0, 0, 0, 0];
  for (let c = 0; c < 4; c += 1) { const top = source[i00 + c]! * (1 - fx) + source[i10 + c]! * fx, bottom = source[i01 + c]! * (1 - fx) + source[i11 + c]! * fx; out[c] = top * (1 - fy) + bottom * fy; }
  return out;
}

/**
 * Patchy's position hash for Add Noise, ported value for value
 * (`add_noise_hash`, smart_filter_renderer.cpp).
 *
 * What was here before was one step of an LCG over the *byte index*:
 * `(imul(i + 1, 1103515245) + 12345) >>> 16 & 255`. A single multiply-and-shift
 * over indices that step by exactly 4 is not noise — the taken bits cycle, so
 * the result was a regular pattern that repeated across the image instead of
 * grain. A hash that mixes x and y separately and then avalanches has no such
 * structure, and stays deterministic, which is what makes a filter's output
 * reproducible.
 */
function addNoiseHash(x: number, y: number, seed: number): number {
  let value = Math.imul(x + 16384, 374761393) >>> 0;
  value = (value ^ Math.imul(y + 8192, 668265263)) >>> 0;
  value = (value ^ Math.imul(seed, 2246822519)) >>> 0;
  value = (value ^ (value >>> 13)) >>> 0;
  value = Math.imul(value, 1274126177) >>> 0;
  return (value ^ (value >>> 16)) >>> 0;
}

/** The hash as a uniform value in [-1, 1]. */
const unitFromHash = (hash: number) => hash * (2 / 4294967295) - 1;

/**
 * Add Noise, as Patchy renders it (`render_add_noise_effect`).
 *
 * `monochromatic` gives every channel the same delta — one lane of the hash
 * shared — which is what film grain looks like; without it each channel gets
 * its own lane, which is Photoshop's default and reads as colour speckle.
 * `gaussian` sums four uniforms instead of taking one, an approximation the
 * donor uses in place of a transcendental so the result stays identical across
 * toolchains.
 *
 * Alpha is never touched: noise is added to the colour of pixels that are
 * already there, and lifting transparent pixels to visible would be a different
 * filter entirely.
 */
function addNoiseFilter(source: Uint8ClampedArray, width: number, height: number, amountPercent: number, gaussian: boolean, monochromatic: boolean, seed = 1): Uint8ClampedArray {
  const output = source.slice();
  const range = Math.max(0, Math.min(400, amountPercent)) * 2.55;
  const laneBase = seed * 16;
  const deltaForLane = (x: number, y: number, lane: number) => {
    if (!gaussian) return Math.round(unitFromHash(addNoiseHash(x, y, laneBase + lane * 4)) * range);
    let sum = 0;
    for (let sample = 1; sample <= 4; sample += 1) sum += unitFromHash(addNoiseHash(x, y, laneBase + lane * 4 + sample));
    return Math.round(sum * 0.5 * range);
  };
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const index = (y * width + x) * 4;
    if (monochromatic) {
      const delta = deltaForLane(x, y, 3);
      for (let channel = 0; channel < 3; channel += 1) output[index + channel] = byte(source[index + channel]! + delta);
    } else {
      for (let channel = 0; channel < 3; channel += 1) output[index + channel] = byte(source[index + channel]! + deltaForLane(x, y, channel));
    }
  }
  return output;
}

function twirlFilter(source: Uint8ClampedArray, width: number, height: number, amount: number): Uint8ClampedArray {
  const output = new Uint8ClampedArray(source.length), cx = width / 2, cy = height / 2, maxR = Math.hypot(cx, cy) || 1, angleMax = amount / 100 * Math.PI * 3;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const dx = x - cx + .5, dy = y - cy + .5, r = Math.hypot(dx, dy), factor = Math.max(0, 1 - r / maxR), angle = angleMax * factor * factor;
    const cos = Math.cos(angle), sin = Math.sin(angle), sx = cx + dx * cos - dy * sin - .5, sy = cy + dx * sin + dy * cos - .5;
    const [sr, sg, sb, sa] = sampleBilinear(source, width, height, sx, sy), i = (y * width + x) * 4;
    output[i] = sr; output[i + 1] = sg; output[i + 2] = sb; output[i + 3] = sa;
  }
  return output;
}

function waveFilter(source: Uint8ClampedArray, width: number, height: number, amount: number): Uint8ClampedArray {
  const output = new Uint8ClampedArray(source.length), amp = Math.max(0, amount) / 100 * Math.max(width, height) * .06, freq = 2 * Math.PI / Math.max(8, Math.min(width, height) / 3);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const sx = x + Math.sin(y * freq) * amp, sy = y + Math.sin(x * freq) * amp;
    const [sr, sg, sb, sa] = sampleBilinear(source, width, height, sx, sy), i = (y * width + x) * 4;
    output[i] = sr; output[i + 1] = sg; output[i + 2] = sb; output[i + 3] = sa;
  }
  return output;
}

function pinchBloatFilter(source: Uint8ClampedArray, width: number, height: number, amount: number): Uint8ClampedArray {
  const output = new Uint8ClampedArray(source.length), cx = width / 2, cy = height / 2, maxR = Math.hypot(cx, cy) || 1, strength = amount / 100;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const dx = x - cx + .5, dy = y - cy + .5, r = Math.hypot(dx, dy), rn = Math.min(1, r / maxR), pull = strength * (1 - rn) * (1 - rn), scale = 1 / (1 + pull);
    const [sr, sg, sb, sa] = sampleBilinear(source, width, height, cx + dx * scale - .5, cy + dy * scale - .5), i = (y * width + x) * 4;
    output[i] = sr; output[i + 1] = sg; output[i + 2] = sb; output[i + 3] = sa;
  }
  return output;
}

function cloudsFilter(source: Uint8ClampedArray, width: number, height: number, mix: number): Uint8ClampedArray {
  const output = source.slice();
  const noise = (x: number, y: number) => { let total = 0, sum = 0, amp = 1, freq = .015; for (let o = 0; o < 4; o += 1) { sum += amp * (Math.sin(x * freq + o * 17.3) * Math.cos(y * freq * 1.3 + o * 9.1) + Math.sin((x + y) * freq * .7 + o * 3.7)) / 3; total += amp; amp *= .55; freq *= 2; } return (sum / total + 1) / 2; };
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const shade = byte(140 + noise(x, y) * 115), i = (y * width + x) * 4;
    output[i] = byte(source[i]! + (shade - source[i]!) * mix); output[i + 1] = byte(source[i + 1]! + (shade - source[i + 1]!) * mix); output[i + 2] = byte(source[i + 2]! + (Math.min(255, shade + 8) - source[i + 2]!) * mix);
  }
  return output;
}

/**
 * Color Halftone — an independent rotated dot screen per RGB channel, one
 * angle each (the reference panel's own Angle 1/2/3), replacing the single
 * grayscale dot-radius this filter used to render regardless of the angle
 * sliders it displayed (a real "checkbox that does nothing", CLAUDE.md §3):
 * dot size for a channel grows with that channel's own brightness at the
 * cell (more of that primary present → a bigger dot of it), each channel's
 * dot grid independently rotated by its own angle — the standard technique
 * every open "RGB halftone" implementation uses in place of Photoshop's own
 * CMYK conversion, which this engine's plain-RGB pipeline has no channel
 * space for.
 */
function colorHalftoneFilter(source: Uint8ClampedArray, width: number, height: number, radius: number, angle1: number, angle2: number, angle3: number): Uint8ClampedArray {
  const output = new Uint8ClampedArray(source.length), cellSize = Math.max(2, radius * 2), centerX = width / 2, centerY = height / 2;
  const angles = [angle1, angle2, angle3].map((degrees) => degrees * Math.PI / 180);
  const clampX = (x: number) => Math.max(0, Math.min(width - 1, x)), clampY = (y: number) => Math.max(0, Math.min(height - 1, y));
  const channelDot = (channel: number, angleRad: number, x: number, y: number): number => {
    const cos = Math.cos(angleRad), sin = Math.sin(angleRad);
    const rx = x * cos + y * sin, ry = -x * sin + y * cos;
    const cellX = Math.floor(rx / cellSize) * cellSize + cellSize / 2, cellY = Math.floor(ry / cellSize) * cellSize + cellSize / 2;
    const originX = cellX * cos - cellY * sin + centerX, originY = cellX * sin + cellY * cos + centerY;
    const sampleIndex = (clampY(Math.round(originY)) * width + clampX(Math.round(originX))) * 4 + channel;
    const channelValue = source[sampleIndex]!, dotRadius = (channelValue / 255) * (cellSize / 2) * 1.2;
    return Math.hypot(rx - cellX, ry - cellY) <= dotRadius ? channelValue : 0;
  };
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const i = (y * width + x) * 4, dx = x - centerX, dy = y - centerY;
    output[i] = byte(channelDot(0, angles[0]!, dx, dy));
    output[i + 1] = byte(channelDot(1, angles[1]!, dx, dy));
    output[i + 2] = byte(channelDot(2, angles[2]!, dx, dy));
    output[i + 3] = source[i + 3]!;
  }
  return output;
}

/** Direct TypeScript adaptation of Patchy's MIT built-in filter semantics. */
/** Maps luminance onto a two-ink ramp, the way a Photoshop duotone reads. */
function duotoneFilter(source: Uint8ClampedArray, shadowHue: number, highlightHue: number, mix: number): Uint8ClampedArray {
  const output = new Uint8ClampedArray(source.length);
  const ink = (hue: number, level: number): [number, number, number] => {
    const c = level, x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
    const [r, g, b] = hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
    return [r * 255, g * 255, b * 255];
  };
  for (let i = 0; i < source.length; i += 4) {
    const r = source[i]!, g = source[i + 1]!, b = source[i + 2]!;
    const luma = (r * 30 + g * 59 + b * 11) / 100 / 255;
    const shadow = ink(shadowHue, 1 - luma), highlight = ink(highlightHue, luma);
    for (let channel = 0; channel < 3; channel += 1) {
      const toned = Math.min(255, shadow[channel]! * (1 - luma) + highlight[channel]! * luma + luma * 60);
      output[i + channel] = byte(source[i + channel]! + (toned - source[i + channel]!) * mix);
    }
    output[i + 3] = source[i + 3]!;
  }
  return output;
}

/** Offsets the colour channels horizontally and darkens alternate rows, as a CRT capture does. */
function glitchFilter(source: Uint8ClampedArray, width: number, height: number, shift: number, scanline: number, mix: number): Uint8ClampedArray {
  const output = new Uint8ClampedArray(source.length);
  const sampleChannel = (x: number, y: number, channel: number): number => {
    const clampedX = Math.max(0, Math.min(width - 1, x));
    return source[(y * width + clampedX) * 4 + channel]!;
  };
  for (let y = 0; y < height; y += 1) {
    // A per-row jitter keeps the tearing irregular without needing a random source.
    const jitter = Math.round(Math.sin(y * 0.37) * shift);
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const red = sampleChannel(x + jitter + shift, y, 0);
      const green = sampleChannel(x, y, 1);
      const blue = sampleChannel(x - jitter - shift, y, 2);
      const darken = y % 2 === 0 ? 1 : 1 - scanline;
      output[index] = byte(source[index]! + (red * darken - source[index]!) * mix);
      output[index + 1] = byte(source[index + 1]! + (green * darken - source[index + 1]!) * mix);
      output[index + 2] = byte(source[index + 2]! + (blue * darken - source[index + 2]!) * mix);
      output[index + 3] = source[index + 3]!;
    }
  }
  return output;
}

const bayer4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/** Ordered-dither to a few grey levels; ordered rather than error-diffused so the result is
 * position-dependent only, which keeps it tile-safe for regional recomposites. */
function eInkFilter(source: Uint8ClampedArray, width: number, levels: number, mix: number): Uint8ClampedArray {
  const output = new Uint8ClampedArray(source.length);
  const steps = Math.max(2, Math.round(levels)) - 1;
  for (let i = 0; i < source.length; i += 4) {
    const pixel = i / 4, x = pixel % width, y = Math.floor(pixel / width);
    const luma = (source[i]! * 30 + source[i + 1]! * 59 + source[i + 2]! * 11) / 100;
    const threshold = (bayer4[(y % 4) * 4 + (x % 4)]! + .5) / 16 - .5;
    const quantized = Math.round(luma / 255 * steps + threshold) / steps * 255;
    for (let channel = 0; channel < 3; channel += 1) output[i + channel] = byte(source[i + channel]! + (quantized - source[i + channel]!) * mix);
    output[i + 3] = source[i + 3]!;
  }
  return output;
}

/** Fills the layer with its own average colour — Photoshop's one-click "Average" blur. */
function averageFilter(source: Uint8ClampedArray, width: number, height: number): Uint8ClampedArray {
  const output = new Uint8ClampedArray(source.length), sums = [0, 0, 0, 0], count = width * height;
  for (let i = 0; i < source.length; i += 4) for (let c = 0; c < 4; c += 1) sums[c] = sums[c]! + source[i + c]!;
  const average = sums.map((sum) => Math.round(sum / count));
  for (let i = 0; i < output.length; i += 4) for (let c = 0; c < 4; c += 1) output[i + c] = average[c]!;
  return output;
}

/**
 * Linear Motion Blur — GEGL's `gegl:motion-blur-linear` (operations/common):
 * average `ceil(length) + 1` bilinear samples along a line of the given
 * length and angle, centred on each pixel. Distinct from a directional box
 * blur in that the sample step follows the exact angle rather than snapping
 * to whichever axis is nearer.
 */
function motionBlurFilter(source: Uint8ClampedArray, width: number, height: number, distance: number, angleDeg: number): Uint8ClampedArray {
  const output = new Uint8ClampedArray(source.length), theta = angleDeg * Math.PI / 180, length = Math.max(1, distance);
  const steps = Math.ceil(length) + 1, offsetX = length * Math.cos(theta), offsetY = length * Math.sin(theta);
  const sample = new Float64Array(4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    let sum0 = 0, sum1 = 0, sum2 = 0, sum3 = 0;
    for (let step = 0; step < steps; step += 1) {
      const t = steps === 1 ? 0 : step / (steps - 1) - 0.5;
      sampleBilinearInto4(source, width, height, x + offsetX * t, y + offsetY * t, sample);
      sum0 += sample[0]!; sum1 += sample[1]!; sum2 += sample[2]!; sum3 += sample[3]!;
    }
    const i = (y * width + x) * 4;
    output[i] = byte(sum0 / steps); output[i + 1] = byte(sum1 / steps); output[i + 2] = byte(sum2 / steps); output[i + 3] = byte(sum3 / steps);
  }
  return output;
}

/**
 * Radial Blur — GEGL's `gegl:motion-blur-circular` (Spin) and
 * `gegl:motion-blur-zoom` (Zoom), both from `operations/common-gpl3+`:
 * Spin accumulates bilinear samples along the arc swept by `amount` degrees
 * around the centre; Zoom accumulates samples along the line from each pixel
 * toward the centre, scaled by `amount`.
 */
function radialBlurFilter(source: Uint8ClampedArray, width: number, height: number, amountPercent: number, method: number): Uint8ClampedArray {
  const output = new Uint8ClampedArray(source.length), cx = width / 2, cy = height / 2;
  if (method >= 1) {
    const factor = Math.max(0, Math.min(100, amountPercent)) / 100 * 0.5;
    const sample = new Float64Array(4);
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
      const endX = x + (cx - x) * factor, endY = y + (cy - y) * factor;
      const steps = Math.max(3, Math.min(64, Math.ceil(Math.hypot(endX - x, endY - y)) + 1));
      let sum0 = 0, sum1 = 0, sum2 = 0, sum3 = 0;
      for (let step = 0; step < steps; step += 1) {
        const t = step / (steps - 1);
        sampleBilinearInto4(source, width, height, x + (endX - x) * t, y + (endY - y) * t, sample);
        sum0 += sample[0]!; sum1 += sample[1]!; sum2 += sample[2]!; sum3 += sample[3]!;
      }
      const i = (y * width + x) * 4;
      output[i] = byte(sum0 / steps); output[i + 1] = byte(sum1 / steps); output[i + 2] = byte(sum2 / steps); output[i + 3] = byte(sum3 / steps);
    }
    return output;
  }
  const angle = Math.max(0, Math.min(100, amountPercent)) / 100 * Math.PI / 6;
  const spinSample = new Float64Array(4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const dx = x - cx, dy = y - cy, r = Math.hypot(dx, dy);
    const steps = Math.max(3, Math.min(64, Math.ceil(r * angle * 1.41)));
    const phiBase = Math.atan2(dy, dx), phiStart = phiBase + angle / 2, phiStep = angle / steps;
    let sum0 = 0, sum1 = 0, sum2 = 0, sum3 = 0;
    for (let step = 0; step < steps; step += 1) {
      const phi = phiStart - step * phiStep;
      sampleBilinearInto4(source, width, height, cx + r * Math.cos(phi), cy + r * Math.sin(phi), spinSample);
      sum0 += spinSample[0]!; sum1 += spinSample[1]!; sum2 += spinSample[2]!; sum3 += spinSample[3]!;
    }
    const i = (y * width + x) * 4;
    output[i] = byte(sum0 / steps); output[i + 1] = byte(sum1 / steps); output[i + 2] = byte(sum2 / steps); output[i + 3] = byte(sum3 / steps);
  }
  return output;
}

/**
 * Surface Blur — GEGL's `gegl:gaussian-blur-selective`
 * (operations/common-gpl3+/gaussian-blur-selective.c): a Gaussian-weighted
 * average that skips any neighbour whose colour differs from the centre
 * pixel by more than `threshold`, which is what keeps edges sharp while
 * smoothing flat regions.
 */
function surfaceBlurFilter(source: Uint8ClampedArray, width: number, height: number, radius: number, thresholdPercent: number): Uint8ClampedArray {
  // Unchanged arithmetic (pinned by filters-speed.test.ts); the disc's offsets and each offset's
  // Gaussian weight are computed once per call instead of per sample, and the per-pixel arrays are
  // plain locals.
  const output = new Uint8ClampedArray(source.length), r = Math.max(1, Math.min(50, Math.round(radius))), maxDelta = Math.max(0, Math.min(100, thresholdPercent)) * 2.55;
  const offsetX: number[] = [], offsetY: number[] = [], falloff: number[] = [];
  for (let dy = -r; dy <= r; dy += 1) for (let dx = -r; dx <= r; dx += 1) {
    const distanceSquared = dx * dx + dy * dy;
    if (distanceSquared > r * r) continue;
    offsetX.push(dx); offsetY.push(dy); falloff.push(Math.exp(-0.5 * distanceSquared / r));
  }
  const taps = offsetX.length, maxX = width - 1, maxY = height - 1;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const centerIndex = (y * width + x) * 4;
    const c0 = source[centerIndex]!, c1 = source[centerIndex + 1]!, c2 = source[centerIndex + 2]!;
    let sum0 = 0, sum1 = 0, sum2 = 0, weight0 = 0, weight1 = 0, weight2 = 0;
    for (let t = 0; t < taps; t += 1) {
      const sx = x + offsetX[t]!, sy = y + offsetY[t]!;
      const sampleIndex = ((sy < 0 ? 0 : sy > maxY ? maxY : sy) * width + (sx < 0 ? 0 : sx > maxX ? maxX : sx)) * 4;
      const weight = falloff[t]! * (source[sampleIndex + 3]! / 255);
      const s0 = source[sampleIndex]!, s1 = source[sampleIndex + 1]!, s2 = source[sampleIndex + 2]!;
      let diff = c0 - s0; if (!(diff > maxDelta || diff < -maxDelta)) { sum0 += weight * s0; weight0 += weight; }
      diff = c1 - s1; if (!(diff > maxDelta || diff < -maxDelta)) { sum1 += weight * s1; weight1 += weight; }
      diff = c2 - s2; if (!(diff > maxDelta || diff < -maxDelta)) { sum2 += weight * s2; weight2 += weight; }
    }
    output[centerIndex] = weight0 > 0 ? byte(sum0 / weight0) : c0;
    output[centerIndex + 1] = weight1 > 0 ? byte(sum1 / weight1) : c1;
    output[centerIndex + 2] = weight2 > 0 ? byte(sum2 / weight2) : c2;
    output[centerIndex + 3] = source[centerIndex + 3]!;
  }
  return output;
}

/** Lens Blur, approximated as a disc-shaped (circular aperture) average — the
 * kernel shape a real camera iris produces, distinct from Gaussian/box. A
 * full depth-map-driven implementation needs a depth channel this engine
 * does not have yet (docs/master-plan.md §51). */
function lensBlurFilter(source: Uint8ClampedArray, width: number, height: number, radius: number): Uint8ClampedArray {
  // A disc average is separable into per-row spans: for each output row, a running column sum over
  // the disc's vertical extent is not enough (the disc is not a box), but each disc row is a
  // contiguous horizontal span, so a per-row prefix sum makes every span O(1). Integer sums, same
  // division — identical output (pinned by filters-speed.test.ts), O(width·height·(2r+1)) instead
  // of O(width·height·πr²).
  const output = new Uint8ClampedArray(source.length), r = Math.max(1, Math.min(50, Math.round(radius)));
  let taps = 0;
  const halfWidth = new Int32Array(2 * r + 1);
  for (let dy = -r; dy <= r; dy += 1) { let extent = -1; for (let dx = 0; dx <= r; dx += 1) if (dx * dx + dy * dy <= r * r) extent = dx; halfWidth[dy + r] = extent; taps += extent >= 0 ? extent * 2 + 1 : 0; }
  // A row's prefix sums over its clamped pixels, extended by r copies of the edge pixel on each side
  // so a span past the edge counts those copies, as the clamped sampling did. Only the 2r+1 rows the
  // current output row reads are kept.
  const paddedWidth = width + 2 * r, maxY = height - 1;
  const rowPrefix: (Float64Array | null)[] = new Array(height).fill(null);
  const prefixOf = (sourceRow: number): Float64Array => {
    let row = rowPrefix[sourceRow];
    if (row) return row;
    row = new Float64Array((paddedWidth + 1) * 4);
    for (let px = 0; px < paddedWidth; px += 1) {
      const sx = px - r, index = (sourceRow * width + (sx < 0 ? 0 : sx >= width ? width - 1 : sx)) * 4, at = (px + 1) * 4, previous = px * 4;
      row[at] = row[previous]! + source[index]!; row[at + 1] = row[previous + 1]! + source[index + 1]!; row[at + 2] = row[previous + 2]! + source[index + 2]!; row[at + 3] = row[previous + 3]! + source[index + 3]!;
    }
    rowPrefix[sourceRow] = row;
    return row;
  };
  for (let y = 0; y < height; y += 1) {
    if (y - r - 1 >= 0) rowPrefix[y - r - 1] = null;
    for (let x = 0; x < width; x += 1) {
      let sum0 = 0, sum1 = 0, sum2 = 0, sum3 = 0;
      for (let dy = -r; dy <= r; dy += 1) {
        const extent = halfWidth[dy + r]!;
        if (extent < 0) continue;
        const sy = y + dy, row = prefixOf(sy < 0 ? 0 : sy > maxY ? maxY : sy);
        const from = (x + r - extent) * 4, to = (x + r + extent + 1) * 4;
        sum0 += row[to]! - row[from]!; sum1 += row[to + 1]! - row[from + 1]!; sum2 += row[to + 2]! - row[from + 2]!; sum3 += row[to + 3]! - row[from + 3]!;
      }
      const i = (y * width + x) * 4;
      output[i] = byte(sum0 / taps); output[i + 1] = byte(sum1 / taps); output[i + 2] = byte(sum2 / taps); output[i + 3] = byte(sum3 / taps);
    }
  }
  return output;
}

/**
 * Polar Coordinates — port of GIMP/GEGL's `polar-coordinates.c`
 * (operations/common-gpl3+), fixed at the dialog's own defaults (full
 * circle depth, no offset angle, centred pole) since this engine exposes
 * only the direction toggle Photoshop's simplest use covers.
 */
function polarCoordinatesFilter(source: Uint8ClampedArray, width: number, height: number, toRectangular: boolean): Uint8ClampedArray {
  const output = new Uint8ClampedArray(source.length), cx = width / 2, cy = height / 2;
  const xm = width / 2, ym = height / 2, rmax = Math.min(xm, ym);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    let srcX: number, srcY: number;
    if (!toRectangular) {
      // Rectangular -> Polar: sample from the angle/radius the output pixel would map to.
      const dx = x - cx, dy = y - cy;
      let phi = Math.atan2(dx, -dy);
      if (phi < 0) phi += 2 * Math.PI;
      const r = Math.hypot(dx, dy);
      srcX = (phi / (2 * Math.PI)) * width;
      srcY = height - (r / rmax) * height;
    } else {
      // Polar -> Rectangular: the inverse mapping.
      const phi = (x / width) * 2 * Math.PI;
      const r = ((height - y) / height) * rmax;
      srcX = cx + r * Math.sin(phi);
      srcY = cy - r * Math.cos(phi);
    }
    const [r2, g2, b2, a2] = sampleBilinear(source, width, height, srcX, srcY), i = (y * width + x) * 4;
    output[i] = r2; output[i + 1] = g2; output[i + 2] = b2; output[i + 3] = a2;
  }
  return output;
}

/** Shear — the affine core of GEGL's `gegl:shear` (operations/transform):
 * a horizontal offset that follows an actual draggable curve, not just a linear slope: Photoshop's
 * own Shear dialog is a vertical curve editor, not an Amount slider (docs/master-plan.md §51 —
 * the earlier single-Amount version was this filter's own honest admission that it only covered
 * the curve's straight-line case). `points` is five control values (percent horizontal offset,
 * evenly spaced top-to-bottom) interpolated with a Catmull-Rom spline — the standard way to draw a
 * smooth curve through a small fixed set of points without needing free-form point add/remove.
 */
function evalCurve(points: readonly number[], t: number): number {
  const n = points.length, scaled = t * (n - 1);
  const i = Math.max(0, Math.min(n - 2, Math.floor(scaled))), localT = scaled - i;
  const p0 = points[Math.max(0, i - 1)]!, p1 = points[i]!, p2 = points[i + 1]!, p3 = points[Math.min(n - 1, i + 2)]!;
  const t2 = localT * localT, t3 = t2 * localT;
  return 0.5 * (2 * p1 + (-p0 + p2) * localT + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}
function shearFilter(source: Uint8ClampedArray, width: number, height: number, points: readonly number[]): Uint8ClampedArray {
  const output = new Uint8ClampedArray(source.length);
  for (let y = 0; y < height; y += 1) {
    const t = height > 1 ? y / (height - 1) : 0;
    const shift = (evalCurve(points, t) / 100) * (width / 4);
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = sampleBilinear(source, width, height, x - shift, y), i = (y * width + x) * 4;
      output[i] = r; output[i + 1] = g; output[i + 2] = b; output[i + 3] = a;
    }
  }
  return output;
}

/**
 * Spherize — reduced form of GEGL's `gegl:spherize`
 * (operations/common/spherize.c) with `angle_of_view = 0` (no perspective)
 * and `curvature = 1` (full cap), which is the well-known
 * `asin`/`sin` radius remap the perspective camera model collapses to at
 * those defaults.
 */
function spherizeFilter(source: Uint8ClampedArray, width: number, height: number, amountPercent: number): Uint8ClampedArray {
  const output = new Uint8ClampedArray(source.length), cx = width / 2, cy = height / 2;
  const factor = Math.max(-100, Math.min(100, amountPercent)) / 100, inverse = factor < 0, absFactor = Math.abs(factor);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const nx = (x - cx) / (width / 2), ny = (y - cy) / (height / 2), d2 = nx * nx + ny * ny;
    let srcX = x, srcY = y;
    if (d2 > 1e-10 && d2 < 1 - 1e-10) {
      const d = Math.sqrt(d2);
      let srcD = inverse ? Math.sin(d * Math.PI / 2) : (2 / Math.PI) * Math.asin(d);
      if (absFactor < 1) srcD = d + (srcD - d) * absFactor;
      srcX = cx + (srcD * nx / d) * (width / 2);
      srcY = cy + (srcD * ny / d) * (height / 2);
    }
    const [r, g, b, a] = sampleBilinear(source, width, height, srcX, srcY), i = (y * width + x) * 4;
    output[i] = r; output[i + 1] = g; output[i + 2] = b; output[i + 3] = a;
  }
  return output;
}

/** Ripple — GEGL's `gegl:ripple` (operations/common-gpl3+/ripple.c) at its
 * own `angle = 0` default: a sine-wave vertical displacement whose phase
 * varies with x, i.e. Photoshop's own Amount/Size ripple with no angle
 * control exposed. */
function rippleFilter(source: Uint8ClampedArray, width: number, height: number, amountPercent: number, size: number): Uint8ClampedArray {
  const output = new Uint8ClampedArray(source.length);
  // Size (Small/Medium/Large) scales the ripple's period — a shorter period packs more, tighter
  // ripples into the same distance, exactly what "smaller" ripples means visually.
  const sizeDivisor = [20, 10, 5][Math.round(size)] ?? 10;
  const amplitude = Math.max(0, amountPercent) / 999 * Math.min(width, height) * 0.08, period = Math.max(2, Math.min(width, height) / sizeDivisor);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const shift = amplitude * Math.sin((2 * Math.PI * x) / period);
    const [r, g, b, a] = sampleBilinear(source, width, height, x, y + shift), i = (y * width + x) * 4;
    output[i] = r; output[i + 1] = g; output[i + 2] = b; output[i + 3] = a;
  }
  return output;
}

/** ZigZag — GEGL's `gegl:waves` (operations/common-gpl3+/waves.c): a radial
 * sine ripple from the centre, displacing each pixel along its own radius
 * ("Pond Ripples" in Photoshop's own ZigZag dialog). */
function zigzagFilter(source: Uint8ClampedArray, width: number, height: number, amountPercent: number): Uint8ClampedArray {
  const output = new Uint8ClampedArray(source.length), cx = width / 2, cy = height / 2;
  const amplitude = Math.max(0, amountPercent) / 100 * Math.min(width, height) * 0.05, period = Math.max(8, Math.min(width, height) / 6);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const dx = x - cx, dy = y - cy, r = Math.hypot(dx, dy) || 1e-6;
    const shift = amplitude * Math.sin((2 * Math.PI * r) / period);
    const [sr, sg, sb, sa] = sampleBilinear(source, width, height, x + (shift * dx) / r, y + (shift * dy) / r), i = (y * width + x) * 4;
    output[i] = sr; output[i + 1] = sg; output[i + 2] = sb; output[i + 3] = sa;
  }
  return output;
}

/** Kaleidoscope: folds the angle around the centre into `segments` mirrored
 * wedges before sampling — the standard angular-mirror technique (not a
 * native Photoshop filter; kept here as the same kind of bonus addition as
 * Glowing Edges/Plastic Wrap, docs/master-plan.md §51). */
function kaleidoscopeFilter(source: Uint8ClampedArray, width: number, height: number, segments: number, rotationDeg: number): Uint8ClampedArray {
  const output = new Uint8ClampedArray(source.length), cx = width / 2, cy = height / 2, n = Math.max(3, Math.round(segments)), wedge = Math.PI * 2 / n, rotation = rotationDeg * Math.PI / 180;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const dx = x - cx, dy = y - cy, r = Math.hypot(dx, dy);
    let angle = (Math.atan2(dy, dx) + rotation) % wedge;
    if (angle < 0) angle += wedge;
    if (angle > wedge / 2) angle = wedge - angle;
    const [sr, sg, sb, sa] = sampleBilinear(source, width, height, cx + r * Math.cos(angle), cy + r * Math.sin(angle)), i = (y * width + x) * 4;
    output[i] = sr; output[i + 1] = sg; output[i + 2] = sb; output[i + 3] = sa;
  }
  return output;
}

/** Offset — the classic wrap-around shift (`gegl:translate`-adjacent,
 * "Other > Offset" in Photoshop): rows/columns that leave one edge
 * reappear at the opposite one, exactly like the real dialog's default
 * "Wrap Around" undefined-area behaviour. */
function offsetFilter(source: Uint8ClampedArray, width: number, height: number, dx: number, dy: number, undefinedArea: number): Uint8ClampedArray {
  const output = new Uint8ClampedArray(source.length), ox = Math.round(dx), oy = Math.round(dy);
  const wrap = (value: number, size: number) => ((value % size) + size) % size;
  const clampX = (x: number) => Math.max(0, Math.min(width - 1, x)), clampY = (y: number) => Math.max(0, Math.min(height - 1, y));
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const i = (y * width + x) * 4;
    const sourceX = x - ox, sourceY = y - oy;
    const outOfBounds = sourceX < 0 || sourceX >= width || sourceY < 0 || sourceY >= height;
    if (outOfBounds && undefinedArea === 2) { output[i] = 0; output[i + 1] = 0; output[i + 2] = 0; output[i + 3] = 0; continue; }
    const sourceIndex = undefinedArea === 1
      ? (clampY(sourceY) * width + clampX(sourceX)) * 4
      : (wrap(sourceY, height) * width + wrap(sourceX, width)) * 4;
    output[i] = source[sourceIndex]!; output[i + 1] = source[sourceIndex + 1]!; output[i + 2] = source[sourceIndex + 2]!; output[i + 3] = source[sourceIndex + 3]!;
  }
  return output;
}

/** Maximum/Minimum — the standard morphological dilate/erode: each channel
 * becomes the max (or min) found within `radius`, independently per channel,
 * matching Photoshop's own "Other > Maximum/Minimum". */
// shape: 0 = Square (the full box — Photoshop's own default structuring element), 1 = Round
// (the circular kernel this filter used to be limited to), 2 = Diamond (taxicab distance).
function morphologyFilter(source: Uint8ClampedArray, width: number, height: number, radius: number, dilate: boolean, shape: number): Uint8ClampedArray {
  const output = new Uint8ClampedArray(source.length), r = Math.max(1, Math.min(20, Math.round(radius)));
  const clampX = (x: number) => Math.max(0, Math.min(width - 1, x)), clampY = (y: number) => Math.max(0, Math.min(height - 1, y));
  const inKernel = (dx: number, dy: number) => shape === 1 ? dx * dx + dy * dy <= r * r : shape === 2 ? Math.abs(dx) + Math.abs(dy) <= r : true;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const best = [dilate ? 0 : 255, dilate ? 0 : 255, dilate ? 0 : 255, dilate ? 0 : 255];
    for (let dy = -r; dy <= r; dy += 1) for (let dx = -r; dx <= r; dx += 1) {
      if (!inKernel(dx, dy)) continue;
      const index = (clampY(y + dy) * width + clampX(x + dx)) * 4;
      for (let c = 0; c < 4; c += 1) best[c] = dilate ? Math.max(best[c]!, source[index + c]!) : Math.min(best[c]!, source[index + c]!);
    }
    const i = (y * width + x) * 4;
    for (let c = 0; c < 4; c += 1) output[i + c] = best[c]!;
  }
  return output;
}

/**
 * Noise Reduction — port of GEGL's `gegl:noise-reduction`
 * (operations/common/noise-reduction.c): for each of the 8 neighbours,
 * blend half-way toward it only if doing so does not increase the
 * second-derivative metric along any of the 4 axes through the centre —
 * an edge-preserving smooth, iterated `iterations` times. `Despeckle` is
 * this at a single iteration; `Reduce Noise` exposes the iteration count as
 * its own Strength slider.
 */
function noiseReductionFilter(source: Uint8ClampedArray, width: number, height: number, iterations: number): Uint8ClampedArray {
  // The first version's exact arithmetic (pinned by filters-speed.test.ts), minus a closure and a
  // four-element array per channel of every pixel, and two destructurings per neighbour test — it
  // was the slowest filter in the catalogue, ~66 s projected at 2048x2048 (§58.1). The nine
  // clamped neighbour offsets are resolved once per pixel and shared by all three channels.
  let current = source;
  const maxX = width - 1, maxY = height - 1;
  // Neighbour order as before: [-1,-1] [0,-1] [1,-1] [-1,0] [1,0] [-1,1] [0,1] [1,1]; axis a pairs
  // neighbour a with 7 - a.
  const neighbour = new Int32Array(8), reference = new Float64Array(4), at = new Float64Array(8);
  for (let pass = 0; pass < Math.max(0, Math.round(iterations)); pass += 1) {
    const next = new Uint8ClampedArray(current.length), snapshot = current;
    for (let y = 0; y < height; y += 1) {
      const up = (y === 0 ? 0 : y - 1) * width, row = y * width, down = (y === maxY ? maxY : y + 1) * width;
      for (let x = 0; x < width; x += 1) {
        const left = x === 0 ? 0 : x - 1, right = x === maxX ? maxX : x + 1;
        neighbour[0] = (up + left) * 4; neighbour[1] = (up + x) * 4; neighbour[2] = (up + right) * 4;
        neighbour[3] = (row + left) * 4; neighbour[4] = (row + right) * 4;
        neighbour[5] = (down + left) * 4; neighbour[6] = (down + x) * 4; neighbour[7] = (down + right) * 4;
        const i = (row + x) * 4;
        for (let c = 0; c < 3; c += 1) {
          const center = snapshot[i + c]!;
          for (let n = 0; n < 8; n += 1) at[n] = snapshot[neighbour[n]! + c]!;
          for (let axis = 0; axis < 4; axis += 1) reference[axis] = (center * 2 - at[axis]! - at[7 - axis]!) ** 2;
          let sum = center, count = 1;
          for (let direction = 0; direction < 8; direction += 1) {
            const candidate = at[direction]! * 0.5 + center * 0.5;
            let valid = true;
            for (let axis = 0; axis < 4 && valid; axis += 1) {
              const before = axis === direction % 4 ? candidate : at[axis]!;
              const after = 7 - axis === direction ? candidate : at[7 - axis]!;
              if ((center * 2 - before - after) ** 2 > reference[axis]!) valid = false;
            }
            if (valid) { sum += candidate; count += 1; }
          }
          next[i + c] = byte(sum / count);
        }
        next[i + 3] = snapshot[i + 3]!;
      }
    }
    current = next;
  }
  return current === source ? source.slice() : current;
}

/** Sharpen More / Smart Sharpen share Unsharp Mask's core (blur, then push
 * the source away from its own blur) with a stronger fixed multiplier for
 * the one-click Photoshop preset, and an exposed radius for the tunable
 * dialog — the two are the same operation at different fixed points, not
 * two different algorithms. */
// Threshold defaults to 0 (every detail passes) so Sharpen More/Smart Sharpen's own calls, which
// never pass one, keep their exact prior output — this is Unsharp Mask's own extra knob, not a
// change to what those two already did.
function unsharpFilter(source: Uint8ClampedArray, width: number, height: number, blurRadius: number, strength: number, threshold = 0): Uint8ClampedArray {
  const output = new Uint8ClampedArray(source.length), blurred = blur(source, width, height, blurRadius);
  for (let i = 0; i < source.length; i += 4) {
    for (let c = 0; c < 3; c += 1) {
      // Patchy's own calibration note (docs/filters.md): the signed detail is scaled first, and
      // Threshold is then subtracted from its *magnitude* — a flat area under threshold stays
      // untouched instead of picking up a scaled-down nudge in the same direction.
      const detail = (source[i + c]! - blurred[i + c]!) * strength, magnitude = Math.abs(detail);
      const clipped = magnitude <= threshold ? 0 : (magnitude - threshold) * Math.sign(detail);
      output[i + c] = byte(source[i + c]! + clipped);
    }
    output[i + 3] = source[i + 3]!;
  }
  return output;
}

/** Sharpen Edges: Unsharp Mask's push, masked to where a Sobel-style edge
 * gradient exceeds a fixed threshold — flat regions (most of a photo) are
 * left untouched, matching Photoshop's own edge-only sharpen. */
function sharpenEdgesFilter(source: Uint8ClampedArray, width: number, height: number): Uint8ClampedArray {
  const output = source.slice(), blurred = blur(source, width, height, 2);
  const clampX = (x: number) => Math.max(0, Math.min(width - 1, x)), clampY = (y: number) => Math.max(0, Math.min(height - 1, y));
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const i = (y * width + x) * 4;
    const right = (clampY(y) * width + clampX(x + 1)) * 4, down = (clampY(y + 1) * width + clampX(x)) * 4;
    const edge = Math.abs(source[i]! - source[right]!) + Math.abs(source[i]! - source[down]!);
    if (edge <= 24) continue;
    for (let c = 0; c < 3; c += 1) output[i + c] = byte(source[i + c]! + (source[i + c]! - blurred[i + c]!) * 2);
  }
  return output;
}

/** Diffuse: swaps each pixel with a deterministically-hashed neighbour
 * within `amount` pixels — the classic GIMP "Spread" noise-dither, ported
 * to this project's own position hash (`addNoiseHash`) rather than a new
 * PRNG, so it stays reproducible the same way Add Noise is. */
/**
 * Diffuse — Photoshop's own four modes, not a bare Amount slider (the
 * reference panel has no Amount at all): Normal swaps each pixel with a
 * deterministically-hashed neighbour (GIMP's own Spread); Darker/Lighter
 * Only swap only when that neighbour is darker/lighter by luminance, which
 * is what keeps Lighter Only from ever muddying a bright area with a dark
 * neighbour and vice versa; Anisotropic reuses `noiseReductionFilter`'s own
 * single-pass edge-preserving diffusion outright — the same operation
 * Photoshop's own "Anisotropic" mode names.
 */
function diffuseFilter(source: Uint8ClampedArray, width: number, height: number, mode: number): Uint8ClampedArray {
  if (mode === 3) return noiseReductionFilter(source, width, height, 1);
  const output = new Uint8ClampedArray(source.length), r = 4;
  const clampX = (x: number) => Math.max(0, Math.min(width - 1, x)), clampY = (y: number) => Math.max(0, Math.min(height - 1, y));
  const luma = (i: number) => source[i]! * 30 + source[i + 1]! * 59 + source[i + 2]! * 11;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const hashX = addNoiseHash(x, y, 101), hashY = addNoiseHash(x, y, 202);
    const dx = Math.round(unitFromHash(hashX) * r), dy = Math.round(unitFromHash(hashY) * r);
    const sourceIndex = (clampY(y + dy) * width + clampX(x + dx)) * 4, i = (y * width + x) * 4;
    const useNeighbor = mode === 0 || (mode === 1 && luma(sourceIndex) < luma(i)) || (mode === 2 && luma(sourceIndex) > luma(i));
    const pick = useNeighbor ? sourceIndex : i;
    output[i] = source[pick]!; output[i + 1] = source[pick + 1]!; output[i + 2] = source[pick + 2]!; output[i + 3] = source[pick + 3]!;
  }
  return output;
}

/** Trace Contour: marks a thin white line wherever luminance crosses
 * `level` between a pixel and its right/bottom neighbour, black everywhere
 * else — Photoshop's own single-level contour band (its Upper/Lower pair
 * is two bands; this engine exposes one, per the plain-slider convention
 * every other single-level filter here already uses). */
// edge 0 (Lower) marks a crossing only where the centre sits on the darker side of the level;
// edge 1 (Upper) only on the lighter side — Photoshop's own pair of contour bands, not a single
// symmetric crossing test that ignores which side the reference panel's own Edge choice picks.
function traceContourFilter(source: Uint8ClampedArray, width: number, height: number, level: number, edge: number): Uint8ClampedArray {
  const output = new Uint8ClampedArray(source.length);
  const luma = (i: number) => (source[i]! * 30 + source[i + 1]! * 59 + source[i + 2]! * 11) / 100;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const i = (y * width + x) * 4, center = luma(i);
    const right = x + 1 < width ? luma(i + 4) : center, down = y + 1 < height ? luma(i + width * 4) : center;
    const crosses = (center - level) * (right - level) < 0 || (center - level) * (down - level) < 0;
    const onEdgeSide = edge === 0 ? center <= level : center >= level;
    const shade = crosses && onEdgeSide ? 255 : 0;
    output[i] = shade; output[i + 1] = shade; output[i + 2] = shade; output[i + 3] = source[i + 3]!;
  }
  return output;
}

/**
 * Wind — simplified from GEGL's `gegl:wind` (operations/common-gpl3+/wind.c):
 * scanning each row in the wind direction, an edge (luminance derivative
 * past `threshold`) streaks its colour forward for a hashed run length
 * proportional to Strength, blending with decreasing weight (Wind) or a
 * flat solid run (Blast) — the donor's own two styles, without its
 * per-pixel randomness (a deterministic hash keeps this reproducible).
 */
// No Strength parameter — the reference panel has none, only Technique/Direction — so the streak
// length is this filter's own fixed internal constant rather than a slider with nothing behind
// it. Stagger runs the same Wind streak but only on every other row, the classic "broken" look
// that distinguishes it from Wind's continuous one.
function windFilter(source: Uint8ClampedArray, width: number, height: number, technique: number, direction: number): Uint8ClampedArray {
  const output = source.slice(), fromLeft = direction >= 1, blast = technique === 1, stagger = technique === 2, strength = 20;
  const luma = (i: number) => (output[i]! * 30 + output[i + 1]! * 59 + output[i + 2]! * 11) / 100;
  for (let y = 0; y < height; y += 1) {
    if (stagger && y % 2 === 1) continue;
    let x = fromLeft ? width - 2 : 1;
    const step = fromLeft ? -1 : 1;
    while (fromLeft ? x >= 0 : x < width - 1) {
      const i = (y * width + x) * 4, next = i + step * 4;
      if (Math.abs(luma(i) - luma(next)) > 10) {
        const runLength = Math.max(1, Math.round((unitFromHash(addNoiseHash(x, y, 303)) * 0.5 + 0.5) * strength));
        const source4 = [output[i]!, output[i + 1]!, output[i + 2]!, output[i + 3]!];
        for (let k = 1; k <= runLength; k += 1) {
          const targetX = x + step * k;
          if (targetX < 0 || targetX >= width) break;
          const targetIndex = (y * width + targetX) * 4;
          const weight = blast ? 1 : Math.max(0, 1 - k / runLength);
          for (let c = 0; c < 3; c += 1) output[targetIndex + c] = byte(output[targetIndex + c]! + (source4[c]! - output[targetIndex + c]!) * weight);
        }
        x += step * (runLength + 1);
      } else {
        x += step;
      }
    }
  }
  return output;
}

/**
 * Oil Paint — port of GEGL's `gegl:oilify` (operations/common-gpl3+/oilify.c):
 * within `brushSize`, bucket every neighbour by quantised luminance, then
 * average each bucket's colour weighted by `(count / maxCount) ^ exponent`
 * — the most from the most-common intensity, the donor's own histogram
 * approach rather than a plain neighbourhood blur.
 */
function oilPaintFilter(source: Uint8ClampedArray, width: number, height: number, brushSize: number, exponent: number): Uint8ClampedArray {
  // Same arithmetic, in the same order, as the first version — its output is pinned byte for byte by
  // filters-speed.test.ts — without what made it hang the tab (docs/master-plan.md §58.1): 33 fresh
  // arrays, a spread and a closure per pixel. Buckets are computed once per source pixel, the disc's
  // offsets once per call, and the per-pixel state lives in typed arrays reset only where touched.
  const output = new Uint8ClampedArray(source.length), r = Math.max(1, Math.min(8, Math.round(brushSize))), buckets = 32;
  const exp = Math.max(1, Math.round(exponent));
  const bucketOf = new Uint8Array(width * height);
  for (let p = 0, index = 0; p < bucketOf.length; p += 1, index += 4) {
    const luma = (source[index]! * 30 + source[index + 1]! * 59 + source[index + 2]! * 11) / 100;
    bucketOf[p] = Math.min(buckets - 1, Math.floor((luma / 255) * buckets));
  }
  const offsetX: number[] = [], offsetY: number[] = [];
  for (let dy = -r; dy <= r; dy += 1) for (let dx = -r; dx <= r; dx += 1) if (dx * dx + dy * dy <= r * r) { offsetX.push(dx); offsetY.push(dy); }
  const taps = offsetX.length, maxX = width - 1, maxY = height - 1;
  const histogram = new Int32Array(buckets), bucketColor = new Float64Array(buckets * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    histogram.fill(0);
    bucketColor.fill(0);
    for (let t = 0; t < taps; t += 1) {
      const sx = x + offsetX[t]!, sy = y + offsetY[t]!;
      const p = (sy < 0 ? 0 : sy > maxY ? maxY : sy) * width + (sx < 0 ? 0 : sx > maxX ? maxX : sx), index = p * 4, bucket = bucketOf[p]!, slot = bucket * 4;
      histogram[bucket] = histogram[bucket]! + 1;
      bucketColor[slot] = bucketColor[slot]! + source[index]!;
      bucketColor[slot + 1] = bucketColor[slot + 1]! + source[index + 1]!;
      bucketColor[slot + 2] = bucketColor[slot + 2]! + source[index + 2]!;
      bucketColor[slot + 3] = bucketColor[slot + 3]! + source[index + 3]!;
    }
    let maxCount = 1;
    for (let b = 0; b < buckets; b += 1) if (histogram[b]! > maxCount) maxCount = histogram[b]!;
    let sum0 = 0, sum1 = 0, sum2 = 0, sum3 = 0, weightSum = 0;
    for (let b = 0; b < buckets; b += 1) {
      const count = histogram[b]!;
      if (count === 0) continue;
      let weight = 1;
      const ratio = count / maxCount;
      for (let power = 0; power < exp; power += 1) weight *= ratio;
      const perPixel = weight / count, slot = b * 4;
      sum0 += perPixel * bucketColor[slot]!; sum1 += perPixel * bucketColor[slot + 1]!; sum2 += perPixel * bucketColor[slot + 2]!; sum3 += perPixel * bucketColor[slot + 3]!;
      weightSum += weight;
    }
    const i = (y * width + x) * 4;
    if (weightSum > 0) { output[i] = byte(sum0 / weightSum); output[i + 1] = byte(sum1 / weightSum); output[i + 2] = byte(sum2 / weightSum); output[i + 3] = byte(sum3 / weightSum); }
    else { output[i] = source[i]!; output[i + 1] = source[i + 1]!; output[i + 2] = source[i + 2]!; output[i + 3] = source[i + 3]!; }
  }
  return output;
}

/**
 * Emboss — the classic John Schlag algorithm (Graphics Gems IV, 1994),
 * as GEGL's `gegl:emboss` (operations/common-gpl3+/emboss.c) ports it:
 * a 3×3 luminance gradient (Nx, Ny) shaded against a light direction
 * (Lx, Ly, Lz) derived from Angle/Elevation, with Height standing in for
 * the donor's own `Nz = 1/width45` surface-flatness term.
 */
function embossFilter(source: Uint8ClampedArray, width: number, height: number, angleDeg: number, heightParam: number, amountPercent: number): Uint8ClampedArray {
  const output = new Uint8ClampedArray(source.length);
  const azimuth = angleDeg * Math.PI / 180, elevation = 45 * Math.PI / 180;
  const lx = Math.cos(azimuth) * Math.cos(elevation), ly = Math.sin(azimuth) * Math.cos(elevation), lz = Math.sin(elevation);
  const nz = 1 / Math.max(0.1, heightParam), nz2 = nz * nz, nzlz = nz * lz;
  const strength = Math.max(0, amountPercent) / 100;
  const clampX = (x: number) => Math.max(0, Math.min(width - 1, x)), clampY = (y: number) => Math.max(0, Math.min(height - 1, y));
  const luma = (x: number, y: number) => { const i = (clampY(y) * width + clampX(x)) * 4; return (source[i]! * 30 + source[i + 1]! * 59 + source[i + 2]! * 11) / 100 / 255; };
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const topLeft = luma(x - 1, y - 1), top = luma(x, y - 1), topRight = luma(x + 1, y - 1);
    const left = luma(x - 1, y), right = luma(x + 1, y);
    const bottomLeft = luma(x - 1, y + 1), bottom = luma(x, y + 1), bottomRight = luma(x + 1, y + 1);
    const nx = topLeft + left + bottomLeft - topRight - right - bottomRight;
    const ny = bottomLeft + bottom + bottomRight - topLeft - top - topRight;
    let shade: number;
    if (nx === 0 && ny === 0) shade = lz;
    else { const ndotl = nx * lx + ny * ly + nzlz; shade = ndotl < 0 ? 0 : ndotl / Math.sqrt(nx * nx + ny * ny + nz2); }
    const gray = byte(shade * 255 * strength + 128 * (1 - strength)), i = (y * width + x) * 4;
    output[i] = gray; output[i + 1] = gray; output[i + 2] = gray; output[i + 3] = source[i + 3]!;
  }
  return output;
}

/**
 * Lens Flare — direct port of GIMP/GEGL's `gegl:lens-flare`
 * (operations/common-gpl3+/lens-flare.c): five concentric glow rings around
 * the light source plus 19 fixed secondary reflections along the line
 * through the image centre, each with the donor's own exact size/colour
 * table. `positionX`/`positionY` are this filter's canvas-click parameters
 * (docs/master-plan.md §51's interactivity level 2). The reference panel's
 * own "Тип: Lens 1/2/3/4" choice picks among Photoshop's four lens
 * presets (50-300mm Zoom/35mm Prime/105mm Prime/Movie Prime) — GEGL only
 * ports the one 50mm-class table, so the other three are real, visibly
 * distinct variants built on it: a tighter/looser core+halo size and a
 * scaled-down or scaled-up secondary-reflection strength per lens, and for
 * Movie Prime specifically the horizontal anamorphic streak through the
 * light source that a cylindrical-lens flare is known for and a spherical
 * lens (the other three) never shows.
 */
function lensFlareFilter(source: Uint8ClampedArray, width: number, height: number, brightnessPercent: number, lensType: number, positionXPercent: number, positionYPercent: number): Uint8ClampedArray {
  const output = source.slice();
  const centerX = (positionXPercent / 100) * width, centerY = (positionYPercent / 100) * height;
  const lensPresets = [
    { matteScale: 1, reflectionStrength: 1, anamorphic: false },
    { matteScale: 0.6, reflectionStrength: 0.65, anamorphic: false },
    { matteScale: 0.85, reflectionStrength: 1.15, anamorphic: false },
    { matteScale: 0.9, reflectionStrength: 0.45, anamorphic: true },
  ];
  const preset = lensPresets[Math.round(lensType)] ?? lensPresets[0]!;
  const matte = width * preset.matteScale, brightness = Math.max(0, brightnessPercent) / 100;
  const colorSize = matte * 0.0375, glowSize = matte * 0.078125, innerSize = matte * 0.1796875, outerSize = matte * 0.3359375, haloSize = matte * 0.084375;
  const color = [0.937255, 0.937255, 0.937255], glow = [0.960784, 0.960784, 0.960784], inner = [1, 0.14902, 0.168627], outer = [0.270588, 0.231373, 0.25098], halo = [0.313726, 0.058824, 0.015686];
  const xh = width / 2, yh = height / 2, dx = xh - centerX, dy = yh - centerY;
  const reflections: { size: number; xp: number; yp: number; type: number; color: number[] }[] = [
    { f: 0.6699, size: 0.027, type: 1, color: [0, 0.054902, 0.443137] },
    { f: 0.2692, size: 0.01, type: 1, color: [0.352941, 0.709804, 0.556863] },
    { f: -0.0112, size: 0.005, type: 1, color: [0.219608, 0.54902, 0.415686] },
    { f: 0.649, size: 0.031, type: 2, color: [0.035294, 0.113725, 0.07451] },
    { f: 0.4696, size: 0.015, type: 2, color: [0.094118, 0.054902, 0] },
    { f: 0.4087, size: 0.037, type: 2, color: [0.094118, 0.054902, 0] },
    { f: -0.2003, size: 0.022, type: 2, color: [0.164706, 0.07451, 0] },
    { f: -0.4103, size: 0.025, type: 2, color: [0, 0.035294, 0.066667] },
    { f: -0.4503, size: 0.058, type: 2, color: [0, 0.015686, 0.039216] },
    { f: -0.5112, size: 0.017, type: 2, color: [0.019608, 0.019608, 0.054902] },
    { f: -1.496, size: 0.2, type: 2, color: [0.035294, 0.015686, 0] },
    { f: -1.496, size: 0.5, type: 2, color: [0.035294, 0.015686, 0] },
    { f: 0.4487, size: 0.075, type: 3, color: [0.133333, 0.07451, 0] },
    { f: 1, size: 0.1, type: 3, color: [0.054902, 0.101961, 0] },
    { f: -1.301, size: 0.039, type: 3, color: [0.039216, 0.098039, 0.05098] },
    { f: 1.309, size: 0.19, type: 4, color: [0.035294, 0, 0.066667] },
    { f: 1.309, size: 0.195, type: 4, color: [0.035294, 0.062745, 0.019608] },
    { f: 1.309, size: 0.2, type: 4, color: [0.066667, 0.015686, 0] },
    { f: -1.301, size: 0.038, type: 4, color: [0.066667, 0.015686, 0] },
  ].map((r) => ({ size: matte * r.size, xp: r.f * dx + xh, yp: r.f * dy + yh, type: r.type, color: r.color }));
  const fixPixel = (pixel: number[], percent: number, colorProportion: number[]) => { for (let c = 0; c < 3; c += 1) pixel[c]! += (1 - pixel[c]!) * percent * colorProportion[c]! * brightness; };
  // Every reflection reaches at most `size * 1.04` from its own centre (the ring type is the widest
  // of the four), so a pixel outside that box cannot be touched by it. Testing the box first —
  // per row, then per pixel — skips the distance for nearly every pixel/reflection pair without
  // changing the order the reflections are applied in, which `fixPixel` is not commutative in
  // (docs/master-plan.md §58.1: this filter projected to ~2.6 s at 2048×2048).
  const reach = reflections.map((reflection) => reflection.size * 1.04);
  const rowReflections: typeof reflections = [];
  const rowReach: number[] = [];
  const pixel = [0, 0, 0];
  for (let y = 0; y < height; y += 1) {
    rowReflections.length = 0; rowReach.length = 0;
    for (let index = 0; index < reflections.length; index += 1) {
      const reflection = reflections[index]!, radius = reach[index]!;
      if (y >= reflection.yp - radius && y <= reflection.yp + radius) { rowReflections.push(reflection); rowReach.push(radius); }
    }
    for (let x = 0; x < width; x += 1) {
    const i = (y * width + x) * 4;
    pixel[0] = source[i]! / 255; pixel[1] = source[i + 1]! / 255; pixel[2] = source[i + 2]! / 255;
    const hyp = Math.hypot(x - centerX, y - centerY);
    let percent = (colorSize - hyp) / colorSize; if (percent > 0) fixPixel(pixel, percent * percent, color);
    percent = (glowSize - hyp) / glowSize; if (percent > 0) fixPixel(pixel, percent * percent, glow);
    percent = (innerSize - hyp) / innerSize; if (percent > 0) fixPixel(pixel, percent * percent, inner);
    percent = (outerSize - hyp) / outerSize; if (percent > 0) fixPixel(pixel, percent, outer);
    percent = Math.abs((hyp - haloSize) / (haloSize * 0.07)); if (percent < 1) fixPixel(pixel, 1 - percent, halo);
    for (let index = 0; index < rowReflections.length; index += 1) {
      const reflection = rowReflections[index]!, radius = rowReach[index]!;
      if (x < reflection.xp - radius || x > reflection.xp + radius) continue;
      const rhyp = Math.hypot(x - reflection.xp, y - reflection.yp);
      if (reflection.type === 1) { const p = (reflection.size - rhyp) / reflection.size; if (p > 0) fixPixel(pixel, p * p * preset.reflectionStrength, reflection.color); }
      else if (reflection.type === 2) { const p = Math.min(1, (reflection.size - rhyp) / (reflection.size * 0.15)); if (p > 0) fixPixel(pixel, p * preset.reflectionStrength, reflection.color); }
      else if (reflection.type === 3) { let p = (reflection.size - rhyp) / (reflection.size * 0.12); if (p > 0) { if (p > 1) p = 1 - p * 0.12; fixPixel(pixel, p * preset.reflectionStrength, reflection.color); } }
      else { const p = Math.abs((rhyp - reflection.size) / (reflection.size * 0.04)); if (p < 1) fixPixel(pixel, (1 - p) * preset.reflectionStrength, reflection.color); }
    }
    if (preset.anamorphic) {
      const bandHalf = height * 0.006 + 1.5, distY = Math.abs(y - centerY);
      if (distY < bandHalf) fixPixel(pixel, (1 - distY / bandHalf) * Math.max(0, 1 - Math.abs(x - centerX) / (width * 0.6)) * 0.85, [0.6, 0.75, 1]);
    }
    output[i] = byte(pixel[0]! * 255); output[i + 1] = byte(pixel[1]! * 255); output[i + 2] = byte(pixel[2]! * 255); output[i + 3] = source[i + 3]!;
    }
  }
  return output;
}

/**
 * Shared cellular tessellation for Crystallize and Pointillize: a jittered
 * grid — one feature point per `cellSize`×`cellSize` cell, displaced within
 * it by `addNoiseHash` — is the standard simplified form of the Worley/
 * cellular noise GEGL's own `noise-cell.c` cites (Worley, SIGGRAPH '96;
 * that donor varies point *count* per cell via a Poisson table this port
 * skips for one point per cell, still the same nearest-feature-point
 * technique). Each source pixel is assigned to its nearest feature point by
 * scanning the 3×3 neighbourhood of grid cells around it — enough since no
 * jitter ever pushes a point out of its own cell — and each point's pixels
 * are averaged into one cell colour.
 */
function cellularTessellation(source: Uint8ClampedArray, width: number, height: number, cellSize: number): { cellOf: Int32Array; cellColor: number[][]; points: { x: number; y: number }[] } {
  const size = Math.max(3, Math.round(cellSize)), cols = Math.ceil(width / size), rows = Math.ceil(height / size);
  const points: { x: number; y: number }[] = [];
  for (let row = 0; row < rows; row += 1) for (let col = 0; col < cols; col += 1) {
    const jitterX = (unitFromHash(addNoiseHash(col, row, 11)) * 0.5 + 0.5) * size, jitterY = (unitFromHash(addNoiseHash(col, row, 17)) * 0.5 + 0.5) * size;
    points.push({ x: col * size + jitterX, y: row * size + jitterY });
  }
  const cellOf = new Int32Array(width * height), sums: number[][] = points.map(() => [0, 0, 0, 0, 0]);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const col = Math.floor(x / size), row = Math.floor(y / size);
    let best = -1, bestDistance = Infinity;
    for (let dr = -1; dr <= 1; dr += 1) for (let dc = -1; dc <= 1; dc += 1) {
      const c = col + dc, r = row + dr;
      if (c < 0 || c >= cols || r < 0 || r >= rows) continue;
      const index = r * cols + c, point = points[index]!, distance = (point.x - x) ** 2 + (point.y - y) ** 2;
      if (distance < bestDistance) { bestDistance = distance; best = index; }
    }
    const pixelIndex = (y * width + x) * 4;
    cellOf[y * width + x] = best;
    const sum = sums[best]!;
    sum[0] = sum[0]! + source[pixelIndex]!; sum[1] = sum[1]! + source[pixelIndex + 1]!; sum[2] = sum[2]! + source[pixelIndex + 2]!; sum[3] = sum[3]! + source[pixelIndex + 3]!; sum[4] = sum[4]! + 1;
  }
  const cellColor = sums.map((sum) => sum[4]! > 0 ? [sum[0]! / sum[4]!, sum[1]! / sum[4]!, sum[2]! / sum[4]!, sum[3]! / sum[4]!] : [0, 0, 0, 0]);
  return { cellOf, cellColor, points };
}

/** Crystallize: every pixel takes its own cell's average colour — flat
 * polygonal facets, Voronoi-style. */
function crystallizeFilter(source: Uint8ClampedArray, width: number, height: number, cellSize: number): Uint8ClampedArray {
  const output = new Uint8ClampedArray(source.length), { cellOf, cellColor } = cellularTessellation(source, width, height, cellSize);
  for (let p = 0; p < width * height; p += 1) {
    const color = cellColor[cellOf[p]!]!, i = p * 4;
    output[i] = byte(color[0]!); output[i + 1] = byte(color[1]!); output[i + 2] = byte(color[2]!); output[i + 3] = byte(color[3]!);
  }
  return output;
}

/** Pointillize: the same tessellation, but each cell draws only a colour
 * dot at its own feature point (radius proportional to the cell), on the
 * canvas's own background colour rather than filling the whole facet —
 * Photoshop's own look (dots of paint on canvas), distinct from
 * Crystallize's solid facets even though both share one nearest-point
 * search. */
function pointillizeFilter(source: Uint8ClampedArray, width: number, height: number, cellSize: number): Uint8ClampedArray {
  // Every pixel used to be tested against every dot in the image. A dot lies inside its own cell,
  // and one within `dotRadius` (< one cell) of a pixel can only be in the pixel's cell or a direct
  // neighbour — so only those nine are tested, in ascending index order so ties resolve as before
  // (pinned by filters-speed.test.ts).
  const size = Math.max(3, Math.round(cellSize)), { cellColor, points } = cellularTessellation(source, width, height, cellSize);
  const cols = Math.ceil(width / size), rows = Math.ceil(height / size);
  const output = new Uint8ClampedArray(source.length).fill(255);
  for (let i = 3; i < output.length; i += 4) output[i] = 255;
  const dotRadius = size * 0.42;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const i = (y * width + x) * 4, col = Math.floor(x / size), row = Math.floor(y / size);
    let best = -1, bestDistance = dotRadius * dotRadius;
    for (let dr = -1; dr <= 1; dr += 1) {
      const r = row + dr; if (r < 0 || r >= rows) continue;
      for (let dc = -1; dc <= 1; dc += 1) {
        const c = col + dc; if (c < 0 || c >= cols) continue;
        const index = r * cols + c, point = points[index]!, distance = (point.x - x) ** 2 + (point.y - y) ** 2;
        if (distance < bestDistance) { bestDistance = distance; best = index; }
      }
    }
    if (best >= 0) { const color = cellColor[best]!; output[i] = byte(color[0]!); output[i + 1] = byte(color[1]!); output[i + 2] = byte(color[2]!); output[i + 3] = byte(color[3]!); }
  }
  return output;
}

/** Fragment: Photoshop's own classic one-click effect — four copies of the
 * image, offset diagonally by `amount` in each direction, averaged
 * together. */
function fragmentFilter(source: Uint8ClampedArray, width: number, height: number, amount: number): Uint8ClampedArray {
  const output = new Uint8ClampedArray(source.length), offsets = [[-amount, -amount], [amount, -amount], [-amount, amount], [amount, amount]];
  const clampX = (x: number) => Math.max(0, Math.min(width - 1, x)), clampY = (y: number) => Math.max(0, Math.min(height - 1, y));
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const sum = [0, 0, 0, 0];
    for (const [dx, dy] of offsets) {
      const index = (clampY(y + dy!) * width + clampX(x + dx!)) * 4;
      for (let c = 0; c < 4; c += 1) sum[c] = sum[c]! + source[index + c]!;
    }
    const i = (y * width + x) * 4;
    for (let c = 0; c < 4; c += 1) output[i + c] = byte(sum[c]! / offsets.length);
  }
  return output;
}

/** Mezzotint: ordered dither to black/white using the same Bayer-matrix
 * technique `eInkFilter` already established for this project, across the
 * reference panel's full ten grain patterns — Fine/Medium/Grainy/Coarse
 * Dots, Short/Medium/Long Lines, and Short/Medium/Long Strokes — not just
 * the four this filter used to distinguish. Dots vary grid grain (Grainy
 * swaps the grid for a per-pixel random threshold, the actual irregular
 * look "grainy" implies); Lines are horizontal alternating bands at three
 * thicknesses; Strokes are those same bands additionally broken into
 * hashed-length dashes along x, the brush-stroke look that separates them
 * from perfectly continuous Lines. */
function mezzotintFilter(source: Uint8ClampedArray, width: number, height: number, type: number): Uint8ClampedArray {
  const output = new Uint8ClampedArray(source.length);
  const isDots = type <= 3, isLines = type >= 4 && type <= 6;
  const dotGrain = [2, 4, 0, 8][type] ?? 2;
  const lineGrain = [4, 8, 14][type - 4] ?? 8;
  const strokeGrain = [4, 8, 14][type - 7] ?? 8;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const i = (y * width + x) * 4;
    const luma = (source[i]! * 30 + source[i + 1]! * 59 + source[i + 2]! * 11) / 100 / 255;
    let threshold: number;
    if (isDots) {
      if (type === 2) {
        threshold = (addNoiseHash(x, y, 909) >>> 24) / 255;
      } else {
        const cellX = x % dotGrain, cellY = y % dotGrain, cellIndex = cellY * dotGrain + cellX;
        threshold = (addNoiseHash(Math.floor(x / dotGrain), Math.floor(y / dotGrain), cellIndex) >>> 24) / 255;
      }
    } else if (isLines) {
      threshold = Math.abs((y % (lineGrain * 2)) - lineGrain) / lineGrain;
    } else {
      const bandThreshold = Math.abs((y % (strokeGrain * 2)) - strokeGrain) / strokeGrain;
      const dashPeriod = strokeGrain * 3, dashPhase = Math.floor(x / dashPeriod);
      const dashOn = unitFromHash(addNoiseHash(dashPhase, Math.floor(y / (strokeGrain * 2)), 707)) > -0.2;
      threshold = dashOn ? bandThreshold : 1;
    }
    const shade = luma > threshold ? 255 : 0;
    output[i] = shade; output[i + 1] = shade; output[i + 2] = shade; output[i + 3] = source[i + 3]!;
  }
  return output;
}

/** Shape Mosaic: each grid cell is filled with a chosen *shape*
 * (Square/Circle/Star) drawn in the cell's own average colour against a
 * plain backdrop, instead of a flat square tile — the reference panel's own
 * three-shape choice, distinct from the plain square Pixelate already has.
 * Monochrome desaturates each tile's colour to its own luminance; Invert
 * flips every output channel (backdrop included), the panel's own two
 * checkboxes. The star boundary is the textbook polar-line formula (law of
 * sines between the alternating outer/inner vertices of a 5-point star) —
 * plain geometry, not an invented curve. */
function shapeMosaicFilter(source: Uint8ClampedArray, width: number, height: number, cellSize: number, shape: number, monochrome: boolean, invert: boolean): Uint8ClampedArray {
  const backdrop = invert ? 0 : 255;
  const output = new Uint8ClampedArray(source.length).fill(backdrop);
  for (let i = 3; i < output.length; i += 4) output[i] = 255;
  const size = Math.max(4, Math.round(cellSize)), inscribed = size / 2;
  const starPoints = 5, starStep = Math.PI / starPoints, outerR = 1, innerR = 0.45;
  const starBound = (theta: number) => {
    const a = ((theta % starStep) + starStep) % starStep;
    return (outerR * innerR * Math.sin(starStep)) / (innerR * Math.sin(starStep - a) + outerR * Math.sin(a));
  };
  for (let cellY = 0; cellY < height; cellY += size) for (let cellX = 0; cellX < width; cellX += size) {
    const right = Math.min(width, cellX + size), bottom = Math.min(height, cellY + size);
    const sum = [0, 0, 0, 0, 0];
    for (let y = cellY; y < bottom; y += 1) for (let x = cellX; x < right; x += 1) {
      const i = (y * width + x) * 4;
      sum[0] = sum[0]! + source[i]!; sum[1] = sum[1]! + source[i + 1]!; sum[2] = sum[2]! + source[i + 2]!; sum[3] = sum[3]! + source[i + 3]!; sum[4] = sum[4]! + 1;
    }
    if (sum[4]! === 0) continue;
    let r = sum[0]! / sum[4]!, g = sum[1]! / sum[4]!, b = sum[2]! / sum[4]!;
    const a = sum[3]! / sum[4]!;
    if (monochrome) r = g = b = (r * 30 + g * 59 + b * 11) / 100;
    if (invert) { r = 255 - r; g = 255 - g; b = 255 - b; }
    const cx = cellX + (right - cellX) / 2, cy = cellY + (bottom - cellY) / 2;
    for (let y = cellY; y < bottom; y += 1) for (let x = cellX; x < right; x += 1) {
      const dxN = (x + 0.5 - cx) / inscribed, dyN = (y + 0.5 - cy) / inscribed, dist = Math.hypot(dxN, dyN);
      const inside = shape === 0 ? true : shape === 1 ? dist <= 1 : dist <= starBound(Math.atan2(dyN, dxN));
      if (!inside) continue;
      const i = (y * width + x) * 4;
      output[i] = byte(r); output[i + 1] = byte(g); output[i + 2] = byte(b); output[i + 3] = byte(a);
    }
  }
  return output;
}

/** Difference Clouds: the same procedural cloud noise `cloudsFilter`
 * already renders, composited with Photoshop's own Difference blend
 * (`|source - cloud|`) instead of a plain mix — a genuinely different
 * result from Clouds, not the same generator applied twice. */
function differenceCloudsFilter(source: Uint8ClampedArray, width: number, height: number): Uint8ClampedArray {
  const clouded = cloudsFilter(source, width, height, 1), output = new Uint8ClampedArray(source.length);
  for (let i = 0; i < source.length; i += 4) {
    output[i] = byte(Math.abs(source[i]! - clouded[i]!)); output[i + 1] = byte(Math.abs(source[i + 1]! - clouded[i + 1]!)); output[i + 2] = byte(Math.abs(source[i + 2]! - clouded[i + 2]!));
    output[i + 3] = source[i + 3]!;
  }
  return output;
}

/** Fibers: vertically-stretched value noise (the same octave-summed sine
 * lattice `cloudsFilter` uses, stretched along one axis) shaded between the
 * document's own current foreground/background-like extremes — this
 * engine has no live foreground/background colour input into the filter
 * pipeline, so it renders in greyscale, the same simplification `clouds`
 * already makes for colour. `variance` controls the noise frequency,
 * `strength` its contrast. */
function fibersFilter(width: number, height: number, variance: number, strength: number): Uint8ClampedArray {
  const output = new Uint8ClampedArray(width * height * 4);
  const freq = 0.02 + (variance / 100) * 0.2, contrast = strength / 100;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    let sum = 0, amp = 1, total = 0, fx = freq;
    for (let o = 0; o < 4; o += 1) { sum += amp * Math.sin(x * fx + Math.sin(y * 0.05 + o) * 3); total += amp; amp *= 0.5; fx *= 2; }
    const value = (sum / total + 1) / 2, shaded = byte(128 + (value - 0.5) * 255 * (0.4 + contrast * 0.6));
    const i = (y * width + x) * 4;
    output[i] = shaded; output[i + 1] = shaded; output[i + 2] = shaded; output[i + 3] = 255;
  }
  return output;
}

/**
 * Normal Map — GEGL's `gegl:normal-map` (operations/common/normal-map.c):
 * treats luminance as a height field, takes its central-difference gradient,
 * builds the surface normal `(-dHeight/dx * scale, -dHeight/dy * scale, 1)`,
 * normalises it, and encodes it into RGB the standard tangent-space way
 * (X→R, Y→G, Z→B, each mapped from [-1, 1] to [0, 1]) — the donor's own
 * default component assignment and half-range Z encoding (`full_z = false`).
 */
// The reference panel's own Blur/Invert/High/Medium/Low: Blur pre-smooths the height field before
// the gradient is taken (softer, less jittery normals off noisy source pixels); Invert flips which
// side of an edge reads as "up"; High/Medium/Low are a three-octave detail mix — the gradient is
// sampled at three step sizes (fine/mid/coarse) and blended by each slider's own weight, the same
// multi-scale-detail idea texture-baking tools (Substance, CrazyBump) expose under this name,
// rather than one single fixed-radius gradient the old Scale-only version always used.
function normalMapFilter(source: Uint8ClampedArray, width: number, height: number, blurRadius: number, scale: number, invert: boolean, highPercent: number, mediumPercent: number, lowPercent: number): Uint8ClampedArray {
  const output = new Uint8ClampedArray(source.length);
  const heightSource = blurRadius > 0 ? blur(source, width, height, blurRadius) : source;
  const clampX = (x: number) => Math.max(0, Math.min(width - 1, x)), clampY = (y: number) => Math.max(0, Math.min(height - 1, y));
  const sign = invert ? -1 : 1;
  const heightAt = (x: number, y: number) => { const i = (clampY(y) * width + clampX(x)) * 4; return sign * (heightSource[i]! * 30 + heightSource[i + 1]! * 59 + heightSource[i + 2]! * 11) / 100 / 255; };
  const bands: [number, number][] = [[1, highPercent / 100], [4, mediumPercent / 100], [10, lowPercent / 100]];
  const totalWeight = bands.reduce((sum, [, w]) => sum + w, 0) || 1;
  const s = scale / 2;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    let gradX = 0, gradY = 0;
    for (const [step, weight] of bands) {
      if (weight <= 0) continue;
      gradX += weight * (heightAt(x + step, y) - heightAt(x - step, y)) / (2 * step);
      gradY += weight * (heightAt(x, y + step) - heightAt(x, y - step)) / (2 * step);
    }
    const dx = (gradX / totalWeight) * s, dy = (gradY / totalWeight) * s;
    const nx = -dx, ny = -dy, nz = 1, length = Math.hypot(nx, ny, nz) || 1;
    const i = (y * width + x) * 4;
    output[i] = byte(((nx / length) * 0.5 + 0.5) * 255);
    output[i + 1] = byte(((ny / length) * 0.5 + 0.5) * 255);
    output[i + 2] = byte(((nz / length) * 0.5 + 0.5) * 255);
    output[i + 3] = source[i + 3]!;
  }
  return output;
}

/**
 * The Blur Gallery (docs/master-plan.md §51's interactivity level 3): unlike
 * the plain-dialog filters above, Field/Iris/Tilt-Shift/Spin Blur are driven
 * by a pin the user places and drags directly on the canvas, so they are not
 * routed through `applyRasterFilter`'s settings-object dispatch — they are
 * called directly by `BlurGalleryDialog.tsx`, the same way `LiquifyDialog.tsx`
 * calls the exported `liquify*` functions in `liquify.ts` rather than going
 * through a filter id.
 *
 * Photoshop's own fast path for a spatially-varying blur is exactly this:
 * blur the whole image once at the pin's full radius, then blend it back
 * toward the untouched source using a mask shaped by distance from the pin
 * (an ellipse for Iris, a band for Tilt-Shift) — not a true per-pixel
 * variable-radius convolution, which is what makes it fast enough for a
 * live drag. Field Blur has no shape at all with a single pin — one pin's
 * blur applies uniformly, exactly `gaussianBlur` itself.
 */
export function fieldBlurEffect(source: Uint8ClampedArray, width: number, height: number, radius: number): Uint8ClampedArray {
  return gaussianBlur(source, width, height, radius);
}

/** Iris Blur: sharp inside `innerRadius`, fully blurred outside
 * `outerRadius`, smoothly feathered (smoothstep) in between — an elliptical
 * falloff around `(centerX, centerY)`, matching the draggable inner/outer
 * rings Photoshop's own Iris Blur pin shows. */
export function irisBlurEffect(source: Uint8ClampedArray, width: number, height: number, centerX: number, centerY: number, innerRadius: number, outerRadius: number, blurRadius: number): Uint8ClampedArray {
  const blurred = gaussianBlur(source, width, height, blurRadius), output = new Uint8ClampedArray(source.length);
  const inner = Math.max(0, innerRadius), outer = Math.max(inner + 1, outerRadius);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const distance = Math.hypot(x - centerX, y - centerY);
    const t = Math.max(0, Math.min(1, (distance - inner) / (outer - inner))), smooth = t * t * (3 - 2 * t);
    const i = (y * width + x) * 4;
    for (let c = 0; c < 4; c += 1) output[i + c] = byte(source[i + c]! + (blurred[i + c]! - source[i + c]!) * smooth);
  }
  return output;
}

/** Tilt-Shift: sharp within `focusDistance` of the pin's centre line
 * (at `angle`, through `(centerX, centerY)`), fully blurred past
 * `focusDistance + featherDistance` on either side. */
export function tiltShiftBlurEffect(source: Uint8ClampedArray, width: number, height: number, centerX: number, centerY: number, angleDeg: number, focusDistance: number, featherDistance: number, blurRadius: number): Uint8ClampedArray {
  const blurred = gaussianBlur(source, width, height, blurRadius), output = new Uint8ClampedArray(source.length);
  const angle = angleDeg * Math.PI / 180, normalX = -Math.sin(angle), normalY = Math.cos(angle), feather = Math.max(1, featherDistance);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const distance = Math.abs((x - centerX) * normalX + (y - centerY) * normalY);
    const t = Math.max(0, Math.min(1, (distance - focusDistance) / feather)), smooth = t * t * (3 - 2 * t);
    const i = (y * width + x) * 4;
    for (let c = 0; c < 4; c += 1) output[i + c] = byte(source[i + c]! + (blurred[i + c]! - source[i + c]!) * smooth);
  }
  return output;
}

/** Spin Blur: `radialBlurFilter`'s own Spin algorithm, parameterised by an
 * arbitrary pin centre instead of the fixed image centre `radial_blur`
 * itself uses. */
export function spinBlurEffect(source: Uint8ClampedArray, width: number, height: number, centerX: number, centerY: number, amountPercent: number): Uint8ClampedArray {
  const output = new Uint8ClampedArray(source.length), angle = Math.max(0, Math.min(100, amountPercent)) / 100 * Math.PI / 6;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const dx = x - centerX, dy = y - centerY, r = Math.hypot(dx, dy);
    const steps = Math.max(3, Math.min(64, Math.ceil(r * angle * 1.41)));
    const phiBase = Math.atan2(dy, dx), phiStart = phiBase + angle / 2, phiStep = angle / steps;
    const sum = [0, 0, 0, 0];
    for (let step = 0; step < steps; step += 1) {
      const phi = phiStart - step * phiStep;
      const [sr, sg, sb, sa] = sampleBilinear(source, width, height, centerX + r * Math.cos(phi), centerY + r * Math.sin(phi));
      sum[0] = sum[0]! + sr; sum[1] = sum[1]! + sg; sum[2] = sum[2]! + sb; sum[3] = sum[3]! + sa;
    }
    const i = (y * width + x) * 4;
    for (let c = 0; c < 4; c += 1) output[i + c] = byte(sum[c]! / steps);
  }
  return output;
}

/**
 * Displace — Photoshop's own classic algorithm: a second image's luminance
 * drives per-pixel offset, `(luminance - 128) / 128 * scale` on each axis
 * independently (middle grey is zero displacement, white/black push to
 * either extreme of `scale`), sampled bilinearly. `displacementMap` must
 * already be the same size as `source` — resizing or tiling a differently-
 * sized map to fit is `DisplaceDialog.tsx`'s job (the dialog's own
 * Stretch/Tile choice), not this function's, the same separation
 * `BlurGalleryDialog.tsx` keeps between its own canvas math and the
 * exported effect functions it calls. Like those, this is not routed
 * through `applyRasterFilter`: a second full-resolution image cannot be a
 * plain settings-object value.
 */
export function displaceEffect(source: Uint8ClampedArray, width: number, height: number, displacementMap: Uint8ClampedArray, horizontalScale: number, verticalScale: number, wrap: boolean): Uint8ClampedArray {
  const output = new Uint8ClampedArray(source.length);
  const wrapCoord = (value: number, size: number) => ((value % size) + size) % size;
  const clampCoord = (value: number, size: number) => Math.max(0, Math.min(size - 1, value));
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const mapIndex = (y * width + x) * 4;
    const luminance = (displacementMap[mapIndex]! * 30 + displacementMap[mapIndex + 1]! * 59 + displacementMap[mapIndex + 2]! * 11) / 100;
    const dx = ((luminance - 128) / 128) * horizontalScale, dy = ((luminance - 128) / 128) * verticalScale;
    let srcX = x + dx, srcY = y + dy;
    srcX = wrap ? wrapCoord(srcX, width) : clampCoord(srcX, width);
    srcY = wrap ? wrapCoord(srcY, height) : clampCoord(srcY, height);
    const [r, g, b, a] = sampleBilinear(source, width, height, srcX, srcY), i = (y * width + x) * 4;
    output[i] = r; output[i + 1] = g; output[i + 2] = b; output[i + 3] = a;
  }
  return output;
}

/**
 * Lens Correction (Custom tab only — see docs/master-plan.md §51 for why):
 * the geometric warp is GIMP/GEGL's own Lens Distortion plugin
 * (`operations/common-gpl3+/lens-distortion.c`, `main`/`zoom` properties,
 * `edge`/shift left at their defaults), the exact donor Photoshop's own
 * "Remove Distortion" slider traces back to. Chromatic aberration samples
 * the red and blue channels through the same warp at a slightly different
 * `main` each (the classic simulated-CA technique: real axial CA is a lens
 * property, not a single extra parameter, but scaling the red/blue radius
 * oppositely reproduces the visible fringing this dialog's slider is for).
 * Vignette reuses `applyRasterFilter`'s own `vignette` falloff formula.
 */
function lensCorrectionFilter(source: Uint8ClampedArray, width: number, height: number, distortAmount: number, scalePercent: number): Uint8ClampedArray {
  const output = new Uint8ClampedArray(source.length);
  const norm = 4 / (width * width + height * height), centerX = width / 2, centerY = height / 2;
  // Scale is the reference panel's own compensating zoom, applied after distortion the same way
  // Photoshop's own Scale slider fills the gutter a positive Remove Distortion pulls in from the
  // edges (or crops the bulge a negative one pushes out) — not a decorative second knob.
  const rescale = 100 / Math.max(1, scalePercent), mainAmount = distortAmount / 200;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const offX = x - centerX, offY = y - centerY, radiusSq = (offX * offX + offY * offY) * norm;
    const radiusMult = rescale * (1 + radiusSq * mainAmount);
    const [rr, gg, bb, aa] = sampleBilinear(source, width, height, centerX + radiusMult * offX, centerY + radiusMult * offY);
    const i = (y * width + x) * 4;
    output[i] = rr; output[i + 1] = gg; output[i + 2] = bb; output[i + 3] = aa;
  }
  return output;
}

/** Standard HSB(HSV)/HSL → RGB, the textbook inverse of the hue/sat/value math
 * `hsbHslFilter` below already computes forward — needed so an "Input: HSB/HSL"
 * pass can decode channels a prior HSB/HSL pass encoded, not just read RGB. */
function hsxToRgb(hueDeg: number, s: number, v: number, isHsl: boolean): [number, number, number] {
  const c = isHsl ? (1 - Math.abs(2 * v - 1)) * s : v * s;
  const hp = ((hueDeg % 360) + 360) % 360 / 60, x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] = hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = isHsl ? v - c / 2 : v - c;
  return [r1 + m, g1 + m, b1 + m];
}

/**
 * HSB/HSL — Photoshop's own "Other" filter that repurposes the RGB
 * channels to carry Hue/Saturation/Brightness (or Lightness) instead:
 * R←hue, G←saturation, B←value(HSB)/lightness(HSL). The reference panel adds
 * an Input choice alongside Output: with Input left at RGB this is exactly
 * the original one-way encode; with Input set to HSB/HSL, the incoming
 * channels are first decoded back to real colour (via `hsxToRgb`) before
 * being re-encoded, the same round-trip Adobe's own docs describe for
 * recovering an image a prior HSB/HSL pass encoded.
 */
function hsbHslFilter(source: Uint8ClampedArray, inputMode: number, outputMode: number): Uint8ClampedArray {
  const output = new Uint8ClampedArray(source.length);
  for (let i = 0; i < source.length; i += 4) {
    let r = source[i]! / 255, g = source[i + 1]! / 255, b = source[i + 2]! / 255;
    if (inputMode !== 0) [r, g, b] = hsxToRgb(r * 360, g, b, inputMode === 2);
    if (outputMode === 0) { output[i] = byte(r * 255); output[i + 1] = byte(g * 255); output[i + 2] = byte(b * 255); output[i + 3] = source[i + 3]!; continue; }
    const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
    let hue = 0;
    if (delta > 0) {
      if (max === r) hue = ((g - b) / delta) % 6;
      else if (max === g) hue = (b - r) / delta + 2;
      else hue = (r - g) / delta + 4;
      hue *= 60; if (hue < 0) hue += 360;
    }
    const lightness = (max + min) / 2;
    const saturationHsl = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
    const saturationHsb = max === 0 ? 0 : delta / max;
    output[i] = byte((hue / 360) * 255);
    output[i + 1] = byte((outputMode === 2 ? saturationHsl : saturationHsb) * 255);
    output[i + 2] = byte((outputMode === 2 ? lightness : max) * 255);
    output[i + 3] = source[i + 3]!;
  }
  return output;
}

/**
 * Texture Dilation — not a native Photoshop filter (confirmed against
 * Photoshop's real 3D-panel documentation; docs/master-plan.md §51), but a
 * real, well-known technique from game-texture baking (Substance Painter,
 * GIMP's UVPadder): iteratively extends each opaque pixel's colour one step
 * into its transparent neighbours, `distance` times, so a texture atlas's
 * UV-island edges don't fringe black when a renderer's mipmapping or
 * bilinear filtering samples slightly outside them. Alpha itself is left
 * untouched — only the RGB a transparent pixel *would* show if sampled is
 * corrected — kept here as the same kind of honest bonus addition as
 * Kaleidoscope: real and useful, just not from Photoshop's own menu.
 */
function textureDilationFilter(source: Uint8ClampedArray, width: number, height: number, distance: number, crop: number): Uint8ClampedArray {
  let current = source.slice();
  let filled = new Uint8Array(width * height);
  for (let p = 0; p < width * height; p += 1) if (source[p * 4 + 3]! >= 10) filled[p] = 1;
  const offsets = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]];
  // Crop insets the trusted-colour region by this many pixels before growing it back out — the
  // reference panel's own trim-then-extrude pair, useful for shaving off halo-prone pixels right
  // at a UV-island seam before the dilation pass re-fills past them.
  for (let pass = 0; pass < Math.max(0, Math.round(crop)); pass += 1) {
    const eroded = filled.slice();
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
      const p = y * width + x;
      if (!filled[p]) continue;
      for (const [dx, dy] of offsets) {
        const nx = x + dx!, ny = y + dy!;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height || !filled[ny * width + nx]) { eroded[p] = 0; break; }
      }
    }
    filled = eroded;
  }
  for (let pass = 0; pass < Math.max(1, Math.round(distance)); pass += 1) {
    const next = current.slice(), nextFilled = filled.slice();
    let grew = false;
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
      const p = y * width + x;
      if (filled[p]) continue;
      const sum = [0, 0, 0], count = { value: 0 };
      for (const [dx, dy] of offsets) {
        const nx = x + dx!, ny = y + dy!;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const np = ny * width + nx;
        if (!filled[np]) continue;
        const ni = np * 4;
        sum[0] = sum[0]! + current[ni]!; sum[1] = sum[1]! + current[ni + 1]!; sum[2] = sum[2]! + current[ni + 2]!; count.value += 1;
      }
      if (count.value > 0) {
        const i = p * 4;
        next[i] = byte(sum[0]! / count.value); next[i + 1] = byte(sum[1]! / count.value); next[i + 2] = byte(sum[2]! / count.value);
        nextFilled[p] = 1; grew = true;
      }
    }
    current = next; filled = nextFilled;
    if (!grew) break;
  }
  const output = current;
  for (let i = 3; i < output.length; i += 4) output[i] = source[i]!;
  return output;
}

/**
 * Path Blur — the last Blur Gallery member, added once `BlurGalleryDialog.tsx`
 * grew a path tool (docs/master-plan.md §51): unlike the fixed-shape masks
 * Field/Iris/Tilt-Shift use, this one needs the actual path geometry, so it
 * takes the point list directly rather than a simple centre/radius.
 *
 * For each pixel, finds its nearest point on the polyline (checking every
 * segment — the path is short, a handful of user-placed points, so this
 * stays cheap) and that segment's own tangent direction, then runs a short
 * motion-blur along that tangent (the same sampling `motionBlurFilter`
 * already does, just per-pixel-directed instead of one fixed angle for the
 * whole image), blended toward the sharp source by a smoothstep of distance
 * from the path — the same "blur once, mask back toward sharp" trick
 * Iris/Tilt-Shift use, just with the path's own distance field for a mask
 * instead of an ellipse or a band.
 */
export function pathBlurEffect(source: Uint8ClampedArray, width: number, height: number, path: readonly { x: number; y: number }[], speed: number, blurWidth: number): Uint8ClampedArray {
  const output = new Uint8ClampedArray(source.length);
  if (path.length < 2) return source.slice();
  const segments = path.slice(1).map((point, index) => {
    const start = path[index]!, dx = point.x - start.x, dy = point.y - start.y, length = Math.hypot(dx, dy) || 1e-6;
    return { start, end: point, ux: dx / length, uy: dy / length, length };
  });
  const nearest = (x: number, y: number) => {
    let best = { distance: Infinity, ux: 1, uy: 0 };
    for (const segment of segments) {
      const relX = x - segment.start.x, relY = y - segment.start.y;
      const t = Math.max(0, Math.min(segment.length, relX * segment.ux + relY * segment.uy));
      const closestX = segment.start.x + segment.ux * t, closestY = segment.start.y + segment.uy * t;
      const distance = Math.hypot(x - closestX, y - closestY);
      if (distance < best.distance) best = { distance, ux: segment.ux, uy: segment.uy };
    }
    return best;
  };
  const half = Math.max(1, speed / 2), steps = Math.max(3, Math.ceil(speed) + 1), feather = Math.max(1, blurWidth);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const { distance, ux, uy } = nearest(x, y);
    const t = Math.max(0, Math.min(1, distance / feather)), mask = 1 - t * t * (3 - 2 * t);
    const i = (y * width + x) * 4;
    if (mask <= 0) { output[i] = source[i]!; output[i + 1] = source[i + 1]!; output[i + 2] = source[i + 2]!; output[i + 3] = source[i + 3]!; continue; }
    const sum = [0, 0, 0, 0];
    for (let step = 0; step < steps; step += 1) {
      const sampleT = (step / (steps - 1) - 0.5) * 2 * half;
      const [r, g, b, a] = sampleBilinear(source, width, height, x + ux * sampleT, y + uy * sampleT);
      sum[0] = sum[0]! + r; sum[1] = sum[1]! + g; sum[2] = sum[2]! + b; sum[3] = sum[3]! + a;
    }
    for (let c = 0; c < 4; c += 1) { const blurred = sum[c]! / steps; output[i + c] = byte(source[i + c]! + (blurred - source[i + c]!) * mask); }
  }
  return output;
}

/**
 * Particles — a generative snow/dust overlay, docs/master-plan.md §51: neither Patchy nor
 * Photoshop have a filter by this name, so it is built directly from the reference panel's own
 * ten controls, on the project's own deterministic `addNoiseHash`/`unitFromHash` (the same
 * reproducible-noise convention `clouds`/`add_noise` already use) rather than `Math.random()`, so
 * the same settings always render the same frame. Each particle's screen position comes from a
 * hashed base point plus a Fall-driven vertical drift and a Turbulence-driven horizontal sway
 * (both animated by Time); Depth spreads per-particle size around the base Size instead of every
 * particle being identical; Blink hides a hashed fraction of particles per Time step; Randomize
 * reseeds the whole hash without touching any other control.
 */
function particlesFilter(source: Uint8ClampedArray, width: number, height: number, amount: number, size: number, depth: number, brightnessPercent: number, colorPacked: number, time: number, turbulence: number, blinkPercent: number, fallPercent: number, randomize: number): Uint8ClampedArray {
  const output = source.slice();
  const count = Math.max(0, Math.round(amount)), colorR = (colorPacked >> 16) & 255, colorG = (colorPacked >> 8) & 255, colorB = colorPacked & 255;
  const brightness = Math.max(0, Math.min(1, brightnessPercent / 100));
  for (let particle = 0; particle < count; particle += 1) {
    const baseX = unitFromHash(addNoiseHash(particle, randomize, 501)) * 0.5 + 0.5, baseY = unitFromHash(addNoiseHash(particle, randomize, 502)) * 0.5 + 0.5;
    const sizeScale = 1 + (unitFromHash(addNoiseHash(particle, randomize, 503)) * 0.5) * (depth / 100);
    const sway = Math.sin(time * 0.05 + particle) * (turbulence / 100) * (width * 0.05);
    const fallOffset = ((time * (fallPercent / 100) * height * 0.3) + baseY * height) % (height + size * 4) - size * 2;
    if (blinkPercent > 0 && unitFromHash(addNoiseHash(particle, Math.floor(time), 504)) * 0.5 + 0.5 < blinkPercent / 100) continue;
    const centerX = baseX * width + sway, centerY = fallOffset, radius = Math.max(0.5, size * sizeScale);
    const left = Math.max(0, Math.floor(centerX - radius)), right = Math.min(width - 1, Math.ceil(centerX + radius));
    const top = Math.max(0, Math.floor(centerY - radius)), bottom = Math.min(height - 1, Math.ceil(centerY + radius));
    for (let y = top; y <= bottom; y += 1) for (let x = left; x <= right; x += 1) {
      const distance = Math.hypot(x - centerX, y - centerY);
      if (distance > radius) continue;
      const coverage = (1 - distance / radius) * brightness, i = (y * width + x) * 4;
      output[i] = byte(output[i]! + (colorR - output[i]!) * coverage);
      output[i + 1] = byte(output[i + 1]! + (colorG - output[i + 1]!) * coverage);
      output[i + 2] = byte(output[i + 2]! + (colorB - output[i + 2]!) * coverage);
      output[i + 3] = byte(Math.max(output[i + 3]!, coverage * 255));
    }
  }
  return output;
}

/**
 * Repeat/Tile — docs/master-plan.md §51, another owner-drawn panel with no Patchy/Photoshop
 * source: scales the whole source down into a single tile, repeats it across the canvas with each
 * row of tiles shifted horizontally by Row Shift (the classic brick/masonry offset), leaves a
 * Space X/Y gap between tiles, and can rotate the whole grid by Angle before sampling. Auto Color
 * Correct stretches each channel's own min–max range across the whole tiled result out to 0–255
 * (a plain auto-contrast, the same idea `auto_contrast` elsewhere in this file already applies to
 * a whole image) — matching mean *brightness* back to the untouched source was tried first, but
 * every tile here resamples the same whole source, so the tiled result's own mean is already
 * within rounding of the source's regardless of Row Shift/gaps and the "correction" was a no-op in
 * practice; a genuine contrast stretch has a real, visible effect whenever the source does not
 * already span the full range, which is the normal case.
 */
function repeatFilter(source: Uint8ClampedArray, width: number, height: number, scalePercent: number, rowShiftPercent: number, spaceX: number, spaceY: number, autoColorCorrect: boolean, angleDeg: number): Uint8ClampedArray {
  const tileW = Math.max(2, Math.round((width * scalePercent) / 100)), tileH = Math.max(2, Math.round((height * scalePercent) / 100));
  const cellW = tileW + spaceX, cellH = tileH + spaceY;
  const angle = (-angleDeg * Math.PI) / 180, cos = Math.cos(angle), sin = Math.sin(angle), cx = width / 2, cy = height / 2;
  const output = new Uint8ClampedArray(source.length);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const dx = x - cx, dy = y - cy, rx = dx * cos - dy * sin + cx, ry = dx * sin + dy * cos + cy;
    const row = Math.floor(ry / cellH);
    const shiftX = ((row * rowShiftPercent) / 100) * tileW;
    const localX = (((rx - shiftX) % cellW) + cellW) % cellW, localY = ((ry % cellH) + cellH) % cellH;
    const i = (y * width + x) * 4;
    if (localX >= tileW || localY >= tileH) { output[i] = 0; output[i + 1] = 0; output[i + 2] = 0; output[i + 3] = 0; continue; }
    const [r, g, b, a] = sampleBilinear(source, width, height, (localX / tileW) * width, (localY / tileH) * height);
    output[i] = r; output[i + 1] = g; output[i + 2] = b; output[i + 3] = a;
  }
  if (!autoColorCorrect) return output;
  for (let c = 0; c < 3; c += 1) {
    let lo = 255, hi = 0;
    for (let i = c; i < output.length; i += 4) if (output[i + 3 - c]! !== 0) { lo = Math.min(lo, output[i]!); hi = Math.max(hi, output[i]!); }
    if (hi <= lo) continue;
    for (let i = c; i < output.length; i += 4) output[i] = byte(((output[i]! - lo) * 255) / (hi - lo));
  }
  return output;
}

/**
 * Color to Transparency — GIMP's own `plug-in-colortoalpha` formula (`app/operations/gimpoperationcolortoalpha.c`;
 * per-channel "how much alpha would this pixel need so blending it back over the target colour
 * reproduces the original", then un-premultiplied against that alpha so the surviving colour still
 * reads correctly composited over anything else), not an invented distance-to-colour test. GIMP's
 * own dialog has no threshold at all — a hard cutoff at alpha=0; this reference panel's own two
 * Threshold sliders soften that into a deadzone (below Threshold 1, stays fully opaque) and a
 * ramp up to full strength (at Threshold 2), smoothstep-blended between them, so both sliders
 * genuinely do something instead of the second one silently duplicating the first.
 */
function colorToTransparencyFilter(source: Uint8ClampedArray, width: number, height: number, colorPacked: number, threshold1Percent: number, threshold2Percent: number): Uint8ClampedArray {
  const output = new Uint8ClampedArray(source.length);
  const targetR = (colorPacked >> 16) & 255, targetG = (colorPacked >> 8) & 255, targetB = colorPacked & 255;
  const channelAlpha = (value: number, target: number) => {
    if (value > target) return target >= 255 ? 0 : (value - target) / (255 - target);
    if (value < target) return target <= 0 ? 0 : (target - value) / target;
    return 0;
  };
  const t1 = Math.min(threshold1Percent, threshold2Percent) / 100, t2 = Math.max(threshold1Percent, threshold2Percent, threshold1Percent + 1) / 100;
  for (let i = 0; i < source.length; i += 4) {
    const r = source[i]!, g = source[i + 1]!, b = source[i + 2]!;
    const alpha = Math.max(channelAlpha(r, targetR), channelAlpha(g, targetG), channelAlpha(b, targetB));
    const span = Math.max(1e-6, t2 - t1), edge = Math.max(0, Math.min(1, (alpha - t1) / span)), smoothed = edge * edge * (3 - 2 * edge);
    if (smoothed > 1e-4) {
      output[i] = byte((r - targetR) / smoothed + targetR);
      output[i + 1] = byte((g - targetG) / smoothed + targetG);
      output[i + 2] = byte((b - targetB) / smoothed + targetB);
    } else { output[i] = targetR; output[i + 1] = targetG; output[i + 2] = targetB; }
    output[i + 3] = byte(smoothed * source[i + 3]!);
  }
  return output;
}

const BAYER_4X4 = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];
const quantizeLevels = (value: number, levels: number) => levels <= 1 ? 0 : Math.round((Math.max(0, Math.min(255, value)) / 255) * (levels - 1)) * (255 / (levels - 1));

/** Ordered dithering: the textbook 4×4 Bayer matrix (Bayer, 1973), the same public-domain
 * technique `eInkFilter`/`mezzotintFilter` already use elsewhere in this file for their own
 * ordered-dither cases, generalised to an arbitrary level count. */
function ditherBayer(value: number, levels: number, x: number, y: number): number {
  const step = levels <= 1 ? 0 : 255 / (levels - 1), threshold = (BAYER_4X4[y % 4]![x % 4]! + 0.5) / 16 - 0.5;
  return quantizeLevels(value + threshold * step, levels);
}

/** Floyd-Steinberg error diffusion (Floyd & Steinberg, 1976) — the classic raster-scan algorithm,
 * one independent pass per channel (or the single luminance channel for Black & White/Grayscale). */
function ditherFloydSteinberg(channel: Float32Array, width: number, height: number, levels: number): Uint8ClampedArray {
  const buffer = Float32Array.from(channel), out = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const p = y * width + x, old = buffer[p]!, quantized = quantizeLevels(old, levels), error = old - quantized;
    out[p] = quantized;
    if (x + 1 < width) buffer[p + 1] = buffer[p + 1]! + (error * 7) / 16;
    if (y + 1 < height) {
      if (x > 0) buffer[p + width - 1] = buffer[p + width - 1]! + (error * 3) / 16;
      buffer[p + width] = buffer[p + width]! + (error * 5) / 16;
      if (x + 1 < width) buffer[p + width + 1] = buffer[p + width + 1]! + (error * 1) / 16;
    }
  }
  return out;
}

/**
 * Discretization/Dither — palette-reduction plus dithering, the same operation every editor's own
 * Indexed/Bitmap conversion performs: Black & White and Grayscale quantize the source's own
 * luminance to 2 or 4 levels and paint every channel from that one value; RGB quantizes each
 * channel independently to 6 levels. Method picks flat quantization (None), Floyd-Steinberg error
 * diffusion, or ordered Bayer 4×4 dithering — both are real, standard algorithms (see the two
 * helpers above), not approximations of them.
 */
function discretizationFilter(source: Uint8ClampedArray, width: number, height: number, palette: number, method: number): Uint8ClampedArray {
  const output = new Uint8ClampedArray(source.length);
  const levels = palette === 0 ? 2 : palette === 1 ? 4 : 6;
  if (palette === 2) {
    const channels: Uint8ClampedArray[] = [0, 1, 2].map((c) => {
      if (method === 1) { const plane = new Float32Array(width * height); for (let p = 0; p < width * height; p += 1) plane[p] = source[p * 4 + c]!; return ditherFloydSteinberg(plane, width, height, levels); }
      const plane = new Uint8ClampedArray(width * height);
      for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) { const p = y * width + x, value = source[p * 4 + c]!; plane[p] = method === 2 ? ditherBayer(value, levels, x, y) : quantizeLevels(value, levels); }
      return plane;
    });
    for (let p = 0; p < width * height; p += 1) { const i = p * 4; output[i] = channels[0]![p]!; output[i + 1] = channels[1]![p]!; output[i + 2] = channels[2]![p]!; output[i + 3] = source[i + 3]!; }
    return output;
  }
  const luma = new Float32Array(width * height);
  for (let p = 0; p < width * height; p += 1) { const i = p * 4; luma[p] = (source[i]! * 30 + source[i + 1]! * 59 + source[i + 2]! * 11) / 100; }
  const quantizedLuma = method === 1 ? ditherFloydSteinberg(luma, width, height, levels) : null;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const p = y * width + x, i = p * 4;
    const shade = method === 1 ? quantizedLuma![p]! : method === 2 ? ditherBayer(luma[p]!, levels, x, y) : quantizeLevels(luma[p]!, levels);
    output[i] = shade; output[i + 1] = shade; output[i + 2] = shade; output[i + 3] = source[i + 3]!;
  }
  return output;
}

export function applyRasterFilter(source: Uint8ClampedArray, width: number, height: number, id: string, settings: Record<string, number> = {}): Uint8ClampedArray {
  const output = source.slice(), mix = Math.max(0,Math.min(1,value(settings,"amount",100)/100));
  if (id === "gaussian_blur") return gaussianBlur(source, width, height, value(settings, "radius", 2));
  if (id === "median") return medianBlur(source, width, height, value(settings, "radius", 1));
  if (id === "dust_and_scratches") return dustAndScratchesFilter(source, width, height, value(settings, "radius", 1), value(settings, "threshold", 0));
  if (id === "unsharp_mask") return unsharpFilter(source, width, height, value(settings, "radius", 2), value(settings, "amount", 150) / 100, value(settings, "threshold", 8));
  if (["box_blur","iris_blur","tilt_shift_blur"].includes(id)) return blur(source,width,height,value(settings,"radius",2));
  if (id === "motion_blur") return motionBlurFilter(source, width, height, value(settings, "distance", 20), value(settings, "angle", 0));
  if (id === "radial_blur") return radialBlurFilter(source, width, height, value(settings, "amount", 10), value(settings, "method", 0));
  if (id === "surface_blur") return surfaceBlurFilter(source, width, height, value(settings, "radius", 5), value(settings, "threshold", 15));
  if (id === "lens_blur") return lensBlurFilter(source, width, height, value(settings, "radius", 8));
  if (id === "average") return averageFilter(source, width, height);
  if (id === "blur") return blur(source, width, height, 1);
  if (id === "blur_more") return blur(source, width, height, 3);
  if (id === "polar_coordinates") return polarCoordinatesFilter(source, width, height, value(settings, "direction", 0) === 1);
  if (id === "shear") return shearFilter(source, width, height, [0, 1, 2, 3, 4].map((index) => value(settings, `point${index}`, 0)));
  if (id === "spherize") return spherizeFilter(source, width, height, value(settings, "amount", 50));
  if (id === "zigzag") return zigzagFilter(source, width, height, value(settings, "amount", 30));
  if (id === "ripple") return rippleFilter(source, width, height, value(settings, "amount", 100), value(settings, "size", 1));
  if (id === "kaleidoscope") return kaleidoscopeFilter(source, width, height, value(settings, "segments", 6), value(settings, "angle", 0));
  if (id === "offset") return offsetFilter(source, width, height, value(settings, "horizontal", 0), value(settings, "vertical", 0), value(settings, "undefinedArea", 0));
  if (id === "maximum") return morphologyFilter(source, width, height, value(settings, "radius", 1), true, value(settings, "shape", 0));
  if (id === "minimum") return morphologyFilter(source, width, height, value(settings, "radius", 1), false, value(settings, "shape", 0));
  if (id === "despeckle") return noiseReductionFilter(source, width, height, 1);
  if (id === "reduce_noise") return noiseReductionFilter(source, width, height, value(settings, "strength", 4));
  if (id === "sharpen_more") return unsharpFilter(source, width, height, 2, 3);
  if (id === "sharpen_edges") return sharpenEdgesFilter(source, width, height);
  if (id === "smart_sharpen") return unsharpFilter(source, width, height, value(settings, "radius", 2), value(settings, "amount", 150) / 100);
  if (id === "diffuse") return diffuseFilter(source, width, height, value(settings, "mode", 0));
  if (id === "solarize") { const solarized = source.slice(); for (let i = 0; i < solarized.length; i += 4) for (let c = 0; c < 3; c += 1) solarized[i + c] = solarized[i + c]! > 128 ? byte(255 - solarized[i + c]!) : solarized[i + c]!; return solarized; }
  if (id === "trace_contour") return traceContourFilter(source, width, height, value(settings, "level", 128), value(settings, "edge", 0));
  if (id === "wind") return windFilter(source, width, height, value(settings, "technique", 0), value(settings, "direction", 1));
  if (id === "oil_paint") return oilPaintFilter(source, width, height, value(settings, "brushSize", 4), value(settings, "stylization", 8));
  if (id === "lens_flare") return lensFlareFilter(source, width, height, value(settings, "brightness", 100), value(settings, "lensType", 0), value(settings, "positionX", 50), value(settings, "positionY", 50));
  if (id === "emboss") return embossFilter(source, width, height, value(settings, "angle", 135), value(settings, "height", 3), value(settings, "amount", 100));
  if (id === "crystallize") return crystallizeFilter(source, width, height, value(settings, "cellSize", 12));
  if (id === "pointillize") return pointillizeFilter(source, width, height, value(settings, "cellSize", 12));
  if (id === "fragment") return fragmentFilter(source, width, height, Math.round(value(settings, "amount", 4)));
  if (id === "mezzotint") return mezzotintFilter(source, width, height, Math.round(value(settings, "type", 0)));
  if (id === "shape_mosaic") return shapeMosaicFilter(source, width, height, value(settings, "cellSize", 20), value(settings, "shape", 0), value(settings, "monochrome", 0) === 1, value(settings, "invert", 0) === 1);
  if (id === "difference_clouds") return differenceCloudsFilter(source, width, height);
  if (id === "fibers") return fibersFilter(width, height, value(settings, "variance", 50), value(settings, "strength", 50));
  if (id === "normal_map") return normalMapFilter(source, width, height, value(settings, "blur", 0), value(settings, "scale", 10), value(settings, "invert", 0) === 1, value(settings, "high", 100), value(settings, "medium", 100), value(settings, "low", 100));
  if (id === "lens_correction") return lensCorrectionFilter(source, width, height, value(settings, "distortAmount", 0), value(settings, "scale", 100));
  if (id === "hsb_hsl") return hsbHslFilter(source, value(settings, "inputMode", 0), value(settings, "outputMode", 1));
  if (id === "texture_dilation") return textureDilationFilter(source, width, height, value(settings, "distance", 8), value(settings, "crop", 0));
  if (id === "particles") return particlesFilter(source, width, height, value(settings, "amount", 150), value(settings, "size", 3), value(settings, "depth", 40), value(settings, "brightness", 100), value(settings, "color", 0xffffff), value(settings, "time", 0), value(settings, "turbulence", 20), value(settings, "blink", 0), value(settings, "fall", 30), value(settings, "randomize", 0));
  if (id === "repeat") return repeatFilter(source, width, height, value(settings, "scale", 25), value(settings, "rowShift", 0), value(settings, "spaceX", 0), value(settings, "spaceY", 0), value(settings, "autoColorCorrect", 0) === 1, value(settings, "angle", 0));
  if (id === "color_to_transparency") return colorToTransparencyFilter(source, width, height, value(settings, "color", 0xffffff), value(settings, "threshold1", 0), value(settings, "threshold2", 100));
  if (id === "discretization") return discretizationFilter(source, width, height, value(settings, "palette", 1), value(settings, "method", 1));
  if(id==="pixelate"){const size=Math.max(2,Math.round(value(settings,"size",8)));for(let y=0;y<height;y+=size)for(let x=0;x<width;x+=size){const i=(y*width+x)*4;for(let yy=y;yy<Math.min(height,y+size);yy++)for(let xx=x;xx<Math.min(width,x+size);xx++){const o=(yy*width+xx)*4;output[o]=source[i]!;output[o+1]=source[i+1]!;output[o+2]=source[i+2]!;output[o+3]=source[i+3]!;}}return output;}
  if(id==="auto_tone"||id==="auto_contrast"||id==="auto_color"){for(let c=0;c<3;c++){let lo=255,hi=0;for(let i=c;i<source.length;i+=4)if(source[i+3-c]!==0){lo=Math.min(lo,source[i]!);hi=Math.max(hi,source[i]!);}if(hi>lo)for(let i=c;i<output.length;i+=4)output[i]=byte((source[i]!-lo)*255/(hi-lo));}return output;}
  if(id==="twirl") return twirlFilter(source,width,height,value(settings,"amount",100));
  if(id==="wave") return waveFilter(source,width,height,value(settings,"amount",100));
  if(id==="pinch_bloat") return pinchBloatFilter(source,width,height,value(settings,"amount",25));
  if(id==="duotone") return duotoneFilter(source,value(settings,"shadowHue",210),value(settings,"highlightHue",45),mix);
  if(id==="glitch") return glitchFilter(source,width,height,Math.round(value(settings,"shift",8)),value(settings,"scanline",45)/100,mix);
  if(id==="eink") return eInkFilter(source,width,value(settings,"levels",2),mix);
  if(id==="clouds") return cloudsFilter(source,width,height,mix);
  // Two filters, two behaviours: Add Noise is colour speckle, Analog Grain is
  // monochromatic and gaussian, the way grain actually looks. They used to run
  // the same three lines and were indistinguishable.
  if(id==="add_noise") return addNoiseFilter(source,width,height,value(settings,"amount",12),value(settings,"distribution",0)===1,value(settings,"monochromatic",0)===1);
  if(id==="film_grain") return addNoiseFilter(source,width,height,value(settings,"amount",12),true,true);
  if(id==="color_halftone") return colorHalftoneFilter(source,width,height,value(settings,"radius",8),value(settings,"angle1",10),value(settings,"angle2",40),value(settings,"angle3",70));
  // high_pass carries its own Radius parameter (the catalog declares it) —
  // it used to ignore that slider entirely and always blur at a hardcoded
  // radius of 2, the exact "checkbox that does nothing" CLAUDE.md warns
  // against (§3). soft_glow/unsharp_mask/sharpen keep the fixed radius
  // their single Amount-only dialog implies.
  const blurred = ["soft_glow","sharpen"].includes(id)?blur(source,width,height,2):id==="high_pass"?blur(source,width,height,value(settings,"radius",10)):null;
  for(let i=0;i<output.length;i+=4){const r=source[i]!,g=source[i+1]!,b=source[i+2]!,l=(r*30+g*59+b*11)/100;let nr=r,ng=g,nb=b;
    if(id==="invert"){nr=255-r;ng=255-g;nb=255-b;} else if(id==="grayscale"||id==="desaturate"){nr=ng=nb=l;} else if(id==="sepia"||id==="vintage_fade"){nr=byte(r*.393+g*.769+b*.189);ng=byte(r*.349+g*.686+b*.168);nb=byte(r*.272+g*.534+b*.131);} else if(id==="threshold"){nr=ng=nb=l>=value(settings,"threshold",128)?255:0;} else if(id==="posterize"){const d=Math.max(1,value(settings,"levels",4)-1),q=(v:number)=>Math.round(v*d/255)*255/d;nr=q(r);ng=q(g);nb=q(b);} else if(id==="brightness_contrast"){const br=value(settings,"brightness",0)*2.55,c=value(settings,"contrast",20)*2.55,f=259*(c+255)/(255*(259-c)),q=(v:number)=>f*(v+br-128)+128;nr=q(r);ng=q(g);nb=q(b);} else if(id==="sharpen"||id==="high_pass"){const bi=i;nr=128+(r-blurred![bi]!)*2;ng=128+(g-blurred![bi+1]!)*2;nb=128+(b-blurred![bi+2]!)*2;if(id!=="high_pass"){nr=r+(r-blurred![bi]!)*2;ng=g+(g-blurred![bi+1]!)*2;nb=b+(b-blurred![bi+2]!)*2;}} else if(id==="edge_detect"||id==="glowing_edges"||id==="plastic_wrap"){const x=(i/4)%width,y=Math.floor(i/4/width),j=(Math.min(height-1,y+1)*width+Math.min(width-1,x+1))*4,e=Math.abs(r-source[j]!)+Math.abs(g-source[j+1]!)+Math.abs(b-source[j+2]!);nr=ng=nb=id==="glowing_edges"?byte(e*2):byte(e);} else if(id==="vignette"){const p=i/4,x=p%width,y=Math.floor(p/width),d=Math.min(1,Math.hypot((x-width/2)/(width/2),(y-height/2)/(height/2))),f=1-d*d*mix*.8;nr=r*f;ng=g*f;nb=b*f;} else if(id==="noir"){nr=ng=nb=(l-128)*1.5+128;} else if(id==="punchy_color"){nr=l+(r-l)*1.45;ng=l+(g-l)*1.45;nb=l+(b-l)*1.45;} else if(id==="cinematic_matte"){nr=r*.85+24;ng=g*.9+18;nb=b*.95+12;} else if(id==="soft_glow"){nr=Math.max(r,blurred![i]!);ng=Math.max(g,blurred![i+1]!);nb=Math.max(b,blurred![i+2]!);}
    output[i]=byte(r+(nr-r)*mix);output[i+1]=byte(g+(ng-g)*mix);output[i+2]=byte(b+(nb-b)*mix);
  } return output;
}
