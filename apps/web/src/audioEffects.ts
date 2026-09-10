import { applyPortableAudioEffect, volumeAt, type AudioEffectId, type AudioTrackEffect, type AutomationPoint } from "@vravio/env-audio";

/** Which of each realtime effect's own parameters can carry an automation lane — the plain-data
 * mirror of each builder's own `automatable` map below (`EffectChain`'s doc comment explains why
 * `mix`/`decaySeconds` are absent), kept separate so `AudioWorkspace.tsx`'s effect panel can ask
 * "does this parameter support automation" without instantiating a Web Audio graph just to find
 * out. Reverb has no entry — nothing on it is automatable in this pass. */
export const AUTOMATABLE_EFFECT_PARAMS: Readonly<Partial<Record<AudioEffectId, readonly string[]>>> = {
  eq: ["lowGainDb", "midGainDb", "midFreqHz", "highGainDb"],
  compressor: ["thresholdDb", "ratio", "attackMs", "releaseMs", "kneeDb"],
  delay: ["delaySeconds", "feedback"],
};

/**
 * The four `audioEffectCatalog` effects `applyPortableAudioEffect` returns `null` for — ported
 * from AudioMass's own node wiring (`src/actions.js`'s `Compressor`/`Delay`/`Reverb`, and the
 * peaking-biquad design `src/fx-pg-eq.js`'s parametric EQ widget builds on).
 *
 * Each effect is a *graph builder* (`context: BaseAudioContext -> {input, output}`), not tied
 * to any one context type — `BaseAudioContext` is the interface both `AudioContext` (live
 * playback, real-time — see `audioPlayback.ts`'s `buildLiveEffectChain`) and
 * `OfflineAudioContext` (`renderOffline` below, one-shot destructive "Apply") implement. One
 * builder, two callers: a `compressor` inserted live into a track's playback chain and a
 * `compressor` baked destructively into a clip's asset run through the exact same node-wiring
 * code, the same "one door" `commitPixels` already is for raster (CLAUDE.md section 4) — a
 * bug fixed in the graph shape fixes both places at once, and there is nothing to fix twice.
 */

function paramOr(params: Record<string, number>, key: string, fallback: number): number {
  const value = params[key];
  return Number.isFinite(value) ? value! : fallback;
}

/** One automatable control surfaced by an effect's own node graph — `param` is the real Web
 * Audio `AudioParam` a ramp gets scheduled onto (`audioPlayback.ts`'s `scheduleParamAutomation`),
 * `scale` converts this catalog's own UI units into whatever unit that `AudioParam` natively
 * uses (`attackMs`'s UI value in milliseconds needs `scale: 1/1000` to land on
 * `DynamicsCompressorNode.attack`'s seconds). Only listed here when a parameter maps to exactly
 * one real-time `AudioParam` — `mix` on delay/reverb couples two gain nodes in opposite
 * directions and `decaySeconds` would need rebuilding the reverb's whole impulse buffer, neither
 * of which a single ramp can express, so neither is automatable in this pass. */
export interface EffectChain {
  readonly input: AudioNode;
  readonly output: AudioNode;
  readonly automatable?: Readonly<Record<string, { readonly param: AudioParam; readonly scale: number }>>;
}

/** Three-band shelf/peak EQ — low-shelf, a peaking mid band, high-shelf, chained in series. A
 * smaller, fixed-band version of AudioMass's fully graphic parametric EQ (which lets a user
 * place an arbitrary number of peaking bands); three fixed bands cover the common "cut/boost
 * low, mid, high" case this project needs without building the graphic-EQ curve UI. */
export function buildEqChain(context: BaseAudioContext, params: Record<string, number>): EffectChain {
  const lowGainDb = paramOr(params, "lowGainDb", 0), midGainDb = paramOr(params, "midGainDb", 0);
  const midFreqHz = paramOr(params, "midFreqHz", 1000), highGainDb = paramOr(params, "highGainDb", 0);
  const low = context.createBiquadFilter(); low.type = "lowshelf"; low.frequency.value = 200; low.gain.value = lowGainDb;
  const mid = context.createBiquadFilter(); mid.type = "peaking"; mid.frequency.value = midFreqHz; mid.Q.value = 1; mid.gain.value = midGainDb;
  const high = context.createBiquadFilter(); high.type = "highshelf"; high.frequency.value = 4000; high.gain.value = highGainDb;
  low.connect(mid); mid.connect(high);
  return {
    input: low, output: high,
    automatable: { lowGainDb: { param: low.gain, scale: 1 }, midGainDb: { param: mid.gain, scale: 1 }, midFreqHz: { param: mid.frequency, scale: 1 }, highGainDb: { param: high.gain, scale: 1 } },
  };
}

