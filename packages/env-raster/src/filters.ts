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
export interface RasterFilterParameter { id: string; name: string; min: number; max: number; step: number; value: number; choices?: readonly string[] }
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
const motionBlurParams = [{ id: "distance", name: "Distance (Дистанция)", min: 1, max: 200, step: 1, value: 20 }, { id: "angle", name: "Angle (Угол)", min: -180, max: 180, step: 1, value: 0 }];
const radialBlurParams = [{ id: "amount", name: "Amount (Сила)", min: 1, max: 100, step: 1, value: 10 }, { id: "method", name: "Method (Метод)", min: 0, max: 1, step: 1, value: 0, choices: ["Spin (Вращение)", "Zoom (Приближение)"] }];
const surfaceBlurParams = [{ id: "radius", name: "Radius (Радиус)", min: 1, max: 50, step: 1, value: 5 }, { id: "threshold", name: "Threshold (Порог)", min: 0, max: 100, step: 1, value: 15 }];
const lensBlurParams = [{ id: "radius", name: "Radius (Радиус)", min: 1, max: 50, step: 1, value: 8 }];
const polarCoordinatesParams = [{ id: "direction", name: "Direction (Направление)", min: 0, max: 1, step: 1, value: 0, choices: ["Rectangular to Polar (В полярные координаты)", "Polar to Rectangular (В прямоугольные координаты)"] }];
const shearParams = [{ id: "amount", name: "Amount (Сила)", min: -100, max: 100, step: 1, value: 20 }];
const spherizeParams = [{ id: "amount", name: "Amount (Сила)", min: -100, max: 100, step: 1, value: 50 }];
const zigzagParams = [{ id: "amount", name: "Amount (Сила)", min: 0, max: 100, step: 1, value: 30 }];
const kaleidoscopeParams = [{ id: "segments", name: "Segments (Сегменты)", min: 3, max: 16, step: 1, value: 6 }];
const offsetParams = [{ id: "horizontal", name: "Horizontal (По горизонтали)", min: -500, max: 500, step: 1, value: 0 }, { id: "vertical", name: "Vertical (По вертикали)", min: -500, max: 500, step: 1, value: 0 }];
const morphologyParams = [{ id: "radius", name: "Radius (Радиус)", min: 1, max: 20, step: 1, value: 1 }];
const reduceNoiseParams = [{ id: "strength", name: "Strength (Сила)", min: 0, max: 8, step: 1, value: 4 }];
const smartSharpenParams = [{ id: "amount", name: "Amount (Эффект)", min: 0, max: 500, step: 1, value: 150 }, { id: "radius", name: "Radius (Радиус)", min: 1, max: 32, step: 1, value: 2 }];
const diffuseParams = [{ id: "amount", name: "Amount (Сила)", min: 1, max: 16, step: 1, value: 4 }];
const traceContourParams = [{ id: "level", name: "Level (Уровень)", min: 0, max: 255, step: 1, value: 128 }];
const windParams = [{ id: "strength", name: "Strength (Сила)", min: 1, max: 100, step: 1, value: 20 }, { id: "style", name: "Style (Стиль)", min: 0, max: 1, step: 1, value: 0, choices: ["Wind (Ветер)", "Blast (Порыв)"] }, { id: "direction", name: "Direction (Направление)", min: 0, max: 1, step: 1, value: 0, choices: ["From the Right (Справа)", "From the Left (Слева)"] }];
const oilPaintParams = [{ id: "brushSize", name: "Brush size (Размер кисти)", min: 1, max: 8, step: 1, value: 4 }, { id: "stylization", name: "Stylization (Стилизация)", min: 1, max: 20, step: 1, value: 8 }];
const embossParams = [{ id: "angle", name: "Angle (Угол)", min: 0, max: 360, step: 1, value: 135 }, { id: "height", name: "Height (Высота)", min: 1, max: 100, step: 1, value: 3 }, { id: "amount", name: "Amount (Сила)", min: 0, max: 500, step: 1, value: 100 }];
const lensFlareParams = [{ id: "brightness", name: "Brightness (Яркость)", min: 10, max: 300, step: 1, value: 100 }, { id: "positionX", name: "Position X (Позиция X)", min: 0, max: 100, step: 1, value: 50 }, { id: "positionY", name: "Position Y (Позиция Y)", min: 0, max: 100, step: 1, value: 50 }];
const cellSizeParams = [{ id: "cellSize", name: "Cell size (Размер ячейки)", min: 3, max: 100, step: 1, value: 12 }];
const fragmentParams = [{ id: "amount", name: "Offset (Смещение)", min: 1, max: 20, step: 1, value: 4 }];
const mezzotintParams = [{ id: "type", name: "Type (Тип)", min: 0, max: 3, step: 1, value: 0, choices: ["Fine Dots (Мелкие точки)", "Medium Dots (Средние точки)", "Coarse Dots (Крупные точки)", "Lines (Линии)"] }];
const shapeMosaicParams = [{ id: "cellSize", name: "Cell size (Размер ячейки)", min: 4, max: 100, step: 1, value: 20 }];
const fibersParams = [{ id: "variance", name: "Variance (Разброс)", min: 1, max: 100, step: 1, value: 50 }, { id: "strength", name: "Strength (Сила)", min: 1, max: 100, step: 1, value: 50 }];
const normalMapParams = [{ id: "scale", name: "Scale (Масштаб)", min: 1, max: 100, step: 1, value: 10 }];
const lensCorrectionParams = [{ id: "distortAmount", name: "Remove Distortion (Удалить искажение)", min: -100, max: 100, step: 1, value: 0 }, { id: "chromaticAberration", name: "Fix Chromatic Aberration (Хроматические аберрации)", min: 0, max: 100, step: 1, value: 0 }, { id: "vignetteAmount", name: "Vignette (Виньетирование)", min: -100, max: 100, step: 1, value: 0 }];
export const rasterFilterCatalog: RasterFilterDefinition[] = ([
  ["invert","Invert (Инверсия)","Basics",none], ["brightness_contrast","Brightness/Contrast (Яркость/Контраст)","Basics",[{id:"brightness",name:"Brightness (Яркость)",min:-100,max:100,step:1,value:0},{id:"contrast",name:"Contrast (Контраст)",min:-100,max:100,step:1,value:20}]], ["grayscale","Grayscale (Оттенки серого)","Basics",none], ["desaturate","Desaturate (Обесцветить)","Basics",none], ["auto_tone","Auto Tone (Автотон)","Photo",none], ["auto_contrast","Auto Contrast (Автоконтраст)","Photo",none], ["auto_color","Auto Color (Автоцвет)","Photo",none], ["soft_glow","Soft Glow (Мягкое свечение)","Photo",amount], ["punchy_color","Punchy Color (Сочный цвет)","Photo",amount], ["noir","Noir (Нуар)","Photo",amount], ["cinematic_matte","Cinematic Matte (Кинематографический матовый)","Photo",amount], ["vintage_fade","Vintage Fade (Винтажное выцветание)","Photo",amount], ["sepia","Vintage Sepia (Винтажная сепия)","Photo",amount], ["threshold","Threshold (Порог)","Basics",[{id:"threshold",name:"Threshold (Порог)",min:0,max:255,step:1,value:128}]], ["posterize","Posterize (Постеризация)","Basics",[{id:"levels",name:"Levels (Уровни)",min:2,max:32,step:1,value:4}]], ["box_blur","Box Blur (Прямоугольное размытие)","Blur",radius], ["sharpen","Sharpen (Резкость)","Sharpen",amount], ["unsharp_mask","Unsharp Mask (Контурная резкость)","Sharpen",amount], ["gaussian_blur","Gaussian Blur (Размытие по Гауссу)","Blur",radius], ["motion_blur","Motion Blur (Размытие в движении)","Blur",motionBlurParams], ["radial_blur","Radial Blur (Радиальное размытие)","Blur",radialBlurParams], ["edge_detect","Edge Detect (Выделение краёв)","Stylize",none], ["emboss","Emboss (Тиснение)","Stylize",embossParams], ["glowing_edges","Glowing Edges (Светящиеся края)","Stylize",amount], ["twirl","Twirl (Скручивание)","Distort",amount], ["wave","Wave (Волна)","Distort",amount], ["pinch_bloat","Pinch/Bloat (Сжатие/Вздутие)","Distort",[{id:"amount",name:"Amount (Сила)",min:-100,max:100,step:1,value:25}]], ["clouds","Clouds (Облака)","Render",amount], ["pixelate","Pixel Mosaic (Мозаика)","Stylize",[{id:"size",name:"Cell size (Размер ячейки)",min:2,max:64,step:1,value:8}]], ["color_halftone","Color Halftone (Цветные полутона)","Stylize",radius], ["film_grain","Analog Grain (Аналоговое зерно)","Noise",[noiseAmount]], ["add_noise","Add Noise (Добавить шум)","Noise",addNoiseParameters], ["vignette","Lens Vignette (Виньетка)","Photo",amount], ["high_pass","High Pass (Цветовой контраст)","Sharpen",radius], ["median","Median (Медиана)","Noise",radius], ["dust_and_scratches","Dust & Scratches (Пыль и царапины)","Noise",radius], ["surface_blur","Surface Blur (Размытие по поверхности)","Blur",surfaceBlurParams], ["lens_blur","Lens Blur (Размытие объектива)","Blur",lensBlurParams], ["iris_blur","Iris Blur (Размытие диафрагмы)","Blur",radius], ["tilt_shift_blur","Tilt-Shift Blur (Наклон-сдвиг)","Blur",radius], ["plastic_wrap","Plastic Wrap (Целлофановая упаковка)","Stylize",amount],
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
  ["ripple","Ripple (Рябь)","Distort",zigzagParams],
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

/** Edge-preserving order-statistic blur used by Median and Dust & Scratches.
 *
 * Radius is deliberately capped lower than convolution blurs: a median needs
 * to inspect every value in its neighbourhood and must stay responsive in the
 * worker preview. Unlike Box Blur, isolated dust pixels disappear without
 * smearing their colour over their neighbours. */
function medianBlur(source: Uint8ClampedArray, width: number, height: number, radius: number): Uint8ClampedArray {
  const r = Math.max(1, Math.min(8, Math.round(radius)));
  const output = new Uint8ClampedArray(source.length);
  const samples: number[] = [];
  const clampX = (x: number) => Math.max(0, Math.min(width - 1, x));
  const clampY = (y: number) => Math.max(0, Math.min(height - 1, y));
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const outputIndex = (y * width + x) * 4;
    for (let channel = 0; channel < 4; channel += 1) {
      samples.length = 0;
      for (let dy = -r; dy <= r; dy += 1) for (let dx = -r; dx <= r; dx += 1) {
        samples.push(source[(clampY(y + dy) * width + clampX(x + dx)) * 4 + channel]!);
      }
      samples.sort((left, right) => left - right);
      output[outputIndex + channel] = samples[samples.length >> 1]!;
    }
  }
  return output;
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

function colorHalftoneFilter(source: Uint8ClampedArray, width: number, height: number, cellSize: number): Uint8ClampedArray {
  const output = new Uint8ClampedArray(source.length), size = Math.max(2, Math.round(cellSize));
  for (let cellY = 0; cellY < height; cellY += size) for (let cellX = 0; cellX < width; cellX += size) {
    const right = Math.min(width, cellX + size), bottom = Math.min(height, cellY + size);
    let sum = 0, alphaSum = 0, count = 0;
    for (let y = cellY; y < bottom; y += 1) for (let x = cellX; x < right; x += 1) { const i = (y * width + x) * 4; sum += source[i]! * .3 + source[i + 1]! * .59 + source[i + 2]! * .11; alphaSum += source[i + 3]!; count += 1; }
    const averageLuminance = count ? sum / count / 255 : 1, averageAlpha = count ? alphaSum / count : 0, centerX = cellX + (right - cellX) / 2, centerY = cellY + (bottom - cellY) / 2, radius = (1 - averageLuminance) * size / 2 * 1.2;
    for (let y = cellY; y < bottom; y += 1) for (let x = cellX; x < right; x += 1) {
      const inDot = Math.hypot(x - centerX + .5, y - centerY + .5) <= radius, shade = inDot ? 0 : 255, i = (y * width + x) * 4;
      output[i] = shade; output[i + 1] = shade; output[i + 2] = shade; output[i + 3] = byte(averageAlpha);
    }
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
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const sum = [0, 0, 0, 0];
    for (let step = 0; step < steps; step += 1) {
      const t = steps === 1 ? 0 : step / (steps - 1) - 0.5;
      const [r, g, b, a] = sampleBilinear(source, width, height, x + offsetX * t, y + offsetY * t);
      sum[0] = sum[0]! + r; sum[1] = sum[1]! + g; sum[2] = sum[2]! + b; sum[3] = sum[3]! + a;
    }
    const i = (y * width + x) * 4;
    for (let c = 0; c < 4; c += 1) output[i + c] = byte(sum[c]! / steps);
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
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
      const endX = x + (cx - x) * factor, endY = y + (cy - y) * factor;
      const steps = Math.max(3, Math.min(64, Math.ceil(Math.hypot(endX - x, endY - y)) + 1));
      const sum = [0, 0, 0, 0];
      for (let step = 0; step < steps; step += 1) {
        const t = step / (steps - 1);
        const [r, g, b, a] = sampleBilinear(source, width, height, x + (endX - x) * t, y + (endY - y) * t);
        sum[0] = sum[0]! + r; sum[1] = sum[1]! + g; sum[2] = sum[2]! + b; sum[3] = sum[3]! + a;
      }
      const i = (y * width + x) * 4;
      for (let c = 0; c < 4; c += 1) output[i + c] = byte(sum[c]! / steps);
    }
    return output;
  }
  const angle = Math.max(0, Math.min(100, amountPercent)) / 100 * Math.PI / 6;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const dx = x - cx, dy = y - cy, r = Math.hypot(dx, dy);
    const steps = Math.max(3, Math.min(64, Math.ceil(r * angle * 1.41)));
    const phiBase = Math.atan2(dy, dx), phiStart = phiBase + angle / 2, phiStep = angle / steps;
    const sum = [0, 0, 0, 0];
    for (let step = 0; step < steps; step += 1) {
      const phi = phiStart - step * phiStep;
      const [sr, sg, sb, sa] = sampleBilinear(source, width, height, cx + r * Math.cos(phi), cy + r * Math.sin(phi));
      sum[0] = sum[0]! + sr; sum[1] = sum[1]! + sg; sum[2] = sum[2]! + sb; sum[3] = sum[3]! + sa;
    }
    const i = (y * width + x) * 4;
    for (let c = 0; c < 4; c += 1) output[i + c] = byte(sum[c]! / steps);
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
  const output = new Uint8ClampedArray(source.length), r = Math.max(1, Math.min(50, Math.round(radius))), maxDelta = Math.max(0, Math.min(100, thresholdPercent)) * 2.55;
  const clampX = (x: number) => Math.max(0, Math.min(width - 1, x)), clampY = (y: number) => Math.max(0, Math.min(height - 1, y));
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const centerIndex = (y * width + x) * 4, sum = [0, 0, 0], weightSum = [0, 0, 0];
    for (let dy = -r; dy <= r; dy += 1) for (let dx = -r; dx <= r; dx += 1) {
      const distanceSquared = dx * dx + dy * dy;
      if (distanceSquared > r * r) continue;
      const sampleIndex = (clampY(y + dy) * width + clampX(x + dx)) * 4;
      const weight = Math.exp(-0.5 * distanceSquared / r) * (source[sampleIndex + 3]! / 255);
      for (let c = 0; c < 3; c += 1) {
        const diff = source[centerIndex + c]! - source[sampleIndex + c]!;
        if (diff > maxDelta || diff < -maxDelta) continue;
        sum[c]! += weight * source[sampleIndex + c]!;
        weightSum[c]! += weight;
      }
    }
    for (let c = 0; c < 3; c += 1) output[centerIndex + c] = weightSum[c]! > 0 ? byte(sum[c]! / weightSum[c]!) : source[centerIndex + c]!;
    output[centerIndex + 3] = source[centerIndex + 3]!;
  }
  return output;
}

