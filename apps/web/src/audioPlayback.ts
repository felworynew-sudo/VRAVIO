import { generateCurve, timelineDurationSamples, type AudioDocumentState } from "@vravio/env-audio";
import { buildLiveEffectChain, scheduleParamRamp } from "./audioEffects";

/**
 * Wires every audible clip from `fromSample` up to `hardEndSamples` into `master` — the one
 * graph-building pass both `AudioPlaybackEngine.play()` (a live `AudioContext`, heard as it
 * renders) and `renderAudioOffline` (an `OfflineAudioContext`, rendered faster than real time for
 * export) use, so a track's realtime insert chain — EQ, compressor, reverb, delay — sounds
 * exactly the same in an export as it does in the transport. Before this existed, "Export WAV…"
 * went through `packages/env-audio`'s pure, DOM-free `mixdownAudioDocument` instead, which sums
 * clips by plain arithmetic and has no way to run a Web Audio node graph at all — a track's
 * inserts played back live and vanished on export, silently. That pure function still exists and
 * is still correct for what it *is* used for now: `AudioEnvironment.exportAsAsset`'s round-trip
 * path in `packages/env-audio/src/environment.ts` has no DOM to reach `OfflineAudioContext`
 * from and was never the thing a user actually presses "Export…" to reach — see that file's own
 * comment on `portable: false` effects for why a DOM-free equivalent was never built for them
 * either. Graph shape, one node group per track: `AudioBufferSourceNode` (one per clip, fresh
 * every call — Web Audio source nodes are single-use) → per-clip `GainNode` (fade automation) →
 * track insert chain (if any) → track `GainNode` (volume) → track `StereoPannerNode` (pan) →
 * `master`.
 */
function scheduleAudioGraph(context: BaseAudioContext, master: AudioNode, state: AudioDocumentState, buffers: ReadonlyMap<string, AudioBuffer>, fromSample: number, hardEndSamples: number, now: number): AudioBufferSourceNode[] {
  const sampleRate = state.sampleRate;
  const anySoloed = state.tracks.some((track) => track.soloed);
  const sources: AudioBufferSourceNode[] = [];

  // Buses receive only from track sends, never straight from a clip — their own input gain node
  // exists whether or not the bus is actually audible, so a send has somewhere to connect
  // regardless; muted/soloed-out just means that gain never reaches `master`, the same silent-
  // sink shape a muted track's own graph already has.
  const anyBusSoloed = state.buses.some((bus) => bus.soloed);
  const busInputs = new Map<string, GainNode>();
  for (const bus of state.buses) {
    const busInput = context.createGain();
    const busPanner = context.createStereoPanner();
    busPanner.pan.value = bus.pan;
    busInput.connect(busPanner);
    if (!bus.muted && (!anyBusSoloed || bus.soloed)) {
      const busVolume = context.createGain();
      busVolume.gain.value = bus.volume;
      busPanner.connect(busVolume);
      busVolume.connect(master);
    }
    busInputs.set(bus.id, busInput);
  }

  for (const track of state.tracks) {
    if (track.muted || (anySoloed && !track.soloed)) continue;
    const trackGain = context.createGain();
    scheduleParamRamp(trackGain.gain, track.volumeAutomation, track.volume, fromSample, sampleRate, now);
    const panner = context.createStereoPanner();
    panner.pan.value = track.pan;
    trackGain.connect(panner);
    panner.connect(master);
    // Sends tap the same post-fader signal already headed to master — `AudioSend.pre`'s own
    // doc comment (packages/env-audio/src/types.ts) names pre-fader tapping as this feature's
    // next slice, not silently assumed done.
    for (const send of track.sends) {
      if (!send.enabled) continue;
      const busInput = busInputs.get(send.busId);
      if (!busInput) continue;
      const sendGain = context.createGain();
      sendGain.gain.value = send.level;
      panner.connect(sendGain);
      sendGain.connect(busInput);
    }
    // Inserts sit before the fader/pan, the same channel-strip order every mixer uses —
    // an effect shapes the raw signal, volume/pan happen after.
    const insertChain = buildLiveEffectChain(context, track.effects, track.effectAutomation, { fromSample, sampleRate, now });
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

      const source = context.createBufferSource();
      source.buffer = buffer;
      const clipGain = context.createGain();
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
      sources.push(source);
    }
  }
  return sources;
}

/** Which assets `scheduleAudioGraph` will actually ask for — shared by the live engine's decode
 * step and the offline renderer's, so neither decodes an asset no audible clip needs. */
function neededAssetIds(state: AudioDocumentState, fromSample: number): Set<string> {
  const anySoloed = state.tracks.some((track) => track.soloed);
  const ids = new Set<string>();
  for (const track of state.tracks) {
    if (track.muted || (anySoloed && !track.soloed)) continue;
    for (const clip of track.clips) if (clip.startSample + clip.durationSamples > fromSample) ids.add(clip.assetId);
  }
  return ids;
}

/**
 * Renders the whole timeline offline — through the identical graph `scheduleAudioGraph` builds
 * for live playback, so a track's inserts and their automation are heard in the export exactly
 * as they are in the transport. `OfflineAudioContext.startRendering()` runs faster than real
 * time; the returned buffer is ready for `encodeWav` the moment this resolves.
 */
export async function renderAudioOffline(state: AudioDocumentState, resolveBytes: (assetId: string) => Promise<Uint8Array | null>): Promise<AudioBuffer> {
  const hardEndSamples = Math.max(1, timelineDurationSamples(state));
  const context = new OfflineAudioContext(state.channels, hardEndSamples, state.sampleRate);
  const master = context.createGain();
  master.gain.value = state.masterVolume;
  master.connect(context.destination);

  const buffers = new Map<string, AudioBuffer>();
  await Promise.all([...neededAssetIds(state, 0)].map(async (assetId) => {
    const bytes = await resolveBytes(assetId);
    if (!bytes) return;
    // Each render gets its own decode — `OfflineAudioContext.decodeAudioData` is the same API
    // an `AudioContext` has, and an export is a one-shot call, not a hot path worth caching for.
    const copy = bytes.slice();
    try { buffers.set(assetId, await context.decodeAudioData(copy.buffer as ArrayBuffer)); } catch { /* unreadable asset — clip is silently skipped, same as live playback */ }
  }));

  scheduleAudioGraph(context, master, state, buffers, 0, hardEndSamples, 0);
  return context.startRendering();
}

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
    const now = this.context.currentTime;
    // A loop only takes hold once playback is already inside it — starting from before
    // loopStart plays through to it normally first, the same "loop catches you as you pass
    // through" behavior Ardour's transport has, rather than snapping the playhead itself.
    const looping = state.loopEnabled && state.loopEnd > state.loopStart && fromSample >= state.loopStart && fromSample < state.loopEnd;
    const hardEndSamples = looping ? state.loopEnd : Math.max(fromSample, timelineDurationSamples(state));

    const buffers = new Map<string, AudioBuffer>();
    await Promise.all([...neededAssetIds(state, fromSample)].map(async (assetId) => {
      const bytes = await resolveBytes(assetId);
      if (!bytes) return;
      buffers.set(assetId, await this.decode(assetId, bytes));
    }));

    this.#sources = scheduleAudioGraph(this.context, this.#master, state, buffers, fromSample, hardEndSamples, now);

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
