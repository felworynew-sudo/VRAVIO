/**
 * Destructive per-clip effects — the "AudioMass" phase of docs/master-plan.md §9.2, applied to
 * whichever clip window a caller passes in (the audible portion, `offsetSamples ..
 * offsetSamples + durationSamples`, not the whole decoded source), producing a new set of
 * channel buffers a caller re-encodes to WAV and commits as a new asset revision.
 *
 * Split the same way `env-raster`'s filters are: a flat declarative catalog (parameters, one
 * source of truth for the UI, mirrors `filters.ts`'s `rasterFilterCatalog`) plus pure sample
 * math here for everything that needs no browser API. `normalize`/`reverse`/`speed`/`pitch`/
 * `repair` are portable; `eq`/`compressor`/`reverb`/`delay` are declared in the same catalog
 * (so the UI lists all nine in one place) but their *processing* lives in
 * `apps/web/src/audioEffects.ts`, since AudioMass itself implements them with native Web Audio
 * nodes (`DynamicsCompressorNode`, `ConvolverNode`, `DelayNode`, `BiquadFilterNode`) rendered
 * through an `OfflineAudioContext` — there is no portable, DOM-free equivalent worth
 * reinventing when the browser already has a correct, fast one.
 */

export type AudioEffectId = "normalize" | "reverse" | "speed" | "pitch" | "repair" | "eq" | "compressor" | "reverb" | "delay";
export interface AudioEffectParamDef { readonly id: string; readonly name: string; readonly min: number; readonly max: number; readonly step: number; readonly value: number }
export interface AudioEffectDefinition { readonly id: AudioEffectId; readonly name: string; readonly portable: boolean; readonly parameters: readonly AudioEffectParamDef[] }

export const audioEffectCatalog: readonly AudioEffectDefinition[] = [
  { id: "normalize", name: "Normalize (Нормализация)", portable: true, parameters: [
    { id: "mode", name: "Method: 0=Peak, 1=RMS (Метод: 0=Пик, 1=RMS)", min: 0, max: 1, step: 1, value: 0 },
    { id: "linked", name: "Linked channels (Связанные каналы)", min: 0, max: 1, step: 1, value: 1 },
    { id: "targetDb", name: "Target dBFS (Цель, дБФШ)", min: -60, max: 0, step: 0.5, value: -1 },
  ] },
  { id: "reverse", name: "Reverse (Реверс)", portable: true, parameters: [] },
  { id: "speed", name: "Change Speed (Изменить скорость)", portable: true, parameters: [
    { id: "rate", name: "Rate (Скорость)", min: 0.25, max: 4, step: 0.05, value: 1 },
  ] },
  { id: "pitch", name: "Change Pitch (Изменить высоту тона)", portable: true, parameters: [
    { id: "semitones", name: "Semitones (Полутоны)", min: -12, max: 12, step: 0.5, value: 0 },
  ] },
  { id: "repair", name: "Repair Click (Устранить щелчок)", portable: true, parameters: [
    { id: "startSample", name: "Start sample (Начальный сэмпл)", min: 0, max: 1e9, step: 1, value: 0 },
    { id: "endSample", name: "End sample (Конечный сэмпл)", min: 0, max: 1e9, step: 1, value: 0 },
  ] },
  { id: "eq", name: "Equalizer (Эквалайзер)", portable: false, parameters: [
    { id: "lowGainDb", name: "Low shelf dB (Низкие, дБ)", min: -24, max: 24, step: 0.5, value: 0 },
    { id: "midGainDb", name: "Mid peak dB (Средние, дБ)", min: -24, max: 24, step: 0.5, value: 0 },
    { id: "midFreqHz", name: "Mid frequency Hz (Частота средних, Гц)", min: 200, max: 8000, step: 10, value: 1000 },
    { id: "highGainDb", name: "High shelf dB (Высокие, дБ)", min: -24, max: 24, step: 0.5, value: 0 },
  ] },
  { id: "compressor", name: "Compressor (Компрессор)", portable: false, parameters: [
    { id: "thresholdDb", name: "Threshold dB (Порог, дБ)", min: -60, max: 0, step: 1, value: -24 },
    { id: "ratio", name: "Ratio (Соотношение)", min: 1, max: 20, step: 0.5, value: 4 },
    { id: "attackMs", name: "Attack ms (Атака, мс)", min: 0, max: 200, step: 1, value: 3 },
    { id: "releaseMs", name: "Release ms (Спад, мс)", min: 10, max: 1000, step: 10, value: 250 },
    { id: "kneeDb", name: "Knee dB (Колено, дБ)", min: 0, max: 40, step: 1, value: 30 },
  ] },
  { id: "reverb", name: "Reverb (Реверберация)", portable: false, parameters: [
    { id: "decaySeconds", name: "Decay seconds (Затухание, с)", min: 0.2, max: 8, step: 0.1, value: 2 },
    { id: "mix", name: "Wet mix 0..1 (Доля эффекта)", min: 0, max: 1, step: 0.01, value: 0.3 },
  ] },
  { id: "delay", name: "Delay (Задержка)", portable: false, parameters: [
    { id: "delaySeconds", name: "Delay seconds (Задержка, с)", min: 0.01, max: 2, step: 0.01, value: 0.3 },
    { id: "feedback", name: "Feedback 0..1 (Обратная связь)", min: 0, max: 0.95, step: 0.01, value: 0.35 },
    { id: "mix", name: "Wet mix 0..1 (Доля эффекта)", min: 0, max: 1, step: 0.01, value: 0.3 },
  ] },
];

