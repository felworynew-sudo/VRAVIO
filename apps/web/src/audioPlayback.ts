import { generateCurve, timelineDurationSamples, type AudioDocumentState } from "@vravio/env-audio";
import { buildLiveEffectChain, scheduleParamRamp } from "./audioEffects";

/**
 * Real-time Web Audio playback for an `AudioDocumentState` — the browser half of the engine
 * `packages/env-audio` stays free of (that package has no DOM dependency, the same boundary
 * `env-raster`'s pure pixel math keeps from `RasterWorkspace.tsx`'s canvas rendering).
 *
 * Graph shape, one node group per track: `AudioBufferSourceNode` (one per clip, created fresh
 * on every `play()` — Web Audio source nodes are single-use) → per-clip `GainNode` (fade
 * automation) → track `GainNode` (volume) → track `StereoPannerNode` (pan) → master `GainNode`
 * → destination.
 */
export class AudioPlaybackEngine {
  readonly context: AudioContext;
  readonly #master: GainNode;
  readonly #bufferCache = new Map<string, Promise<AudioBuffer>>();
  #sources: AudioBufferSourceNode[] = [];
  #playing = false;
  #startedAtContextTime = 0;
  #startedAtTimelineSeconds = 0;
  #onEnded: (() => void) | null = null;
  #endTimer: ReturnType<typeof window.setTimeout> | null = null;

  constructor() {
    this.context = new AudioContext();
    this.#master = this.context.createGain();
    this.#master.connect(this.context.destination);
  }

