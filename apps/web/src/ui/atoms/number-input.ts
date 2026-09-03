/**
 * Everything a numeric field does, as pure functions.
 *
 * The component around this (NumberBox.tsx) is deliberately a thin wiring
 * layer: events in, one of these functions, `onChange` out. Editors put a
 * great deal of behaviour into a number field — typing, arrow keys, the
 * wheel, scrubby dragging, unit suffixes, modifier-scaled steps — and none
 * of that is worth testing through a rendered DOM. This repository has no
 * jsdom or testing-library and adding them to a browser app for one widget
 * is not a trade worth making, so the behaviour lives here where a plain
 * unit test reaches all of it, and the component is small enough to verify
 * by using it.
 */

export interface NumberFieldSpec {
  readonly min?: number | undefined;
  readonly max?: number | undefined;
  /** The value one arrow press or one dragged pixel moves. Defaults to 1. */
  readonly step?: number | undefined;
  /** The unit the field itself is in — "px", "%", "°", or nothing. */
  readonly unit?: string | undefined;
  /**
   * Resolution used to turn a typed length ("2 cm") into pixels. Only
   * consulted for a field whose own unit is px; without it a typed length
   * has no defined pixel value, so the suffix is ignored rather than
   * guessed at.
   */
  readonly pixelsPerInch?: number | undefined;
}

export interface StepModifiers {
  readonly shiftKey?: boolean | undefined;
  readonly altKey?: boolean | undefined;
}

/**
 * How many inches one of each length unit is.
 *
 * Photoshop accepts a unit suffix in any numeric field and converts it
 * against the document's resolution; typing "2 cm" into a pixel field is a
 * normal thing to do when laying out for print. Russian spellings are here
 * because the interface is bilingual and a Russian-speaking user typing
 * "2 см" means exactly the same thing.
 */
const INCHES_PER_UNIT: Readonly<Record<string, number>> = {
  in: 1, inch: 1, inches: 1, "\"": 1, "″": 1, дюйм: 1, дюйма: 1, дюймов: 1,
  cm: 1 / 2.54, см: 1 / 2.54,
  mm: 1 / 25.4, мм: 1 / 25.4,
  pt: 1 / 72, пт: 1 / 72,
  pc: 1 / 6,
};

const PIXEL_UNITS = new Set(["px", "пикс", "пиксель", "пикселя", "пикселей", "пиксели"]);

/** Decimal places implied by a step, so 0.1 + 0.2 never shows up as 0.30000000000000004. */
function precisionOf(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0;
  const text = String(step);
  const dot = text.indexOf(".");
  if (dot < 0) return 0;
  return Math.min(6, text.length - dot - 1);
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function clampToSpec(value: number, spec: NumberFieldSpec): number {
  let result = value;
  if (spec.min !== undefined) result = Math.max(spec.min, result);
  if (spec.max !== undefined) result = Math.min(spec.max, result);
  return result;
}

/**
 * The amount one arrow press, one wheel notch or one dragged pixel moves.
 *
 * Photoshop's convention: Shift multiplies by ten, and a finer grain is
 * available for precise work. Both are here rather than in the component so
 * a wheel event and a drag cannot drift apart on what "one step" means.
 */
export function stepFor(spec: NumberFieldSpec, modifiers: StepModifiers = {}): number {
  const base = spec.step && spec.step > 0 ? spec.step : 1;
  if (modifiers.shiftKey) return base * 10;
  if (modifiers.altKey) return base / 10;
  return base;
}

/**
 * Reads what the user typed, including a unit suffix.
 *
 * Returns null for anything that is not a number, which the caller treats as
 * "keep what was there" rather than as zero — a field that silently becomes
 * 0 when a keystroke lands wrong loses work.
 */
export function parseNumericInput(raw: string, spec: NumberFieldSpec = {}): number | null {
  const trimmed = raw.trim().replace(",", ".");
  if (!trimmed) return null;

  const match = trimmed.match(/^([+-]?\d*\.?\d+)\s*(.*)$/);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;

  const suffix = (match[2] ?? "").trim().toLocaleLowerCase();
  const step = spec.step && spec.step > 0 ? spec.step : 1;

  // A suffix only means something when the field is in pixels and the
  // resolution to convert against is known. Anywhere else — an angle, a
  // percentage, a field with no unit — the number is taken and the suffix
  // ignored, because converting a length into degrees has no meaning and
  // guessing at one would be worse than not reacting to it at all.
  if (suffix && spec.unit === "px" && spec.pixelsPerInch) {
    if (PIXEL_UNITS.has(suffix)) return roundTo(clampToSpec(amount, spec), precisionOf(step));
    const inches = INCHES_PER_UNIT[suffix];
    if (inches !== undefined) {
      return roundTo(clampToSpec(amount * inches * spec.pixelsPerInch, spec), precisionOf(step));
    }
  }

  return roundTo(clampToSpec(amount, spec), precisionOf(step));
}

/** One arrow press or wheel notch. `direction` is +1 up, -1 down. */
export function applyStep(value: number, direction: number, spec: NumberFieldSpec, modifiers: StepModifiers = {}): number {
  const step = stepFor(spec, modifiers);
  const moved = value + Math.sign(direction) * step;
  return roundTo(clampToSpec(moved, spec), precisionOf(step));
}

/**
 * A scrubby drag, from where it started rather than from the last frame.
 *
 * Accumulating frame by frame would let rounding drift over a long drag —
 * the value ends up somewhere the pointer does not explain. Measuring from
 * the value the drag started on keeps the pointer and the number in step,
 * and makes releasing and re-grabbing behave the same as one long drag.
 *
 * Up increases, which is why the delta is negated: screen Y grows downward.
 */
export function applyDrag(startValue: number, deltaY: number, spec: NumberFieldSpec, modifiers: StepModifiers = {}): number {
  const step = stepFor(spec, modifiers);
  const moved = startValue + -deltaY * step;
  return roundTo(clampToSpec(moved, spec), precisionOf(step));
}

/** How the value is shown, without float dust from repeated stepping. */
export function formatNumber(value: number, spec: NumberFieldSpec = {}): string {
  const step = spec.step && spec.step > 0 ? spec.step : 1;
  return String(roundTo(value, precisionOf(step)));
}