export function audioEffectDefaults(id: AudioEffectId): Record<string, number> {
  const definition = audioEffectCatalog.find((item) => item.id === id);
  const params: Record<string, number> = {};
  for (const parameter of definition?.parameters ?? []) params[parameter.id] = parameter.value;
  return params;
}

function paramOr(params: Record<string, number>, key: string, fallback: number): number {
  const value = params[key];
  return Number.isFinite(value) ? value! : fallback;
}

// --- Reverse -------------------------------------------------------------------------------

export function reverseChannels(channelData: readonly Float32Array[]): Float32Array[] {
  return channelData.map((channel) => Float32Array.from(channel).reverse());
}

// --- Normalize -------------------------------------------------------------------------------

function dbToLinear(db: number): number { return 10 ** (db / 20); }

/**
 * Peak or RMS normalization, ported from AudioMass's `peakNormalizeStats`/`rmsNormalizeStats`
 * gain math (`src/actions.js`) — peak mode scales so the loudest sample hits the target level,
 * RMS mode scales so the average loudness does, both clamped so a transient never clips past
 * 0 dBFS. `linked`: one gain computed from the loudest/loudest-average channel and applied to
 * all channels (preserves stereo balance) vs an independent gain per channel.
 */
export function normalizeChannels(channelData: readonly Float32Array[], params: Record<string, number>): Float32Array[] {
  const mode = paramOr(params, "mode", 0), linked = paramOr(params, "linked", 1) !== 0;
  const targetLinear = dbToLinear(paramOr(params, "targetDb", -1));

  const perChannel = channelData.map((channel) => {
    let peak = 0, sumSquares = 0;
    for (let i = 0; i < channel.length; i += 1) { const value = Math.abs(channel[i]!); if (value > peak) peak = value; sumSquares += channel[i]! * channel[i]!; }
    return { peak, rms: Math.sqrt(sumSquares / Math.max(1, channel.length)) };
  });

  const globalPeak = Math.max(0, ...perChannel.map((stats) => stats.peak));
  const globalRms = Math.sqrt(perChannel.reduce((sum, stats) => sum + stats.rms * stats.rms, 0) / Math.max(1, perChannel.length));

  const gainFor = (index: number): number => {
    const stats = perChannel[index]!;
    const reference = mode === 0 ? (linked ? globalPeak : stats.peak) : (linked ? globalRms : stats.rms);
    if (reference <= 0) return 1;
    let gain = targetLinear / reference;
    // Never let RMS-mode gain push a channel's own peak past 0 dBFS, even though the target is
    // measured on the average, not the loudest sample.
    if (mode === 1 && stats.peak > 0 && gain * stats.peak > 1) gain = 1 / stats.peak;
    return gain;
  };

  return channelData.map((channel, index) => {
    const gain = gainFor(index);
    const output = new Float32Array(channel.length);
    for (let i = 0; i < channel.length; i += 1) output[i] = channel[i]! * gain;
    return output;
  });
}

// --- Repair (click removal) ------------------------------------------------------------------

/**
 * Replaces `[startSample, endSample)` with a straight-line interpolation between the samples
 * just outside the range — the simplest real fix for a short click/pop/dropout, the same
 * technique every "repair" tool falls back to for a gap too short to have its own spectral
 * content worth reconstructing (a longer gap needs an actual inpainting model, out of scope
 * here). Silently no-ops on an empty or out-of-range window rather than throwing, since a
 * caller driving this from a live pixel/sample selection can easily hand over an empty one.
 */
export function repairRange(channelData: readonly Float32Array[], params: Record<string, number>): Float32Array[] {
  const start = Math.max(0, Math.floor(paramOr(params, "startSample", 0)));
  const end = Math.max(start, Math.floor(paramOr(params, "endSample", 0)));
  return channelData.map((channel) => {
    const output = Float32Array.from(channel);
    const clampedEnd = Math.min(end, output.length);
    if (start >= clampedEnd) return output;
    const before = output[Math.max(0, start - 1)] ?? 0;
    const after = output[Math.min(output.length - 1, clampedEnd)] ?? before;
    const span = clampedEnd - start + 1;
    for (let i = start; i < clampedEnd; i += 1) {
      const t = (i - start + 1) / span;
      output[i] = before + (after - before) * t;
    }
    return output;
  });
}

