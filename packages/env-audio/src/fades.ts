/**
 * Fade curve generation — ported from waveform-playlist's `packages/core/src/fades.ts` (MIT).
 * Pure `Float32Array` curve generators only; applying a curve to a live `AudioParam` (the
 * donor's `applyFadeIn`/`applyFadeOut`) is a Web Audio API concern and lives in
 * `apps/web/src/audioPlayback.ts` instead — this package stays free of DOM/browser types so it
 * can run under a plain Node test runner, the same boundary `env-raster`/`env-vector` keep.
 */
import type { FadeType } from "./types";

export function linearCurve(length: number, fadeIn: boolean): Float32Array {
  const curve = new Float32Array(length);
  const scale = Math.max(1, length - 1);
  for (let i = 0; i < length; i += 1) {
    const x = i / scale;
    curve[i] = fadeIn ? x : 1 - x;
  }
  return curve;
}

export function exponentialCurve(length: number, fadeIn: boolean): Float32Array {
  const curve = new Float32Array(length);
  const scale = Math.max(1, length - 1);
  for (let i = 0; i < length; i += 1) {
    const x = i / scale;
    const index = fadeIn ? i : length - 1 - i;
    curve[index] = Math.exp(2 * x - 1) / Math.E;
  }
  return curve;
}

export function sCurveCurve(length: number, fadeIn: boolean): Float32Array {
  const curve = new Float32Array(length);
  const phase = fadeIn ? Math.PI / 2 : -Math.PI / 2;
  for (let i = 0; i < length; i += 1) curve[i] = Math.sin((Math.PI * i) / length - phase) / 2 + 0.5;
  return curve;
}

export function logarithmicCurve(length: number, fadeIn: boolean, base = 10): Float32Array {
  const curve = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const index = fadeIn ? i : length - 1 - i;
    const x = i / length;
    curve[index] = Math.log(1 + base * x) / Math.log(1 + base);
  }
  return curve;
}

export function generateCurve(type: FadeType, length: number, fadeIn: boolean): Float32Array {
  if (length <= 0) return new Float32Array(0);
  switch (type) {
    case "exponential": return exponentialCurve(length, fadeIn);
    case "sCurve": return sCurveCurve(length, fadeIn);
    case "logarithmic": return logarithmicCurve(length, fadeIn);
    default: return linearCurve(length, fadeIn);
  }
}

/**
 * The per-sample gain multiplier a clip should carry at `sampleIndex` samples into its own
 * duration, given its fade-in/fade-out lengths — used both by the offline mixdown renderer
 * (`mixdown.ts`) and, indirectly, by the live playback engine's curve-based `AudioParam`
 * automation (which needs the same curve, just fed to `setValueCurveAtTime` instead of
 * multiplied sample-by-sample).
 */
export function fadeGainAt(sampleIndex: number, durationSamples: number, fadeInSamples: number, fadeOutSamples: number, fadeType: FadeType): number {
  if (fadeInSamples > 0 && sampleIndex < fadeInSamples) {
    const curve = generateCurve(fadeType, fadeInSamples, true);
    return curve[Math.min(sampleIndex, curve.length - 1)] ?? 1;
  }
  const fadeOutStart = durationSamples - fadeOutSamples;
  if (fadeOutSamples > 0 && sampleIndex >= fadeOutStart) {
    const curve = generateCurve(fadeType, fadeOutSamples, false);
    const index = sampleIndex - fadeOutStart;
    return curve[Math.min(index, curve.length - 1)] ?? 0;
  }
  return 1;
}
