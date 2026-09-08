import { applyPortableAudioEffect, type AudioEffectId } from "@vravio/env-audio";

/**
 * The four `audioEffectCatalog` effects `applyPortableAudioEffect` returns `null` for — ported
 * from AudioMass's own node wiring (`src/actions.js`'s `Compressor`/`Delay`/`Reverb`, and the
 * peaking-biquad design `src/fx-pg-eq.js`'s parametric EQ widget builds on), rendered through
 * an `OfflineAudioContext` rather than live playback: an effect here processes a clip's stored
 * audio once (destructively, into a new asset revision), not a knob a listener rides in real
 * time — matches how AudioMass itself renders "Apply Filter" through an offline render pass,
 * not through the live playback graph.
 */

function paramOr(params: Record<string, number>, key: string, fallback: number): number {
  const value = params[key];
  return Number.isFinite(value) ? value! : fallback;
}

async function renderOffline(channelData: readonly Float32Array[], sampleRate: number, build: (context: OfflineAudioContext, source: AudioBufferSourceNode) => void): Promise<Float32Array[]> {
  const length = channelData[0]?.length ?? 0;
  const context = new OfflineAudioContext(channelData.length, Math.max(1, length), sampleRate);
  const buffer = context.createBuffer(channelData.length, Math.max(1, length), sampleRate);
  for (let c = 0; c < channelData.length; c += 1) buffer.copyToChannel(Float32Array.from(channelData[c]!), c);
  const source = context.createBufferSource();
  source.buffer = buffer;
  build(context, source);
  source.start();
  const rendered = await context.startRendering();
  return Array.from({ length: rendered.numberOfChannels }, (_, c) => rendered.getChannelData(c).slice());
}

/** Three-band shelf/peak EQ — low-shelf, a peaking mid band, high-shelf, chained in series. A
 * smaller, fixed-band version of AudioMass's fully graphic parametric EQ (which lets a user
 * place an arbitrary number of peaking bands); three fixed bands cover the common "cut/boost
 * low, mid, high" case this project needs without building the graphic-EQ curve UI. */
async function applyEq(channelData: readonly Float32Array[], sampleRate: number, params: Record<string, number>): Promise<Float32Array[]> {
  const lowGainDb = paramOr(params, "lowGainDb", 0), midGainDb = paramOr(params, "midGainDb", 0);
  const midFreqHz = paramOr(params, "midFreqHz", 1000), highGainDb = paramOr(params, "highGainDb", 0);
  return renderOffline(channelData, sampleRate, (context, source) => {
    const low = context.createBiquadFilter(); low.type = "lowshelf"; low.frequency.value = 200; low.gain.value = lowGainDb;
    const mid = context.createBiquadFilter(); mid.type = "peaking"; mid.frequency.value = midFreqHz; mid.Q.value = 1; mid.gain.value = midGainDb;
    const high = context.createBiquadFilter(); high.type = "highshelf"; high.frequency.value = 4000; high.gain.value = highGainDb;
    source.connect(low); low.connect(mid); mid.connect(high); high.connect(context.destination);
  });
}

/** Ported from AudioMass's `Compressor` — a native `DynamicsCompressorNode` plus a makeup-gain
 * node; unlike AudioMass this has no separate makeup-gain parameter (its own default UI leaves
 * makeup at 0 dB too), kept out of the catalog until a real need for it shows up. */
async function applyCompressor(channelData: readonly Float32Array[], sampleRate: number, params: Record<string, number>): Promise<Float32Array[]> {
  const thresholdDb = paramOr(params, "thresholdDb", -24), ratio = paramOr(params, "ratio", 4);
  const attackMs = paramOr(params, "attackMs", 3), releaseMs = paramOr(params, "releaseMs", 250), kneeDb = paramOr(params, "kneeDb", 30);
  return renderOffline(channelData, sampleRate, (context, source) => {
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = thresholdDb;
    compressor.ratio.value = ratio;
    compressor.attack.value = attackMs / 1000;
    compressor.release.value = releaseMs / 1000;
    compressor.knee.value = kneeDb;
    source.connect(compressor); compressor.connect(context.destination);
  });
}