  get isPlaying(): boolean { return this.#playing; }

  setMasterVolume(volume: number): void { this.#master.gain.value = volume; }

  /** Decodes and caches an asset's bytes as an `AudioBuffer` — decoding is the expensive step,
   * so a clip reusing the same asset (a loop, a duplicated clip) never re-decodes. */
  async decode(assetId: string, bytes: Uint8Array): Promise<AudioBuffer> {
    let cached = this.#bufferCache.get(assetId);
    if (!cached) {
      // decodeAudioData detaches/consumes the buffer it's given, so a copy is passed —
      // the caller's Uint8Array (often a live asset-store read) must stay valid afterward.
      const copy = bytes.slice();
      cached = this.context.decodeAudioData(copy.buffer as ArrayBuffer);
      this.#bufferCache.set(assetId, cached);
    }
    return cached;
  }

  /** Drops a decoded buffer from the cache — call when an asset's bytes changed underneath a
   * clip (a relink, a revision) so the next `play()` decodes the new bytes instead of reusing
   * stale audio for an asset id that now points somewhere else. */
  invalidate(assetId: string): void { this.#bufferCache.delete(assetId); }

  /**
   * Schedules every clip audible from `fromSample` onward. `resolveBytes` is asked once per
   * distinct `assetId` actually needed (not once per clip) — the caller (usually backed by
   * `kernel.assets.read`) can cache however it likes; this only calls it for the *set* of
   * assets this play() needs.
   */
  async play(state: AudioDocumentState, fromSample: number, resolveBytes: (assetId: string) => Promise<Uint8Array | null>): Promise<void> {
    this.stop();
    const sampleRate = state.sampleRate;
    const anySoloed = state.tracks.some((track) => track.soloed);
    const now = this.context.currentTime;
    // A loop only takes hold once playback is already inside it — starting from before
    // loopStart plays through to it normally first, the same "loop catches you as you pass
    // through" behavior Ardour's transport has, rather than snapping the playhead itself.
    const looping = state.loopEnabled && state.loopEnd > state.loopStart && fromSample >= state.loopStart && fromSample < state.loopEnd;
    const hardEndSamples = looping ? state.loopEnd : Math.max(fromSample, timelineDurationSamples(state));

    const neededAssetIds = new Set<string>();
    for (const track of state.tracks) {
      if (track.muted || (anySoloed && !track.soloed)) continue;
      for (const clip of track.clips) if (clip.startSample + clip.durationSamples > fromSample) neededAssetIds.add(clip.assetId);
    }
    const buffers = new Map<string, AudioBuffer>();
    await Promise.all([...neededAssetIds].map(async (assetId) => {
      const bytes = await resolveBytes(assetId);
      if (!bytes) return;
      buffers.set(assetId, await this.decode(assetId, bytes));
    }));

    for (const track of state.tracks) {
      if (track.muted || (anySoloed && !track.soloed)) continue;
      const trackGain = this.context.createGain();
      scheduleParamRamp(trackGain.gain, track.volumeAutomation, track.volume, fromSample, sampleRate, now);
      const panner = this.context.createStereoPanner();
      panner.pan.value = track.pan;
      trackGain.connect(panner);
      panner.connect(this.#master);
      // Inserts sit before the fader/pan, the same channel-strip order every mixer uses —
      // an effect shapes the raw signal, volume/pan happen after.
      const insertChain = buildLiveEffectChain(this.context, track.effects, track.effectAutomation, { fromSample, sampleRate, now });
      const clipDestination = insertChain ? insertChain.input : trackGain;
      if (insertChain) insertChain.output.connect(trackGain);

      for (const clip of track.clips) {
        const clipEnd = clip.startSample + clip.durationSamples;
        const playStart = Math.max(fromSample, clip.startSample);
        const playEnd = Math.min(clipEnd, hardEndSamples);
        if (playEnd <= playStart) continue;
        const buffer = buffers.get(clip.assetId);
        if (!buffer) continue;

        // How far into the clip playback starts (0 if fromSample is before the clip).
        const intoClipSamples = playStart - clip.startSample;
        const whenToStart = now + (playStart - fromSample) / sampleRate;
        const sourceOffsetSeconds = (clip.offsetSamples + intoClipSamples) / clip.sourceSampleRate;
        const remainingDurationSeconds = (playEnd - playStart) / sampleRate;
        if (remainingDurationSeconds <= 0) continue;

        const source = this.context.createBufferSource();
        source.buffer = buffer;
        const clipGain = this.context.createGain();
        clipGain.gain.value = clip.gain;
        source.connect(clipGain);
        clipGain.connect(clipDestination);

        // Fade automation only for the portion of the fade not already behind `fromSample` —
        // resuming mid-fade starts the curve from wherever it actually is, not from 0.
        if (clip.fadeInSamples > 0 && intoClipSamples < clip.fadeInSamples) {
          const curve = generateCurve(clip.fadeType, clip.fadeInSamples, true);
          const remaining = curve.slice(intoClipSamples);
          if (remaining.length > 1) clipGain.gain.setValueCurveAtTime(remaining, whenToStart, remaining.length / sampleRate);
        }
        const fadeOutStart = clip.durationSamples - clip.fadeOutSamples;
        if (clip.fadeOutSamples > 0 && intoClipSamples < clip.durationSamples) {
          const fadeOutStartTime = whenToStart + Math.max(0, fadeOutStart - intoClipSamples) / sampleRate;
          const curve = generateCurve(clip.fadeType, clip.fadeOutSamples, false);
          const already = Math.max(0, intoClipSamples - fadeOutStart);
          const remaining = curve.slice(already);
          if (remaining.length > 1) clipGain.gain.setValueCurveAtTime(remaining, fadeOutStartTime, remaining.length / sampleRate);
        }

        source.start(whenToStart, sourceOffsetSeconds, remainingDurationSeconds);
        this.#sources.push(source);
      }
    }

    this.#playing = true;
    this.#startedAtContextTime = now;
    this.#startedAtTimelineSeconds = fromSample / sampleRate;

    const remaining = Math.max(0, (hardEndSamples - fromSample) / sampleRate);
    this.#endTimer = window.setTimeout(() => {
      if (!this.#playing) return;
      // Looping re-enters play() from the top edge rather than splicing new sources onto the
      // running graph — the same one-shot-source constraint that already forces a fresh
      // AudioBufferSourceNode per clip on every play() (Web Audio sources cannot be restarted).
      if (looping) { void this.play(state, state.loopStart, resolveBytes); return; }
      this.#playing = false;
      this.#onEnded?.();
    }, remaining * 1000 + 50);
  }

  /** Halts playback and remembers the current position — the next `play()` with no explicit
   * `fromSample` argument from a caller reading `currentTimeSeconds()` resumes from here. */
  pause(): void {
    if (this.#playing) this.#startedAtTimelineSeconds = this.currentTimeSeconds();
    this.#stopSources();
  }

  /** Halts playback without remembering position — a caller wanting Audacity-style "stop
   * returns to where playback began" resets the transport's own position separately and calls
   * `play()` with that position next time; this method only tears down the audio graph. */
  stop(): void { this.#stopSources(); }

  #stopSources(): void {
    if (this.#endTimer !== null) { window.clearTimeout(this.#endTimer); this.#endTimer = null; }
    for (const source of this.#sources) { try { source.stop(); } catch { /* already stopped */ } }
    this.#sources = [];
    this.#playing = false;
  }

  /** Current playback position, in timeline seconds — extrapolated from the AudioContext's own
   * clock while playing (sample-accurate, unlike a UI-thread timer), or the last stopped
   * position otherwise. */
  currentTimeSeconds(): number {
    if (!this.#playing) return this.#startedAtTimelineSeconds;
    return this.#startedAtTimelineSeconds + (this.context.currentTime - this.#startedAtContextTime);
  }

  onEnded(callback: (() => void) | null): void { this.#onEnded = callback; }

  dispose(): void {
    this.stop();
    void this.context.close();
  }
}