/** Lens Blur, approximated as a disc-shaped (circular aperture) average — the
 * kernel shape a real camera iris produces, distinct from Gaussian/box. A
 * full depth-map-driven implementation needs a depth channel this engine
 * does not have yet (docs/master-plan.md §51). */
function lensBlurFilter(source: Uint8ClampedArray, width: number, height: number, radius: number): Uint8ClampedArray {
  const output = new Uint8ClampedArray(source.length), r = Math.max(1, Math.min(50, Math.round(radius)));
  const clampX = (x: number) => Math.max(0, Math.min(width - 1, x)), clampY = (y: number) => Math.max(0, Math.min(height - 1, y));
  const offsets: [number, number][] = [];
  for (let dy = -r; dy <= r; dy += 1) for (let dx = -r; dx <= r; dx += 1) if (dx * dx + dy * dy <= r * r) offsets.push([dx, dy]);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const sum = [0, 0, 0, 0];
    for (const [dx, dy] of offsets) {
      const index = (clampY(y + dy) * width + clampX(x + dx)) * 4;
      for (let c = 0; c < 4; c += 1) sum[c]! += source[index + c]!;
    }
    const i = (y * width + x) * 4;
    for (let c = 0; c < 4; c += 1) output[i + c] = byte(sum[c]! / offsets.length);
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
 * a horizontal offset proportional to distance from the vertical centre.
 * Photoshop's own dialog wraps the same transform in a draggable curve;
 * this engine's single Amount slider drives the linear case of that curve. */
function shearFilter(source: Uint8ClampedArray, width: number, height: number, amountPercent: number): Uint8ClampedArray {
  const output = new Uint8ClampedArray(source.length), cy = height / 2, maxShift = (amountPercent / 100) * (width / 4);
  for (let y = 0; y < height; y += 1) {
    const shift = maxShift * ((y - cy) / (cy || 1));
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
function rippleFilter(source: Uint8ClampedArray, width: number, height: number, amountPercent: number): Uint8ClampedArray {
  const output = new Uint8ClampedArray(source.length);
  const amplitude = Math.max(0, amountPercent) / 100 * Math.min(width, height) * 0.04, period = Math.max(4, Math.min(width, height) / 10);
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
function kaleidoscopeFilter(source: Uint8ClampedArray, width: number, height: number, segments: number): Uint8ClampedArray {
  const output = new Uint8ClampedArray(source.length), cx = width / 2, cy = height / 2, n = Math.max(3, Math.round(segments)), wedge = Math.PI * 2 / n;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const dx = x - cx, dy = y - cy, r = Math.hypot(dx, dy);
    let angle = Math.atan2(dy, dx) % wedge;
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
function offsetFilter(source: Uint8ClampedArray, width: number, height: number, dx: number, dy: number): Uint8ClampedArray {
  const output = new Uint8ClampedArray(source.length), ox = Math.round(dx), oy = Math.round(dy);
  const wrap = (value: number, size: number) => ((value % size) + size) % size;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const sourceIndex = (wrap(y - oy, height) * width + wrap(x - ox, width)) * 4, i = (y * width + x) * 4;
    output[i] = source[sourceIndex]!; output[i + 1] = source[sourceIndex + 1]!; output[i + 2] = source[sourceIndex + 2]!; output[i + 3] = source[sourceIndex + 3]!;
  }
  return output;
}

/** Maximum/Minimum — the standard morphological dilate/erode: each channel
 * becomes the max (or min) found within `radius`, independently per channel,
 * matching Photoshop's own "Other > Maximum/Minimum". */
function morphologyFilter(source: Uint8ClampedArray, width: number, height: number, radius: number, dilate: boolean): Uint8ClampedArray {
  const output = new Uint8ClampedArray(source.length), r = Math.max(1, Math.min(20, Math.round(radius)));
  const clampX = (x: number) => Math.max(0, Math.min(width - 1, x)), clampY = (y: number) => Math.max(0, Math.min(height - 1, y));
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const best = [dilate ? 0 : 255, dilate ? 0 : 255, dilate ? 0 : 255, dilate ? 0 : 255];
    for (let dy = -r; dy <= r; dy += 1) for (let dx = -r; dx <= r; dx += 1) {
      if (dx * dx + dy * dy > r * r) continue;
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
  let current = source;
  const clampX = (x: number) => Math.max(0, Math.min(width - 1, x)), clampY = (y: number) => Math.max(0, Math.min(height - 1, y));
  const offsets: [number, number][] = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
  for (let pass = 0; pass < Math.max(0, Math.round(iterations)); pass += 1) {
    const next = new Uint8ClampedArray(current.length), snapshot = current;
    const at = (x: number, y: number, c: number) => snapshot[(clampY(y) * width + clampX(x)) * 4 + c]!;
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      for (let c = 0; c < 3; c += 1) {
        const center = at(x, y, c);
        const metric = (axis: number) => {
          const [bx, by] = offsets[axis]!, [ax, ay] = offsets[7 - axis]!;
          const before = at(x + bx, y + by, c), after = at(x + ax, y + ay, c);
          return (center * 2 - before - after) ** 2;
        };
        const reference = [metric(0), metric(1), metric(2), metric(3)];
        let sum = center, count = 1;
        for (let direction = 0; direction < 8; direction += 1) {
          const [ox, oy] = offsets[direction]!, neighbor = at(x + ox, y + oy, c), candidate = neighbor * 0.5 + center * 0.5;
          let valid = true;
          for (let axis = 0; axis < 4 && valid; axis += 1) {
            const [bx, by] = offsets[axis]!, [ax, ay] = offsets[7 - axis]!;
            const before = axis === direction % 4 ? candidate : at(x + bx, y + by, c);
            const after = 7 - axis === direction ? candidate : at(x + ax, y + ay, c);
            if ((center * 2 - before - after) ** 2 > reference[axis]!) valid = false;
          }
          if (valid) { sum += candidate; count += 1; }
        }
        next[i + c] = byte(sum / count);
      }
      next[i + 3] = snapshot[i + 3]!;
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
function unsharpFilter(source: Uint8ClampedArray, width: number, height: number, blurRadius: number, strength: number): Uint8ClampedArray {
  const output = new Uint8ClampedArray(source.length), blurred = blur(source, width, height, blurRadius);
  for (let i = 0; i < source.length; i += 4) {
    for (let c = 0; c < 3; c += 1) output[i + c] = byte(source[i + c]! + (source[i + c]! - blurred[i + c]!) * strength);
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
function diffuseFilter(source: Uint8ClampedArray, width: number, height: number, amount: number): Uint8ClampedArray {
  const output = new Uint8ClampedArray(source.length), r = Math.max(1, Math.round(amount));
  const clampX = (x: number) => Math.max(0, Math.min(width - 1, x)), clampY = (y: number) => Math.max(0, Math.min(height - 1, y));
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const hashX = addNoiseHash(x, y, 101), hashY = addNoiseHash(x, y, 202);
    const dx = Math.round(unitFromHash(hashX) * r), dy = Math.round(unitFromHash(hashY) * r);
    const sourceIndex = (clampY(y + dy) * width + clampX(x + dx)) * 4, i = (y * width + x) * 4;
    output[i] = source[sourceIndex]!; output[i + 1] = source[sourceIndex + 1]!; output[i + 2] = source[sourceIndex + 2]!; output[i + 3] = source[sourceIndex + 3]!;
  }
  return output;
}

/** Trace Contour: marks a thin white line wherever luminance crosses
 * `level` between a pixel and its right/bottom neighbour, black everywhere
 * else — Photoshop's own single-level contour band (its Upper/Lower pair
 * is two bands; this engine exposes one, per the plain-slider convention
 * every other single-level filter here already uses). */
function traceContourFilter(source: Uint8ClampedArray, width: number, height: number, level: number): Uint8ClampedArray {
  const output = new Uint8ClampedArray(source.length);
  const luma = (i: number) => (source[i]! * 30 + source[i + 1]! * 59 + source[i + 2]! * 11) / 100;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const i = (y * width + x) * 4, center = luma(i);
    const right = x + 1 < width ? luma(i + 4) : center, down = y + 1 < height ? luma(i + width * 4) : center;
    const crosses = (center - level) * (right - level) < 0 || (center - level) * (down - level) < 0;
    const shade = crosses ? 255 : 0;
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
function windFilter(source: Uint8ClampedArray, width: number, height: number, strength: number, style: number, direction: number): Uint8ClampedArray {
  const output = source.slice(), fromLeft = direction >= 1, blast = style >= 1;
  const luma = (i: number) => (output[i]! * 30 + output[i + 1]! * 59 + output[i + 2]! * 11) / 100;
  for (let y = 0; y < height; y += 1) {
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
  const output = new Uint8ClampedArray(source.length), r = Math.max(1, Math.min(8, Math.round(brushSize))), buckets = 32;
  const clampX = (x: number) => Math.max(0, Math.min(width - 1, x)), clampY = (y: number) => Math.max(0, Math.min(height - 1, y));
  const exp = Math.max(1, Math.round(exponent));
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const histogram = new Array(buckets).fill(0);
    const bucketColor: number[][] = Array.from({ length: buckets }, () => [0, 0, 0, 0]);
    for (let dy = -r; dy <= r; dy += 1) for (let dx = -r; dx <= r; dx += 1) {
      if (dx * dx + dy * dy > r * r) continue;
      const index = (clampY(y + dy) * width + clampX(x + dx)) * 4;
      const luma = (source[index]! * 30 + source[index + 1]! * 59 + source[index + 2]! * 11) / 100;
      const bucket = Math.min(buckets - 1, Math.floor((luma / 255) * buckets));
      histogram[bucket] += 1;
      for (let c = 0; c < 4; c += 1) bucketColor[bucket]![c] = bucketColor[bucket]![c]! + source[index + c]!;
    }
    const maxCount = Math.max(1, ...histogram);
    let sum = [0, 0, 0, 0], weightSum = 0;
    for (let b = 0; b < buckets; b += 1) {
      if (histogram[b] === 0) continue;
      let weight = 1;
      const ratio = histogram[b] / maxCount;
      for (let power = 0; power < exp; power += 1) weight *= ratio;
      const perPixel = weight / histogram[b];
      for (let c = 0; c < 4; c += 1) sum[c]! += perPixel * bucketColor[b]![c]!;
      weightSum += weight;
    }
    const i = (y * width + x) * 4;
    for (let c = 0; c < 4; c += 1) output[i + c] = weightSum > 0 ? byte(sum[c]! / weightSum) : source[i + c]!;
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
 * (docs/master-plan.md §51's interactivity level 2).
 */
function lensFlareFilter(source: Uint8ClampedArray, width: number, height: number, brightnessPercent: number, positionXPercent: number, positionYPercent: number): Uint8ClampedArray {
  const output = source.slice();
  const centerX = (positionXPercent / 100) * width, centerY = (positionYPercent / 100) * height;
  const matte = width, brightness = Math.max(0, brightnessPercent) / 100;
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
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const i = (y * width + x) * 4;
    const pixel = [source[i]! / 255, source[i + 1]! / 255, source[i + 2]! / 255];
    const hyp = Math.hypot(x - centerX, y - centerY);
    let percent = (colorSize - hyp) / colorSize; if (percent > 0) fixPixel(pixel, percent * percent, color);
    percent = (glowSize - hyp) / glowSize; if (percent > 0) fixPixel(pixel, percent * percent, glow);
    percent = (innerSize - hyp) / innerSize; if (percent > 0) fixPixel(pixel, percent * percent, inner);
    percent = (outerSize - hyp) / outerSize; if (percent > 0) fixPixel(pixel, percent, outer);
    percent = Math.abs((hyp - haloSize) / (haloSize * 0.07)); if (percent < 1) fixPixel(pixel, 1 - percent, halo);
    for (const reflection of reflections) {
      const rhyp = Math.hypot(x - reflection.xp, y - reflection.yp);
      if (reflection.type === 1) { const p = (reflection.size - rhyp) / reflection.size; if (p > 0) fixPixel(pixel, p * p, reflection.color); }
      else if (reflection.type === 2) { const p = Math.min(1, (reflection.size - rhyp) / (reflection.size * 0.15)); if (p > 0) fixPixel(pixel, p, reflection.color); }
      else if (reflection.type === 3) { let p = (reflection.size - rhyp) / (reflection.size * 0.12); if (p > 0) { if (p > 1) p = 1 - p * 0.12; fixPixel(pixel, p, reflection.color); } }
      else { const p = Math.abs((rhyp - reflection.size) / (reflection.size * 0.04)); if (p < 1) fixPixel(pixel, 1 - p, reflection.color); }
    }
    output[i] = byte(pixel[0]! * 255); output[i + 1] = byte(pixel[1]! * 255); output[i + 2] = byte(pixel[2]! * 255); output[i + 3] = source[i + 3]!;
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
  const size = Math.max(3, Math.round(cellSize)), { cellColor, points } = cellularTessellation(source, width, height, cellSize);
  const output = new Uint8ClampedArray(source.length).fill(255);
  for (let i = 3; i < output.length; i += 4) output[i] = 255;
  const dotRadius = size * 0.42;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const i = (y * width + x) * 4;
    let best = -1, bestDistance = dotRadius * dotRadius;
    for (let index = 0; index < points.length; index += 1) {
      const point = points[index]!, distance = (point.x - x) ** 2 + (point.y - y) ** 2;
      if (distance < bestDistance) { bestDistance = distance; best = index; }
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

/** Mezzotint: ordered dither to black/white (or a coloured variant of it)
 * using the same Bayer-matrix technique `eInkFilter` already established
 * for this project, at grain sizes/orientations standing in for
 * Photoshop's Fine/Medium/Coarse Dots and Lines pattern choices. */
function mezzotintFilter(source: Uint8ClampedArray, width: number, height: number, type: number): Uint8ClampedArray {
  const output = new Uint8ClampedArray(source.length), isLines = type === 3, grain = [2, 4, 8, 3][type] ?? 2;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const i = (y * width + x) * 4;
    const luma = (source[i]! * 30 + source[i + 1]! * 59 + source[i + 2]! * 11) / 100 / 255;
    let threshold: number;
    if (isLines) {
      threshold = (Math.abs((y % (grain * 2)) - grain) / grain);
    } else {
      const cellX = x % grain, cellY = y % grain, cellIndex = cellY * grain + cellX;
      threshold = (addNoiseHash(Math.floor(x / grain), Math.floor(y / grain), cellIndex) >>> 24) / 255;
    }
    const shade = luma > threshold ? 255 : 0;
    output[i] = shade; output[i + 1] = shade; output[i + 2] = shade; output[i + 3] = source[i + 3]!;
  }
  return output;
}

/** Shape Mosaic: like Pixel Mosaic, but each square cell is split along its
 * diagonal into two triangles, each filled with its own average colour —
 * a distinct cell *shape* from the plain square Pixelate already has, which
 * is the entire point of it being a separate filter. */
function shapeMosaicFilter(source: Uint8ClampedArray, width: number, height: number, cellSize: number): Uint8ClampedArray {
  const output = new Uint8ClampedArray(source.length), size = Math.max(4, Math.round(cellSize));
  for (let cellY = 0; cellY < height; cellY += size) for (let cellX = 0; cellX < width; cellX += size) {
    const right = Math.min(width, cellX + size), bottom = Math.min(height, cellY + size);
    const sumA = [0, 0, 0, 0, 0], sumB = [0, 0, 0, 0, 0];
    for (let y = cellY; y < bottom; y += 1) for (let x = cellX; x < right; x += 1) {
      const inTriangleA = (x - cellX) + (y - cellY) < size, i = (y * width + x) * 4, sum = inTriangleA ? sumA : sumB;
      sum[0] = sum[0]! + source[i]!; sum[1] = sum[1]! + source[i + 1]!; sum[2] = sum[2]! + source[i + 2]!; sum[3] = sum[3]! + source[i + 3]!; sum[4] = sum[4]! + 1;
    }
    const colorA = sumA[4]! > 0 ? sumA : sumB, colorB = sumB[4]! > 0 ? sumB : sumA;
    for (let y = cellY; y < bottom; y += 1) for (let x = cellX; x < right; x += 1) {
      const inTriangleA = (x - cellX) + (y - cellY) < size, i = (y * width + x) * 4, color = inTriangleA ? colorA : colorB;
      output[i] = byte(color[0]! / color[4]!); output[i + 1] = byte(color[1]! / color[4]!); output[i + 2] = byte(color[2]! / color[4]!); output[i + 3] = byte(color[3]! / color[4]!);
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
function normalMapFilter(source: Uint8ClampedArray, width: number, height: number, scale: number): Uint8ClampedArray {
  const output = new Uint8ClampedArray(source.length);
  const clampX = (x: number) => Math.max(0, Math.min(width - 1, x)), clampY = (y: number) => Math.max(0, Math.min(height - 1, y));
  const heightAt = (x: number, y: number) => { const i = (clampY(y) * width + clampX(x)) * 4; return (source[i]! * 30 + source[i + 1]! * 59 + source[i + 2]! * 11) / 100 / 255; };
  const s = scale / 2;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const dx = (heightAt(x + 1, y) - heightAt(x - 1, y)) * s, dy = (heightAt(x, y + 1) - heightAt(x, y - 1)) * s;
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
function lensCorrectionFilter(source: Uint8ClampedArray, width: number, height: number, distortAmount: number, chromaticAberration: number, vignetteAmount: number): Uint8ClampedArray {
  const output = new Uint8ClampedArray(source.length);
  const norm = 4 / (width * width + height * height), centerX = width / 2, centerY = height / 2;
  const rescale = 1, mainAmount = distortAmount / 200, caOffset = (chromaticAberration / 100) * 0.15;
  const sourceFor = (x: number, y: number, mult: number) => {
    const offX = x - centerX, offY = y - centerY, radiusSq = (offX * offX + offY * offY) * norm;
    const radiusMult = rescale * (1 + radiusSq * mult);
    return { x: centerX + radiusMult * offX, y: centerY + radiusMult * offY };
  };
  const vignetteMix = Math.max(-1, Math.min(1, vignetteAmount / 100));
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const green = sourceFor(x, y, mainAmount);
    const red = caOffset !== 0 ? sourceFor(x, y, mainAmount - caOffset) : green;
    const blue = caOffset !== 0 ? sourceFor(x, y, mainAmount + caOffset) : green;
    const [rr] = sampleBilinear(source, width, height, red.x, red.y);
    const [, gg] = sampleBilinear(source, width, height, green.x, green.y);
    const [, , bb, aa] = sampleBilinear(source, width, height, blue.x, blue.y);
    const i = (y * width + x) * 4;
    const d = Math.min(1, Math.hypot((x - centerX) / centerX, (y - centerY) / centerY));
    const vignetteFactor = 1 - d * d * vignetteMix * 0.8;
    output[i] = byte(rr * vignetteFactor); output[i + 1] = byte(gg * vignetteFactor); output[i + 2] = byte(bb * vignetteFactor); output[i + 3] = aa;
  }
  return output;
}

export function applyRasterFilter(source: Uint8ClampedArray, width: number, height: number, id: string, settings: Record<string, number> = {}): Uint8ClampedArray {
  const output = source.slice(), mix = Math.max(0,Math.min(1,value(settings,"amount",100)/100));
  if (id === "gaussian_blur") return gaussianBlur(source, width, height, value(settings, "radius", 2));
  if (id === "median" || id === "dust_and_scratches") return medianBlur(source, width, height, value(settings, "radius", 2));
  if (["box_blur","iris_blur","tilt_shift_blur"].includes(id)) return blur(source,width,height,value(settings,"radius",2));
  if (id === "motion_blur") return motionBlurFilter(source, width, height, value(settings, "distance", 20), value(settings, "angle", 0));
  if (id === "radial_blur") return radialBlurFilter(source, width, height, value(settings, "amount", 10), value(settings, "method", 0));
  if (id === "surface_blur") return surfaceBlurFilter(source, width, height, value(settings, "radius", 5), value(settings, "threshold", 15));
  if (id === "lens_blur") return lensBlurFilter(source, width, height, value(settings, "radius", 8));
  if (id === "average") return averageFilter(source, width, height);
  if (id === "blur") return blur(source, width, height, 1);
  if (id === "blur_more") return blur(source, width, height, 3);
  if (id === "polar_coordinates") return polarCoordinatesFilter(source, width, height, value(settings, "direction", 0) === 1);
  if (id === "shear") return shearFilter(source, width, height, value(settings, "amount", 20));
  if (id === "spherize") return spherizeFilter(source, width, height, value(settings, "amount", 50));
  if (id === "zigzag") return zigzagFilter(source, width, height, value(settings, "amount", 30));
  if (id === "ripple") return rippleFilter(source, width, height, value(settings, "amount", 30));
  if (id === "kaleidoscope") return kaleidoscopeFilter(source, width, height, value(settings, "segments", 6));
  if (id === "offset") return offsetFilter(source, width, height, value(settings, "horizontal", 0), value(settings, "vertical", 0));
  if (id === "maximum") return morphologyFilter(source, width, height, value(settings, "radius", 1), true);
  if (id === "minimum") return morphologyFilter(source, width, height, value(settings, "radius", 1), false);
  if (id === "despeckle") return noiseReductionFilter(source, width, height, 1);
  if (id === "reduce_noise") return noiseReductionFilter(source, width, height, value(settings, "strength", 4));
  if (id === "sharpen_more") return unsharpFilter(source, width, height, 2, 3);
  if (id === "sharpen_edges") return sharpenEdgesFilter(source, width, height);
  if (id === "smart_sharpen") return unsharpFilter(source, width, height, value(settings, "radius", 2), value(settings, "amount", 150) / 100);
  if (id === "diffuse") return diffuseFilter(source, width, height, value(settings, "amount", 4));
  if (id === "solarize") { const solarized = source.slice(); for (let i = 0; i < solarized.length; i += 4) for (let c = 0; c < 3; c += 1) solarized[i + c] = solarized[i + c]! > 128 ? byte(255 - solarized[i + c]!) : solarized[i + c]!; return solarized; }
  if (id === "trace_contour") return traceContourFilter(source, width, height, value(settings, "level", 128));
  if (id === "wind") return windFilter(source, width, height, value(settings, "strength", 20), value(settings, "style", 0), value(settings, "direction", 0));
  if (id === "oil_paint") return oilPaintFilter(source, width, height, value(settings, "brushSize", 4), value(settings, "stylization", 8));
  if (id === "lens_flare") return lensFlareFilter(source, width, height, value(settings, "brightness", 100), value(settings, "positionX", 50), value(settings, "positionY", 50));
  if (id === "emboss") return embossFilter(source, width, height, value(settings, "angle", 135), value(settings, "height", 3), value(settings, "amount", 100));
  if (id === "crystallize") return crystallizeFilter(source, width, height, value(settings, "cellSize", 12));
  if (id === "pointillize") return pointillizeFilter(source, width, height, value(settings, "cellSize", 12));
  if (id === "fragment") return fragmentFilter(source, width, height, Math.round(value(settings, "amount", 4)));
  if (id === "mezzotint") return mezzotintFilter(source, width, height, Math.round(value(settings, "type", 0)));
  if (id === "shape_mosaic") return shapeMosaicFilter(source, width, height, value(settings, "cellSize", 20));
  if (id === "difference_clouds") return differenceCloudsFilter(source, width, height);
  if (id === "fibers") return fibersFilter(width, height, value(settings, "variance", 50), value(settings, "strength", 50));
  if (id === "normal_map") return normalMapFilter(source, width, height, value(settings, "scale", 10));
  if (id === "lens_correction") return lensCorrectionFilter(source, width, height, value(settings, "distortAmount", 0), value(settings, "chromaticAberration", 0), value(settings, "vignetteAmount", 0));
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
  if(id==="color_halftone") return colorHalftoneFilter(source,width,height,value(settings,"radius",2)*4);
  // high_pass carries its own Radius parameter (the catalog declares it) —
  // it used to ignore that slider entirely and always blur at a hardcoded
  // radius of 2, the exact "checkbox that does nothing" CLAUDE.md warns
  // against (§3). soft_glow/unsharp_mask/sharpen keep the fixed radius
  // their single Amount-only dialog implies.
  const blurred = ["soft_glow","unsharp_mask","sharpen"].includes(id)?blur(source,width,height,2):id==="high_pass"?blur(source,width,height,value(settings,"radius",2)):null;
  for(let i=0;i<output.length;i+=4){const r=source[i]!,g=source[i+1]!,b=source[i+2]!,l=(r*30+g*59+b*11)/100;let nr=r,ng=g,nb=b;
    if(id==="invert"){nr=255-r;ng=255-g;nb=255-b;} else if(id==="grayscale"||id==="desaturate"){nr=ng=nb=l;} else if(id==="sepia"||id==="vintage_fade"){nr=byte(r*.393+g*.769+b*.189);ng=byte(r*.349+g*.686+b*.168);nb=byte(r*.272+g*.534+b*.131);} else if(id==="threshold"){nr=ng=nb=l>=value(settings,"threshold",128)?255:0;} else if(id==="posterize"){const d=Math.max(1,value(settings,"levels",4)-1),q=(v:number)=>Math.round(v*d/255)*255/d;nr=q(r);ng=q(g);nb=q(b);} else if(id==="brightness_contrast"){const br=value(settings,"brightness",0)*2.55,c=value(settings,"contrast",20)*2.55,f=259*(c+255)/(255*(259-c)),q=(v:number)=>f*(v+br-128)+128;nr=q(r);ng=q(g);nb=q(b);} else if(id==="sharpen"||id==="unsharp_mask"||id==="high_pass"){const bi=i;nr=128+(r-blurred![bi]!)*2;ng=128+(g-blurred![bi+1]!)*2;nb=128+(b-blurred![bi+2]!)*2;if(id!=="high_pass"){nr=r+(r-blurred![bi]!)*2;ng=g+(g-blurred![bi+1]!)*2;nb=b+(b-blurred![bi+2]!)*2;}} else if(id==="edge_detect"||id==="glowing_edges"||id==="plastic_wrap"){const x=(i/4)%width,y=Math.floor(i/4/width),j=(Math.min(height-1,y+1)*width+Math.min(width-1,x+1))*4,e=Math.abs(r-source[j]!)+Math.abs(g-source[j+1]!)+Math.abs(b-source[j+2]!);nr=ng=nb=id==="glowing_edges"?byte(e*2):byte(e);} else if(id==="vignette"){const p=i/4,x=p%width,y=Math.floor(p/width),d=Math.min(1,Math.hypot((x-width/2)/(width/2),(y-height/2)/(height/2))),f=1-d*d*mix*.8;nr=r*f;ng=g*f;nb=b*f;} else if(id==="noir"){nr=ng=nb=(l-128)*1.5+128;} else if(id==="punchy_color"){nr=l+(r-l)*1.45;ng=l+(g-l)*1.45;nb=l+(b-l)*1.45;} else if(id==="cinematic_matte"){nr=r*.85+24;ng=g*.9+18;nb=b*.95+12;} else if(id==="soft_glow"){nr=Math.max(r,blurred![i]!);ng=Math.max(g,blurred![i+1]!);nb=Math.max(b,blurred![i+2]!);}
    output[i]=byte(r+(nr-r)*mix);output[i+1]=byte(g+(ng-g)*mix);output[i+2]=byte(b+(nb-b)*mix);
  } return output;
}
