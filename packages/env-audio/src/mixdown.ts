import { fadeGainAt } from "./fades";
import { timelineDurationSamples } from "./document";
import type { AudioDocumentState } from "./types";
import type { DecodedWav } from "./wav";

export type AudioSourceLookup = (assetId: string) => DecodedWav | undefined;

/** Linear-interpolated sample read — good enough for scrub/preview and for a first mixdown
 * pass; a proper resampler (windowed sinc) is real DSP work the master-plan explicitly stages
 * for later (Signalsmith Stretch is the named donor for high-quality time/pitch work). */
function sampleAt(channel: Float32Array, position: number): number {
  const index = Math.floor(position), frac = position - index;
  const a = channel[index] ?? 0, b = channel[index + 1] ?? a;
  return a + (b - a) * frac;
}

/** Equal-power pan law: -1 (left) .. 0 (center) .. 1 (right). */
function panGains(pan: number): { left: number; right: number } {
  const clamped = Math.max(-1, Math.min(1, pan));
  const angle = ((clamped + 1) * Math.PI) / 4;
  return { left: Math.cos(angle), right: Math.sin(angle) };
}

export interface MixdownOptions {
  /** Output sample rate; defaults to the document's own. */
  readonly sampleRate?: number;
}

/**
 * Renders the whole timeline to one `Float32Array` per output channel — the engine behind both
 * "Mixdown" and "WAV export" in the master-plan's v0.1 checklist. Pure and offline: no
 * `AudioContext`, so it is exactly as testable as `compositeRasterDocument` is for pixels.
 *
 * Mute/solo: a soloed track silences every non-soloed track, matching every DAW's own
 * convention (solo is "listen to only this," not "additionally include this").
 */
export function mixdownAudioDocument(state: AudioDocumentState, lookup: AudioSourceLookup, options: MixdownOptions = {}): Float32Array[] {
  const sampleRate = options.sampleRate ?? state.sampleRate;
  const scale = sampleRate / state.sampleRate;
  const outputLength = Math.max(1, Math.ceil(timelineDurationSamples(state) * scale));
  const channels = state.channels;
  const output: Float32Array[] = Array.from({ length: channels }, () => new Float32Array(outputLength));

  const anySoloed = state.tracks.some((track) => track.soloed);

  for (const track of state.tracks) {
    if (track.muted) continue;
    if (anySoloed && !track.soloed) continue;
    const { left: panLeft, right: panRight } = panGains(track.pan);

    for (const clip of track.clips) {
      const source = lookup(clip.assetId);
      if (!source) continue;
      const sourceRatio = clip.sourceSampleRate / sampleRate;
      const clipStartOut = Math.round(clip.startSample * scale);
      const clipDurationOut = Math.round(clip.durationSamples * scale);

      for (let i = 0; i < clipDurationOut; i += 1) {
        const outIndex = clipStartOut + i;
        if (outIndex < 0 || outIndex >= outputLength) continue;
        const sourcePosition = clip.offsetSamples + i * sourceRatio;
        const fadeGain = fadeGainAt(i, clipDurationOut, Math.round(clip.fadeInSamples * scale), Math.round(clip.fadeOutSamples * scale), clip.fadeType);
        const gain = clip.gain * fadeGain * track.volume;
        if (gain === 0) continue;

        const sourceChannels = source.channelData.length;
        if (channels === 1) {
          let mono = 0;
          for (let c = 0; c < sourceChannels; c += 1) mono += sampleAt(source.channelData[c]!, sourcePosition) / sourceChannels;
          output[0]![outIndex]! += mono * gain;
        } else {
          const monoIfNeeded = sourceChannels === 1 ? sampleAt(source.channelData[0]!, sourcePosition) : null;
          const left = monoIfNeeded ?? sampleAt(source.channelData[0]!, sourcePosition);
          const right = monoIfNeeded ?? sampleAt(source.channelData[Math.min(1, sourceChannels - 1)]!, sourcePosition);
          output[0]![outIndex]! += left * gain * panLeft;
          output[1]![outIndex]! += right * gain * panRight;
        }
      }
    }
  }

  const masterGain = state.masterVolume;
  if (masterGain !== 1) for (const channel of output) for (let i = 0; i < channel.length; i += 1) channel[i]! *= masterGain;
  return output;
}
