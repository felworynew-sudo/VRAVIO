import { destRectFor, sourceRectFor, type VideoClip, type VideoDocumentState, type VideoTrack } from "@vravio/env-video";
import type { AssetId } from "@vravio/kernel";
import { kernel } from "./kernel";

/** Blob URLs for video/audio assets, keyed by asset id — module-level so a document switch away
 * and back doesn't re-read bytes it already fetched; revoked only when the whole tab closes. */
const assetUrlCache = new Map<string, Promise<string>>();

export function assetUrl(assetId: string): Promise<string> {
  let cached = assetUrlCache.get(assetId);
  if (!cached) {
    cached = kernel.assets.read(assetId as AssetId).then((bytes) => {
      if (!bytes) throw new Error(`Asset ${assetId} has no bytes`);
      const mime = kernel.assets.get(assetId as AssetId)?.mime || "video/mp4";
      return URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: mime }));
    });
    assetUrlCache.set(assetId, cached);
  }
  return cached;
}

export interface ActiveHit { readonly track: VideoTrack; readonly clip: VideoClip; }

/** Every video-kind clip covering `frame`, one per non-hidden video track, in track order
 * (index 0 first) — the compositor draws them in this order, so a later entry in
 * `VideoDocumentState.tracks` paints over an earlier one, the same bottom-to-top convention
 * raster layers use (`VideoTrack`'s own doc comment). */
export function visualHitsAt(tracks: readonly VideoTrack[], frame: number): ActiveHit[] {
  const hits: ActiveHit[] = [];
  for (const track of tracks) {
    if (track.kind !== "video" || track.hidden) continue;
    const clip = track.clips.find((item) => frame >= item.startFrame && frame < item.startFrame + item.durationFrames);
    if (clip) hits.push({ track, clip });
  }
  return hits;
}

/** Every clip (video or audio track, visual or not) covering `frame` on a track that is not
 * muted — what should actually be making sound this instant. A video track's own clip
 * contributes its embedded audio unless that track is muted, same as an `"audio"` track's clip. */
export function audioHitsAt(tracks: readonly VideoTrack[], frame: number): ActiveHit[] {
  const hits: ActiveHit[] = [];
  for (const track of tracks) {
    if (track.muted) continue;
    const clip = track.clips.find((item) => frame >= item.startFrame && frame < item.startFrame + item.durationFrames);
    if (clip) hits.push({ track, clip });
  }
  return hits;
}

const DRIFT_TOLERANCE_SECONDS = 3 / 30; // ~3 frames at a typical rate; re-seek past this

/**
 * Real-time multi-track preview: composites every visible video track's current clip onto a
 * `<canvas>` (`compositor-math.ts`'s crop/fit/scale/position geometry — the browser element
 * pool here only supplies the decoded pixels `drawImage` samples from) and drives each active
 * clip's own `<video>` element for sound, respecting per-track `volume`/`muted`.
 *
 * Deliberately simpler than `AudioPlaybackEngine`: audio mixing is each active element's own
 * native `.volume` (clamped to the `[0,1]` `HTMLMediaElement` allows, though a track's own
 * `volume` can go up to 1.5 for headroom — the excess is inaudible here), not a Web Audio graph
 * with gain nodes per track. A real Web Audio mixer for video's embedded audio is a follow-up
 * (docs/master-plan.md §9.1); decoding an arbitrary container's audio track through
 * `decodeAudioData` is markedly less reliable across browsers than just letting the same
 * `<video>` element that already decodes the picture play its own sound natively.
 */
