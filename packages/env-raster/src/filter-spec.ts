import { applyRasterFilter } from "./filters";
import type { RasterRect } from "./types";

export type FilterParams = Record<string, number>;

export interface FilterUniform { readonly [name: string]: number | readonly number[] }

export interface FilterGpuProgram<P extends FilterParams> {
  /** GLSL ES 3.0 fragment source for the WebGL2 backend. */
  readonly glsl?: string;
  /** WGSL for the WebGPU backend, when one is available. */
  readonly wgsl?: string;
  /** Separable effects run more than once; blur is two (horizontal, then vertical). */
  readonly passes?: number | ((params: P) => number);
  /**
   * Whether the shader should actually be used when a GPU is available.
   *
   * Not every filter is faster on the GPU. A shader that gathers a neighbourhood costs one
   * texture fetch per tap per pixel, while the CPU version can carry a running sum and pay
   * O(1) per pixel — measured on 1920×1080, the blur shader loses to it roughly two to one.
   * Such shaders stay declared (a WebGPU compute pass would flip the result) but are opt-in.
   */
  readonly preferred?: boolean;
  uniforms(params: P, pass: number): FilterUniform;
}

export interface FilterSpec<P extends FilterParams = FilterParams> {
  readonly id: string;
  readonly title: string;
  readonly defaults: P;
  readonly gpu?: FilterGpuProgram<P>;
  /** Pure pixel implementation. Always present so there is a fallback on every device. */
  cpu(source: Uint8ClampedArray, target: Uint8ClampedArray, width: number, height: number, params: P): void;
  /**
   * How far the filter reaches beyond the pixel it writes.
   *
   * Without it, repainting a dirty rectangle with a blur leaves visible seams: the pixels just
   * inside the edge need neighbours that lie outside it.
   */
  kernelRadius?(params: P): number;
}

/** Grows a dirty rectangle so a filter's kernel has the neighbours it reads, clamped to the document. */
export function expandRectForFilter<P extends FilterParams>(rect: RasterRect, spec: FilterSpec<P>, params: P, width: number, height: number): RasterRect {
  const radius = Math.max(0, Math.ceil(spec.kernelRadius?.(params) ?? 0));
  const x = Math.max(0, Math.floor(rect.x) - radius), y = Math.max(0, Math.floor(rect.y) - radius);
  const right = Math.min(width, Math.ceil(rect.x + rect.width) + radius);
  const bottom = Math.min(height, Math.ceil(rect.y + rect.height) + radius);
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

export function filterPassCount<P extends FilterParams>(spec: FilterSpec<P>, params: P): number {
  const passes = spec.gpu?.passes;
  return Math.max(1, typeof passes === "function" ? passes(params) : passes ?? 1);
}

/** Bridges a spec to the existing CPU catalog so shaders can be added without duplicating pixel code. */
function catalogCpu(id: string) {
  return (source: Uint8ClampedArray, target: Uint8ClampedArray, width: number, height: number, params: FilterParams): void => {
    target.set(applyRasterFilter(source, width, height, id, params));
  };
}

const passthroughVertexNote = "The backend supplies the vertex stage; specs only declare the fragment body.";

/**
 * Fragment shaders ported from glfx.js (MIT) and rewritten for GLSL ES 3.0.
 * `sourceTexture`, `texCoord` and `texelSize` are provided by the backend.
 */
export const filterSpecs: readonly FilterSpec[] = [
  {
    id: "brightness_contrast",
    title: "Brightness/Contrast (Яркость/Контраст)",
    defaults: { brightness: 0, contrast: 20 },
    cpu: catalogCpu("brightness_contrast"),
    gpu: {
      glsl: `
        vec4 filterPixel(vec4 color) {
          color.rgb += brightness;
          if (contrast > 0.0) color.rgb = (color.rgb - 0.5) / max(1.0 - contrast, 0.001) + 0.5;
          else color.rgb = (color.rgb - 0.5) * (1.0 + contrast) + 0.5;
          return color;
        }`,
      uniforms: (params) => ({ brightness: (params.brightness ?? 0) / 100, contrast: (params.contrast ?? 0) / 100 }),
    },
  },
  {
    id: "sepia",
    title: "Vintage Sepia (Винтажная сепия)",
    defaults: { amount: 100 },
    cpu: catalogCpu("sepia"),
    gpu: {
      glsl: `
        vec4 filterPixel(vec4 color) {
          float r = color.r, g = color.g, b = color.b;
          vec3 toned = vec3(
            r * 0.393 + g * 0.769 + b * 0.189,
            r * 0.349 + g * 0.686 + b * 0.168,
            r * 0.272 + g * 0.534 + b * 0.131);
          return vec4(mix(color.rgb, toned, amount), color.a);
        }`,
      uniforms: (params) => ({ amount: (params.amount ?? 100) / 100 }),
    },
  },
  {
    id: "vignette",
    title: "Lens Vignette (Виньетка)",
    defaults: { amount: 100 },
    cpu: catalogCpu("vignette"),
    gpu: {
      glsl: `
        vec4 filterPixel(vec4 color) {
          vec2 offset = texCoord - vec2(0.5);
          float distance = min(1.0, length(offset) * 2.0);
          return vec4(color.rgb * (1.0 - distance * distance * amount * 0.8), color.a);
        }`,
      uniforms: (params) => ({ amount: (params.amount ?? 100) / 100 }),
    },
  },
  {
    id: "invert",
    title: "Invert (Инверсия)",
    defaults: {},
    cpu: catalogCpu("invert"),
    gpu: {
      glsl: `vec4 filterPixel(vec4 color) { return vec4(1.0 - color.rgb, color.a); }`,
      uniforms: () => ({}),
    },
  },
  {
    id: "grayscale",
    title: "Grayscale (Оттенки серого)",
    defaults: {},
    cpu: catalogCpu("grayscale"),
    gpu: {
      glsl: `
        vec4 filterPixel(vec4 color) {
          float luma = dot(color.rgb, vec3(0.30, 0.59, 0.11));
          return vec4(vec3(luma), color.a);
        }`,
      uniforms: () => ({}),
    },
  },
  {
    id: "gaussian_blur",
    title: "Gaussian Blur (Размытие по Гауссу)",
    defaults: { radius: 2 },
    cpu: catalogCpu("gaussian_blur"),
    // Separable: a horizontal pass then a vertical one, which is why the radius matters
    // to the dirty rectangle.
    kernelRadius: (params) => Math.max(1, params.radius ?? 2),
    gpu: {
      passes: 2,
      preferred: false,
      glsl: `
        vec4 filterPixel(vec4 color) {
          vec2 step = direction * texelSize;
          vec4 total = vec4(0.0);
          float weightSum = 0.0;
          for (int i = -16; i <= 16; i++) {
            float offset = float(i);
            if (abs(offset) > radius) continue;
            float weight = exp(-(offset * offset) / (2.0 * radius * radius + 0.001));
            total += texture(sourceTexture, texCoord + step * offset) * weight;
            weightSum += weight;
          }
          return total / max(weightSum, 0.001);
        }`,
      uniforms: (params, pass) => ({ radius: Math.max(1, Math.min(16, params.radius ?? 2)), direction: pass === 0 ? [1, 0] : [0, 1] }),
    },
  },
];

export const filterSpecById = new Map(filterSpecs.map((spec) => [spec.id, spec]));

/** True when a shader exists and is expected to beat the CPU implementation. */
export function hasGpuFilter(id: string): boolean {
  const gpu = filterSpecById.get(id)?.gpu;
  return Boolean(gpu?.glsl) && gpu?.preferred !== false;
}

export { passthroughVertexNote };