// --- Speed (resample; duration and pitch change together) ------------------------------------

function resampleLinear(channel: Float32Array, rate: number): Float32Array {
  const outputLength = Math.max(1, Math.round(channel.length / rate));
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i += 1) {
    const position = i * rate;
    const index = Math.floor(position), frac = position - index;
    const a = channel[index] ?? 0, b = channel[index + 1] ?? a;
    output[i] = a + (b - a) * frac;
  }
  return output;
}

/** `rate > 1` speeds up (and raises pitch); `rate < 1` slows down (and lowers pitch) — the same
 * combined effect AudioMass's own `Speed` produces via `AudioBufferSourceNode.playbackRate`. */
export function changeSpeed(channelData: readonly Float32Array[], params: Record<string, number>): Float32Array[] {
  const rate = Math.max(0.05, Math.min(4, paramOr(params, "rate", 1)));
  return channelData.map((channel) => resampleLinear(channel, rate));
}

// --- Pitch (resample + overlap-add time-stretch back to the original duration) ---------------

function hannWindow(length: number): Float32Array {
  const window = new Float32Array(length);
  for (let i = 0; i < length; i += 1) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / Math.max(1, length - 1));
  return window;
}

/**
 * Simple overlap-add time-stretch: resamples to shift pitch by `ratio` (which also changes
 * duration), then stretches the duration back by `1 / ratio` using fixed-size, Hann-windowed
 * grains — the standard "cheap" OLA algorithm, not a phase vocoder. Good enough for a moderate
 * pitch change on melodic/vocal material; audible warbling on strongly tonal, sustained
 * content is the known limitation of OLA without phase correction (a real phase vocoder, or
 * the master-plan's own named donor for this — Signalsmith Stretch — is the upgrade path).
 */
function overlapAddStretch(channel: Float32Array, stretch: number): Float32Array {
  if (channel.length === 0) return new Float32Array(0);
  const grainSize = 2048, hopAnalysis = Math.floor(grainSize / 4);
  const hopSynthesis = Math.max(1, Math.round(hopAnalysis * stretch));
  const window = hannWindow(grainSize);
  const outputLength = Math.max(1, Math.round(channel.length * stretch));
  const output = new Float32Array(outputLength + grainSize);
  const weight = new Float32Array(outputLength + grainSize);

  for (let readPos = 0, writePos = 0; readPos < channel.length; readPos += hopAnalysis, writePos += hopSynthesis) {
    for (let i = 0; i < grainSize; i += 1) {
      const sample = channel[readPos + i] ?? 0;
      output[writePos + i]! += sample * window[i]!;
      weight[writePos + i]! += window[i]!;
    }
  }
  for (let i = 0; i < output.length; i += 1) if (weight[i]! > 1e-6) output[i]! /= weight[i]!;
  return output.slice(0, outputLength);
}

/** `semitones > 0` raises pitch, `< 0` lowers it, duration is preserved. */
export function shiftPitch(channelData: readonly Float32Array[], params: Record<string, number>): Float32Array[] {
  const semitones = Math.max(-24, Math.min(24, paramOr(params, "semitones", 0)));
  if (semitones === 0) return channelData.map((channel) => Float32Array.from(channel));
  const ratio = 2 ** (semitones / 12);
  return channelData.map((channel) => {
    const resampled = resampleLinear(channel, ratio);
    const stretched = overlapAddStretch(resampled, channel.length / Math.max(1, resampled.length));
    // Overlap-add's own length rounding can land a handful of samples off the source length —
    // trimmed/padded so every channel of a multi-channel clip comes back the same length.
    if (stretched.length === channel.length) return stretched;
    const fitted = new Float32Array(channel.length);
    fitted.set(stretched.subarray(0, Math.min(stretched.length, channel.length)));
    return fitted;
  });
}

// --- Dispatch ----------------------------------------------------------------------------

/** Applies a portable (browser-free) effect; returns `null` for `eq`/`compressor`/`reverb`/
 * `delay`, which need `apps/web/src/audioEffects.ts`'s `OfflineAudioContext`-based renderer. */
export function applyPortableAudioEffect(channelData: readonly Float32Array[], id: AudioEffectId, params: Record<string, number>): Float32Array[] | null {
  switch (id) {
    case "reverse": return reverseChannels(channelData);
    case "normalize": return normalizeChannels(channelData, params);
    case "repair": return repairRange(channelData, params);
    case "speed": return changeSpeed(channelData, params);
    case "pitch": return shiftPitch(channelData, params);
    default: return null;
  }
}