export class VideoCompositor {
  #canvas: HTMLCanvasElement | null = null;
  #container: HTMLDivElement;
  #pool = new Map<string, HTMLVideoElement>();
  #playing = false;
  #rafId: number | null = null;
  #playStartPerf = 0;
  #playStartFrame = 0;
  #frameRate = 30;
  #onEnded: (() => void) | null = null;
  /** Called with the current frame on every tick while playing — the single source `playheadFrame`
   * in `VideoWorkspace.tsx` is driven from, replacing an earlier design with a second, independent
   * `requestAnimationFrame` loop in the component itself: two loops each reading/writing playhead
   * state raced on the frame this instance stopped at, so a clip finishing at end-of-timeline
   * could leave the transport showing "playing" a frame or two after everything had actually
   * paused (found live — see the CLAUDE.md-documented pattern of an interaction only a real
   * screen catches, not a synthetic replay). One loop, one writer, no race. */
  #onFrame: ((frame: number) => void) | null = null;
  #currentFrame = 0;
  #lastRenderState: VideoDocumentState | null = null;

  constructor() {
    this.#container = document.createElement("div");
    this.#container.style.cssText = "position:fixed;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;left:-9999px";
    document.body.appendChild(this.#container);
  }

  get isPlaying(): boolean { return this.#playing; }
  currentFrame(): number { return this.#currentFrame; }
  onEnded(callback: (() => void) | null): void { this.#onEnded = callback; }
  onFrame(callback: ((frame: number) => void) | null): void { this.#onFrame = callback; }

  attachCanvas(canvas: HTMLCanvasElement): void { this.#canvas = canvas; }

  #ensureElement(clip: VideoClip): HTMLVideoElement {
    let element = this.#pool.get(clip.id);
    if (!element) {
      element = document.createElement("video");
      element.playsInline = true;
      element.preload = "auto";
      this.#container.appendChild(element);
      this.#pool.set(clip.id, element);
      // The asset's bytes are read and turned into a blob URL asynchronously (`assetUrl`), and
      // decoding what `src` points to takes longer still — neither finishes before this call
      // returns. Without repainting once the element actually has a frame to show, a freshly
      // created element stays black forever whenever nothing else happens to trigger another
      // render in the meantime (a static scrub position, an otherwise-idle document) — the
      // paused case never gets a second chance the way every following rAF tick gives playback.
      element.addEventListener("loadeddata", () => { if (!this.#playing && this.#lastRenderState) this.#paint(this.#lastRenderState, visualHitsAt(this.#lastRenderState.tracks, this.#currentFrame)); }, { once: true });
      void assetUrl(clip.assetId).then((url) => { if (element!.src !== url) element!.src = url; }).catch(() => {});
    }
    return element;
  }

  /** Removes pooled elements for clips no longer active — a small, immediate GC rather than a
   * time-based eviction, so the pool never grows past what the current frame actually needs. */
  #gc(activeClipIds: ReadonlySet<string>): void {
    for (const [clipId, element] of this.#pool) {
      if (activeClipIds.has(clipId)) continue;
      element.pause();
      element.remove();
      this.#pool.delete(clipId);
    }
  }

  /** Paints one frame, paused — what scrubbing calls. Seeks every active element to the exact
   * offset `frame` implies; does not call `.play()` on anything. */
  renderFrame(state: VideoDocumentState, frame: number): void {
    this.#currentFrame = frame;
    this.#lastRenderState = state;
    const visual = visualHitsAt(state.tracks, frame);
    const audio = audioHitsAt(state.tracks, frame);
    const activeIds = new Set([...visual, ...audio].map((hit) => hit.clip.id));
    this.#gc(activeIds);

    for (const hit of audio) {
      const element = this.#ensureElement(hit.clip);
      element.pause();
      const seekTo = (hit.clip.offsetFrames + (frame - hit.clip.startFrame)) / hit.clip.sourceFrameRate;
      if (Math.abs(element.currentTime - seekTo) > 1 / hit.clip.sourceFrameRate) element.currentTime = seekTo;
    }
    for (const hit of visual) if (!audio.some((item) => item.clip.id === hit.clip.id)) {
      const element = this.#ensureElement(hit.clip);
      const seekTo = (hit.clip.offsetFrames + (frame - hit.clip.startFrame)) / hit.clip.sourceFrameRate;
      if (Math.abs(element.currentTime - seekTo) > 1 / hit.clip.sourceFrameRate) element.currentTime = seekTo;
    }
    this.#paint(state, visual);
  }

  #paint(state: VideoDocumentState, visual: readonly ActiveHit[]): void {
    const canvas = this.#canvas;
    if (!canvas) return;
    if (canvas.width !== state.width) canvas.width = state.width;
    if (canvas.height !== state.height) canvas.height = state.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (const hit of visual) {
      const element = this.#pool.get(hit.clip.id);
      if (!element || element.readyState < 2) continue; // HAVE_CURRENT_DATA — nothing decoded yet
      const source = sourceRectFor(hit.clip);
      const dest = destRectFor(hit.clip, source, state.width, state.height);
      ctx.globalAlpha = Math.max(0, Math.min(1, hit.clip.opacity));
      ctx.drawImage(element, source.sx, source.sy, source.sw, source.sh, dest.dx, dest.dy, dest.dw, dest.dh);
    }
    ctx.globalAlpha = 1;
  }

  /**
   * Starts continuous playback from `fromFrame` at `rate` (1 = normal forward speed, the J/K/L
   * shuttle transport's own convention — `VideoWorkspace.tsx` calls this with 2/4/8 for repeated
   * L presses and -1/-2/-4/-8 for repeated J presses). The master clock is wall-clock elapsed
   * time (`performance.now()`) scaled by `rate`, not any one clip's own `<video>` element —
   * several elements can be playing across tracks at once, so none of them alone is a fair
   * reference clock. Forward playback (`rate > 0`) lets each active element decode natively via
   * `HTMLMediaElement.playbackRate`, same as before; drift past `DRIFT_TOLERANCE_SECONDS` (a
   * decode hiccup, a paused tab tab-switch) triggers a hard reseek. Reverse (`rate < 0`) has no
   * native browser equivalent — `<video>` cannot decode backwards — so it is simulated by seeking
   * every active element to the master clock's computed position each tick without ever calling
   * `.play()`; the picture updates once per animation frame rather than decoding continuously, and
   * carries no audio, which is what every consumer browser NLE's own J-shuttle does for the same
   * reason.
   */
  play(state: VideoDocumentState, fromFrame: number, rate = 1): void {
    this.pause();
    this.#playing = true;
    this.#playStartPerf = performance.now();
    this.#playStartFrame = fromFrame;
    this.#frameRate = state.frameRate;
    const durationFrames = state.tracks.reduce((end, track) => track.clips.reduce((trackEnd, clip) => Math.max(trackEnd, clip.startFrame + clip.durationFrames), end), 0);
    const reverse = rate < 0;
    // Native `HTMLMediaElement.playbackRate` is unreliable much past 4x in most engines (audio
    // is muted here anyway above that), so forward shuttle speeds beyond it fall back to the same
    // seek-stepping reverse uses rather than risking a silently-stuck element.
    const nativePlayback = !reverse && Math.abs(rate) <= 4;

    const previouslyActive = new Set<string>();
    // Only a clip whose `.play()` has actually resolved gets unmuted — otherwise the very next
    // tick's "not newly active anymore" branch would unmute an element still waiting on (or
    // rejected from) that promise, which doesn't make it play, only turns off the one thing
    // (`muted: true`) a browser's autoplay policy unconditionally allows. Found live: elements
    // sat at `paused: true, muted: false` indefinitely — unmuted on tick 2 regardless of whether
    // tick 1's `play()` had gone anywhere (CLAUDE.md §2's own recurring lesson about the actual
    // screen catching what reasoning about the code alone did not).
    const confirmedPlaying = new Set<string>();
    const tick = () => {
      if (!this.#playing) return;
      const elapsedSeconds = (performance.now() - this.#playStartPerf) / 1000;
      const rawFrame = this.#playStartFrame + Math.round(elapsedSeconds * this.#frameRate * rate);
      if (rawFrame >= durationFrames) { this.#currentFrame = durationFrames; this.pause(); this.#onFrame?.(durationFrames); this.#onEnded?.(); return; }
      // The reverse-shuttle floor only applies once the clock has actually run backwards past 0 —
      // checking `reverse` here (not just `rawFrame <= 0`) matters because a *forward* play from
      // `fromFrame === 0` computes `rawFrame === 0` on its very first tick too, and that must not
      // be mistaken for having shuttled off the front of the timeline (found live: L from the
      // playhead's start position ended playback before a single frame advanced).
      if (reverse && rawFrame <= 0) { this.#currentFrame = 0; this.pause(); this.#onFrame?.(0); this.#onEnded?.(); return; }
      const frame = Math.max(0, rawFrame);
      this.#currentFrame = frame;
      this.#onFrame?.(frame);

      const visual = visualHitsAt(state.tracks, frame);
      const audio = nativePlayback ? audioHitsAt(state.tracks, frame) : [];
      const activeIds = new Set([...visual, ...audio].map((hit) => hit.clip.id));
      this.#gc(activeIds);

      const wantsAudio = new Set(audio.map((hit) => hit.clip.id));
      for (const hit of [...visual, ...audio.filter((item) => !visual.some((v) => v.clip.id === item.clip.id))]) {
        const element = this.#ensureElement(hit.clip);
        const isNewlyActive = !previouslyActive.has(hit.clip.id);
        const seekTo = (hit.clip.offsetFrames + (frame - hit.clip.startFrame)) / hit.clip.sourceFrameRate;
        const shouldHearThis = wantsAudio.has(hit.clip.id);
        if (shouldHearThis) element.volume = Math.max(0, Math.min(1, hit.track.volume));

        if (!nativePlayback) {
          // Reverse shuttle (or an extreme forward speed): pure seek-and-paint, no decode-ahead.
          element.pause();
          if (Math.abs(element.currentTime - seekTo) > 1 / hit.clip.sourceFrameRate) element.currentTime = seekTo;
          continue;
        }
        element.playbackRate = Math.abs(rate) || 1;
        if (isNewlyActive) {
          element.currentTime = seekTo;
          // Browsers allow autoplay unconditionally only for muted media — starting muted and
          // unmuting once playback has actually begun sidesteps the "no user gesture" rejection
          // that starting unmuted from inside a requestAnimationFrame callback can hit even right
          // after a real click (the click's own activation window doesn't reliably extend to a
          // later animation-frame task in every engine). Silent playback would otherwise fail
          // exactly the way the earlier live check here caught it: isPlaying true, every pooled
          // element still paused at 0 — a real bug, not the false alarm most of this session's
          // other live-test surprises turned out to be (CLAUDE.md §2's own recurring lesson).
          element.muted = true;
          void element.play().then(() => { confirmedPlaying.add(hit.clip.id); element.muted = !shouldHearThis; }).catch(() => {});
        } else {
          if (confirmedPlaying.has(hit.clip.id)) element.muted = !shouldHearThis;
          if (Math.abs(element.currentTime - seekTo) > DRIFT_TOLERANCE_SECONDS) {
            element.currentTime = seekTo;
          } else if (element.paused) {
            void element.play().then(() => confirmedPlaying.add(hit.clip.id)).catch(() => {});
          }
        }
      }
      previouslyActive.clear();
      for (const id of activeIds) previouslyActive.add(id);

      this.#paint(state, visual);
      this.#rafId = requestAnimationFrame(tick);
    };
    this.#rafId = requestAnimationFrame(tick);
  }

  pause(): void {
    this.#playing = false;
    if (this.#rafId !== null) { cancelAnimationFrame(this.#rafId); this.#rafId = null; }
    for (const element of this.#pool.values()) element.pause();
  }

  dispose(): void {
    this.pause();
    for (const element of this.#pool.values()) element.remove();
    this.#pool.clear();
    this.#container.remove();
  }
}