/** Ported from AudioMass's `Compressor` — a native `DynamicsCompressorNode`; unlike AudioMass
 * this has no separate makeup-gain parameter (its own default UI leaves makeup at 0 dB too),
 * kept out of the catalog until a real need for it shows up. */
export function buildCompressorChain(context: BaseAudioContext, params: Record<string, number>): EffectChain {
  const compressor = context.createDynamicsCompressor();
  compressor.threshold.value = paramOr(params, "thresholdDb", -24);
  compressor.ratio.value = paramOr(params, "ratio", 4);
  compressor.attack.value = paramOr(params, "attackMs", 3) / 1000;
  compressor.release.value = paramOr(params, "releaseMs", 250) / 1000;
  compressor.knee.value = paramOr(params, "kneeDb", 30);
  return {
    input: compressor, output: compressor,
    automatable: {
      thresholdDb: { param: compressor.threshold, scale: 1 }, ratio: { param: compressor.ratio, scale: 1 },
      attackMs: { param: compressor.attack, scale: 1 / 1000 }, releaseMs: { param: compressor.release, scale: 1 / 1000 },
      kneeDb: { param: compressor.knee, scale: 1 },
    },
  };
}

/** Ported from AudioMass's `Delay` — input splits into a dry path and a delay+feedback loop,
 * both summed at the output. `mix` here is a plain 0=dry..1=wet crossfade (linear dry/wet gain
 * pair), a simpler convention than AudioMass's own 0.5-centered formula — the two are
 * equivalent at the middle value, and 0..1 as "how much effect" needs no explanation for a
 * default this catalog sets to 0.3, unlike AudioMass's own default of 0.5. */
export function buildDelayChain(context: BaseAudioContext, params: Record<string, number>): EffectChain {
  const delaySeconds = paramOr(params, "delaySeconds", 0.3), feedback = paramOr(params, "feedback", 0.35), mix = paramOr(params, "mix", 0.3);
  const input = context.createGain(), output = context.createGain();
  const dry = context.createGain(), wet = context.createGain(), feedbackGain = context.createGain();
  const delay = context.createDelay(2);
  delay.delayTime.value = Math.max(0.001, Math.min(2, delaySeconds));
  feedbackGain.gain.value = Math.max(0, Math.min(0.95, feedback));
  dry.gain.value = 1 - mix; wet.gain.value = mix;

  input.connect(dry); dry.connect(output);
  input.connect(delay); delay.connect(feedbackGain); feedbackGain.connect(delay);
  delay.connect(wet); wet.connect(output);
  return {
    input, output,
    // `mix` couples dry/wet in opposite directions, so it is not offered here — see EffectChain's
    // own doc comment on why only single-AudioParam controls are automatable in this pass.
    automatable: { delaySeconds: { param: delay.delayTime, scale: 1 }, feedback: { param: feedbackGain.gain, scale: 1 } },
  };
}

/** Ported from AudioMass's `Reverb` — a synthesized exponential-decay white-noise impulse fed
 * through a native `ConvolverNode`, the standard cheap algorithmic-reverb trick (no real
 * impulse-response sample library needed). */
export function buildReverbChain(context: BaseAudioContext, params: Record<string, number>): EffectChain {
  const decaySeconds = Math.max(0.01, paramOr(params, "decaySeconds", 2)), mix = paramOr(params, "mix", 0.3);
  const input = context.createGain(), output = context.createGain();
  const dry = context.createGain(), wet = context.createGain();
  const convolver = context.createConvolver();

  const impulseLength = Math.max(1, Math.round(context.sampleRate * decaySeconds));
  const impulse = context.createBuffer(2, impulseLength, context.sampleRate);
  for (let c = 0; c < 2; c += 1) {
    const data = impulse.getChannelData(c);
    for (let i = 0; i < impulseLength; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / impulseLength) ** 2;
  }
  convolver.buffer = impulse;
  dry.gain.value = 1 - mix; wet.gain.value = mix;

  input.connect(dry); dry.connect(output);
  input.connect(convolver); convolver.connect(wet); wet.connect(output);
  return { input, output };
}

function buildChain(context: BaseAudioContext, id: AudioEffectId, params: Record<string, number>): EffectChain {
  switch (id) {
    case "eq": return buildEqChain(context, params);
    case "compressor": return buildCompressorChain(context, params);
    case "delay": return buildDelayChain(context, params);
    case "reverb": return buildReverbChain(context, params);
    default: throw new RangeError(`${id} is a portable effect — use applyPortableAudioEffect`);
  }
}

