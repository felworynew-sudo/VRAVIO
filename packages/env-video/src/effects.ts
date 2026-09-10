/**
 * Non-destructive per-clip video effects (docs/master-plan.md §33.3's "Эффекты" panel: drop on a
 * clip creates a non-destructive effect stack in the Inspector). Split the same way
 * `env-audio/src/effects.ts` splits its own catalog: a flat declarative list here (parameters,
 * one source of truth for the UI) plus, for effects that map directly onto a CSS/Canvas2D
 * `filter` function, the math needed to build that filter string — the browser's own
 * `CanvasRenderingContext2D.filter` already implements a correct, fast, composited pipeline for
 * exactly this class of effect (brightness/contrast/saturation/blur/hue/etc.), so there is no
 * portable pixel-math worth reinventing, the same reasoning `env-audio`'s own eq/compressor/
 * reverb/delay effects give for staying non-portable and living in `apps/web` instead.
 */

export type VideoEffectId = "brightness" | "contrast" | "saturation" | "blur" | "grayscale" | "sepia" | "invert" | "hueRotate";
export interface VideoEffectParamDef { readonly id: string; readonly name: string; readonly min: number; readonly max: number; readonly step: number; readonly value: number }
export interface VideoEffectDefinition { readonly id: VideoEffectId; readonly name: string; readonly parameters: readonly VideoEffectParamDef[] }

export const videoEffectCatalog: readonly VideoEffectDefinition[] = [
  { id: "brightness", name: "Brightness (Яркость)", parameters: [
    { id: "amount", name: "Amount % (Величина, %)", min: 0, max: 300, step: 1, value: 100 },
  ] },
  { id: "contrast", name: "Contrast (Контраст)", parameters: [
    { id: "amount", name: "Amount % (Величина, %)", min: 0, max: 300, step: 1, value: 100 },
  ] },
  { id: "saturation", name: "Saturation (Насыщенность)", parameters: [
    { id: "amount", name: "Amount % (Величина, %)", min: 0, max: 300, step: 1, value: 100 },
  ] },
  { id: "blur", name: "Blur (Размытие)", parameters: [
    { id: "pixels", name: "Radius px (Радиус, пикс)", min: 0, max: 40, step: 0.5, value: 0 },
  ] },
  { id: "grayscale", name: "Grayscale (Ч/Б)", parameters: [
    { id: "amount", name: "Amount % (Величина, %)", min: 0, max: 100, step: 1, value: 100 },
  ] },
  { id: "sepia", name: "Sepia (Сепия)", parameters: [
    { id: "amount", name: "Amount % (Величина, %)", min: 0, max: 100, step: 1, value: 100 },
  ] },
  { id: "invert", name: "Invert (Инверсия)", parameters: [
    { id: "amount", name: "Amount % (Величина, %)", min: 0, max: 100, step: 1, value: 100 },
  ] },
  { id: "hueRotate", name: "Hue Rotate (Сдвиг тона)", parameters: [
    { id: "degrees", name: "Degrees ° (Градусы)", min: 0, max: 360, step: 1, value: 0 },
  ] },
];

export function videoEffectDefaults(id: VideoEffectId): Record<string, number> {
  const definition = videoEffectCatalog.find((item) => item.id === id);
  const params: Record<string, number> = {};
  for (const parameter of definition?.parameters ?? []) params[parameter.id] = parameter.value;
  return params;
}

function paramOr(params: Record<string, number>, key: string, fallback: number): number {
  const value = params[key];
  return Number.isFinite(value) ? value! : fallback;
}

/** The full CSS `filter` string for a clip's effect stack — every enabled insert's own fragment,
 * in stack order, joined for a single `CanvasRenderingContext2D.filter` assignment. `"none"` for
 * an empty or fully-bypassed stack, `filter`'s own explicit "no-op" value (an empty string is
 * also valid CSS but `"none"` reads unambiguously in a debugger). */
export function videoClipFilterString(effects: readonly { readonly effectId: VideoEffectId; readonly params: Record<string, number>; readonly enabled: boolean }[]): string {
  const fragments = effects.filter((effect) => effect.enabled).map((effect) => videoEffectCssFragment(effect.effectId, effect.params));
  return fragments.length ? fragments.join(" ") : "none";
}

/** One insert's own `filter` fragment — composed left-to-right into the clip's full filter
 * string by `videoClipFilterString` below, the same "stack of inserts" model
 * `AudioTrackEffect`'s realtime chain uses, just expressed as CSS filter functions instead of
 * Web Audio nodes since Canvas2D already applies them in the order given. */
export function videoEffectCssFragment(effectId: VideoEffectId, params: Record<string, number>): string {
  switch (effectId) {
    case "brightness": return `brightness(${paramOr(params, "amount", 100) / 100})`;
    case "contrast": return `contrast(${paramOr(params, "amount", 100) / 100})`;
    case "saturation": return `saturate(${paramOr(params, "amount", 100) / 100})`;
    case "blur": return `blur(${Math.max(0, paramOr(params, "pixels", 0))}px)`;
    case "grayscale": return `grayscale(${paramOr(params, "amount", 100) / 100})`;
    case "sepia": return `sepia(${paramOr(params, "amount", 100) / 100})`;
    case "invert": return `invert(${paramOr(params, "amount", 100) / 100})`;
    case "hueRotate": return `hue-rotate(${paramOr(params, "degrees", 0)}deg)`;
  }
}