/** Ported from AudioMass's `Delay` — input splits into a dry path and a delay+feedback loop,
 * both summed at the output. `mix` here is a plain 0=dry..1=wet crossfade (linear dry/wet gain
 * pair), a simpler convention than AudioMass's own 0.5-centered formula — the two are
 * equivalent at the middle value, and 0..1 as "how much effect" needs no explanation for a
 * default this catalog sets to 0.3, unlike AudioMass's own default of 0.5. */
async function applyDelay(channelData: readonly Float32Array[], sampleRate: number, params: Record<string, number>): Promise<Float32Array[]> {
  const delaySeconds = paramOr(params, "delaySeconds", 0.3), feedback = paramOr(params, "feedback", 0.35), mix = paramOr(params, "mix", 0.3);
  return renderOffline(channelData, sampleRate, (context, source) => {
    const input = context.createGain(), output = context.createGain();
    const dry = context.createGain(), wet = context.createGain(), feedbackGain = context.createGain();
    const delay = context.createDelay(2);
    delay.delayTime.value = Math.max(0.001, Math.min(2, delaySeconds));
    feedbackGain.gain.value = Math.max(0, Math.min(0.95, feedback));
    dry.gain.value = 1 - mix; wet.gain.value = mix;

    source.connect(input);
    input.connect(dry); dry.connect(output);
    input.connect(delay); delay.connect(feedbackGain); feedbackGain.connect(delay);
    delay.connect(wet); wet.connect(output);
    output.connect(context.destination);
  });
}

/** Ported from AudioMass's `Reverb` — a synthesized exponential-decay white-noise impulse fed
 * through a native `ConvolverNode`, the standard cheap algorithmic-reverb trick (no real
 * impulse-response sample library needed). */
async function applyReverb(channelData: readonly Float32Array[], sampleRate: number, params: Record<string, number>): Promise<Float32Array[]> {
  const decaySeconds = Math.max(0.01, paramOr(params, "decaySeconds", 2)), mix = paramOr(params, "mix", 0.3);
  return renderOffline(channelData, sampleRate, (context, source) => {
    const input = context.createGain(), output = context.createGain();
    const dry = context.createGain(), wet = context.createGain();
    const convolver = context.createConvolver();

    const impulseLength = Math.max(1, Math.round(sampleRate * decaySeconds));
    const impulse = context.createBuffer(2, impulseLength, sampleRate);
    for (let c = 0; c < 2; c += 1) {
      const data = impulse.getChannelData(c);
      for (let i = 0; i < impulseLength; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / impulseLength) ** 2;
    }
    convolver.buffer = impulse;
    dry.gain.value = 1 - mix; wet.gain.value = mix;

    source.connect(input);
    input.connect(dry); dry.connect(output);
    input.connect(convolver); convolver.connect(wet); wet.connect(output);
    output.connect(context.destination);
  });
}

export async function applyNativeAudioEffect(channelData: readonly Float32Array[], sampleRate: number, id: AudioEffectId, params: Record<string, number>): Promise<Float32Array[]> {
  switch (id) {
    case "eq": return applyEq(channelData, sampleRate, params);
    case "compressor": return applyCompressor(channelData, sampleRate, params);
    case "delay": return applyDelay(channelData, sampleRate, params);
    case "reverb": return applyReverb(channelData, sampleRate, params);
    default: throw new RangeError(`${id} is a portable effect — use applyPortableAudioEffect`);
  }
}

/** The one entry point a caller (the effects dialog) actually needs — tries the portable
 * (browser-free) implementation first, falls back to the native Web-Audio-graph one. */
export async function applyAudioEffect(channelData: readonly Float32Array[], sampleRate: number, id: AudioEffectId, params: Record<string, number>): Promise<Float32Array[]> {
  const portable = applyPortableAudioEffect(channelData, id, params);
  if (portable) return portable;
  return applyNativeAudioEffect(channelData, sampleRate, id, params);
}