async function renderOffline(channelData: readonly Float32Array[], sampleRate: number, id: AudioEffectId, params: Record<string, number>): Promise<Float32Array[]> {
  const length = channelData[0]?.length ?? 0;
  const context = new OfflineAudioContext(channelData.length, Math.max(1, length), sampleRate);
  const buffer = context.createBuffer(channelData.length, Math.max(1, length), sampleRate);
  for (let c = 0; c < channelData.length; c += 1) buffer.copyToChannel(Float32Array.from(channelData[c]!), c);
  const source = context.createBufferSource();
  source.buffer = buffer;
  const chain = buildChain(context, id, params);
  source.connect(chain.input); chain.output.connect(context.destination);
  source.start();
  const rendered = await context.startRendering();
  return Array.from({ length: rendered.numberOfChannels }, (_, c) => rendered.getChannelData(c).slice());
}

export async function applyNativeAudioEffect(channelData: readonly Float32Array[], sampleRate: number, id: AudioEffectId, params: Record<string, number>): Promise<Float32Array[]> {
  return renderOffline(channelData, sampleRate, id, params);
}

/** The one entry point a caller (the effects dialog) actually needs — tries the portable
 * (browser-free) implementation first, falls back to the native Web-Audio-graph one. */
export async function applyAudioEffect(channelData: readonly Float32Array[], sampleRate: number, id: AudioEffectId, params: Record<string, number>): Promise<Float32Array[]> {
  const portable = applyPortableAudioEffect(channelData, id, params);
  if (portable) return portable;
  return applyNativeAudioEffect(channelData, sampleRate, id, params);
}

/**
 * Schedules one `AudioParam` to follow an automation curve from `fromSample` onward — the same
 * shape `AudioPlaybackEngine.play()` already hand-wrote for track volume, extracted here so
 * effect-parameter automation (below) reuses it instead of a second copy of the same ramp math.
 * `setValueAtTime` for the curve's value exactly at the resume point, then a
 * `linearRampToValueAtTime` per later breakpoint — resuming mid-curve starts from where the
 * curve actually is, not from its first point. Falls straight to `.value = staticValue` (no
 * scheduling at all) when there is no curve, so an unautomated parameter costs nothing extra.
 */
export function scheduleParamRamp(param: AudioParam, points: readonly AutomationPoint[], staticValue: number, fromSample: number, sampleRate: number, now: number, scale = 1): void {
  if (points.length === 0) { param.value = staticValue * scale; return; }
  param.setValueAtTime(volumeAt(points, fromSample, staticValue) * scale, now);
  for (const point of points) {
    if (point.time <= fromSample) continue;
    param.linearRampToValueAtTime(point.value * scale, now + (point.time - fromSample) / sampleRate);
  }
}

/**
 * Chains every *enabled* track effect (in order) into one live insert — the realtime effect
 * stack, `docs/master-plan.md` §9.2's Audacity-4 phase. Only the four native effects can run
 * this way; a `portable: true` effect (normalize/reverse/speed/pitch/repair) is a one-shot
 * transform, not a continuous process a listener could "ride" in real time, so
 * `AudioTrackEffect`s pointing at one are skipped here (validated at the point they are added
 * to a track — see `audio-commands.ts`'s `addTrackEffect`).
 *
 * `automation` (optional) applies a per-parameter curve on top of each effect's static `params`
 * — keyed `${effectInstanceId}:${paramId}`, read against each chain's own `automatable` map
 * (`EffectChain`'s doc comment: only parameters that resolve to exactly one real `AudioParam`).
 * Omitted entirely (or an id with no curve) leaves that parameter at its plain static value,
 * exactly as before this feature existed — the same "an automation lane replaces the fader only
 * where it has data" rule `AudioTrack.volumeAutomation` already follows.
 */
export function buildLiveEffectChain(context: BaseAudioContext, effects: readonly AudioTrackEffect[], automation?: Readonly<Record<string, readonly AutomationPoint[]>>, timing?: { readonly fromSample: number; readonly sampleRate: number; readonly now: number }): EffectChain | null {
  const enabled = effects.filter((effect) => effect.enabled);
  if (enabled.length === 0) return null;
  const chains = enabled.map((effect) => {
    const chain = buildChain(context, effect.effectId, effect.params);
    if (automation && timing && chain.automatable) {
      for (const [paramId, target] of Object.entries(chain.automatable)) {
        const points = automation[`${effect.id}:${paramId}`];
        if (points && points.length > 0) scheduleParamRamp(target.param, points, effect.params[paramId] ?? 0, timing.fromSample, timing.sampleRate, timing.now, target.scale);
      }
    }
    return chain;
  });
  for (let i = 0; i < chains.length - 1; i += 1) chains[i]!.output.connect(chains[i + 1]!.input);
  return { input: chains[0]!.input, output: chains[chains.length - 1]!.output };
}
