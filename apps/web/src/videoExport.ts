import { destRectFor, sourceRectFor, timelineDurationFrames, type VideoDocumentState } from "@vravio/env-video";
import { assetUrl, audioHitsAt, visualHitsAt } from "./videoCompositor";

/**
 * Renders a video document to a delivery file by actually playing it once, in real time, while
 * capturing the result — `canvas.captureStream()` for the picture, a Web Audio
 * `MediaStreamAudioDestinationNode` for the mixed sound, both fed into one `MediaRecorder`. This
 * is the honest alternative to the `VideoEnvironment.exportAsAsset` refusal
 * (`docs/master-plan.md` §9.1): there is no offline/instant render path here — encoding takes
 * wall-clock time equal to the timeline's own duration, because a browser has no general-purpose
 * "render this container faster than real time" primitive without a bespoke encoder (the same
 * reason `extractAsset`/`exportAsAsset` still refuse: this function does not touch a document's
 * *source* files, it captures a live playback, which is a different and much more limited
 * capability than real trim/re-encode). Audio mixing here is genuinely summed through Web Audio
 * (`MediaElementAudioSourceNode` per active clip, all routed to one destination) — unlike
 * `VideoCompositor`'s live-preview shortcut of relying on each element's own `.volume`, export
 * doesn't play anything out loud on the way to the recording, so there is no autoplay-policy
 * workaround needed here.
 */
export interface VideoExportProgress {
  readonly frame: number;
  readonly durationFrames: number;
}

export async function exportVideoDocument(state: VideoDocumentState, onProgress?: (progress: VideoExportProgress) => void): Promise<Blob> {
  const durationFrames = Math.max(1, timelineDurationFrames(state));
  const canvas = document.createElement("canvas");
  canvas.width = state.width;
  canvas.height = state.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");

  const container = document.createElement("div");
  container.style.cssText = "position:fixed;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;left:-9999px";
  document.body.appendChild(container);

  const audioContext = new AudioContext();
  const audioDestination = audioContext.createMediaStreamDestination();
  const pool = new Map<string, HTMLVideoElement>();
  const sources = new Map<string, MediaElementAudioSourceNode>();

  async function ensureElement(clipId: string, assetId: string): Promise<HTMLVideoElement> {
    let element = pool.get(clipId);
    if (!element) {
      element = document.createElement("video");
      element.playsInline = true;
      element.muted = true; // captured through Web Audio below, never played out loud
      container.appendChild(element);
      pool.set(clipId, element);
      element.src = await assetUrl(assetId);
      await new Promise<void>((resolve) => {
        if (element!.readyState >= 2) { resolve(); return; }
        element!.addEventListener("loadeddata", () => resolve(), { once: true });
      });
    }
    return element;
  }

  function ensureAudioSource(clipId: string, element: HTMLVideoElement): MediaElementAudioSourceNode {
    let source = sources.get(clipId);
    if (!source) {
      source = audioContext.createMediaElementSource(element);
      source.connect(audioDestination);
      sources.set(clipId, source);
    }
    return source;
  }

  /** `HTMLMediaElement.play()` can return a promise that never settles at all — neither resolves
   * nor rejects — when a browser is still weighing an autoplay decision, which a call with no
   * real user gesture behind it (this whole export runs from a menu action, arbitrarily later
   * than whatever click started it) can trigger. A raced timeout keeps that from hanging the
   * entire export: the clip just goes without audio for this run rather than never finishing. */
  async function playWithTimeout(element: HTMLVideoElement, timeoutMs = 500): Promise<boolean> {
    return Promise.race([
      element.play().then(() => true).catch(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ]);
  }

  const videoStream = canvas.captureStream(state.frameRate);
  const combined = new MediaStream([...videoStream.getVideoTracks(), ...audioDestination.stream.getAudioTracks()]);
  const mimeType = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? "video/webm";
  const recorder = new MediaRecorder(combined, { mimeType });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => { if (event.data.size > 0) chunks.push(event.data); };
  const stopped = new Promise<void>((resolve) => { recorder.onstop = () => resolve(); });

  try {
    recorder.start();
    const frameDurationMs = 1000 / state.frameRate;
    let frame = 0;
    const activeElementIds = new Set<string>();

    while (frame < durationFrames) {
      const frameStart = performance.now();
      const visual = visualHitsAt(state.tracks, frame);
      const audio = audioHitsAt(state.tracks, frame);
      const wantsAudio = new Set(audio.map((hit) => hit.clip.id));
      const stillActive = new Set([...visual, ...audio].map((hit) => hit.clip.id));

      for (const clipId of activeElementIds) if (!stillActive.has(clipId)) {
        pool.get(clipId)?.pause();
        activeElementIds.delete(clipId);
      }

      for (const hit of [...visual, ...audio.filter((item) => !visual.some((v) => v.clip.id === item.clip.id))]) {
        const element = await ensureElement(hit.clip.id, hit.clip.assetId);
        const seekTo = (hit.clip.offsetFrames + (frame - hit.clip.startFrame)) / hit.clip.sourceFrameRate;
        const needsAudio = wantsAudio.has(hit.clip.id);
        if (needsAudio) {
          // Audio needs the element genuinely playing — decoded samples only flow into the
          // MediaElementAudioSourceNode graph while it advances on its own, so this one is
          // seeked once and then left running rather than reseeked every frame.
          if (!activeElementIds.has(hit.clip.id)) {
            element.currentTime = seekTo;
            ensureAudioSource(hit.clip.id, element);
            await playWithTimeout(element);
            activeElementIds.add(hit.clip.id);
          } else if (Math.abs(element.currentTime - seekTo) > 3 / hit.clip.sourceFrameRate) {
            element.currentTime = seekTo; // drifted — hard resync
          }
        } else {
          // Visual-only: drawImage reads whatever frame a paused, seeked element is showing just
          // as well as a playing one, so there is no need to ever call play() here at all.
          element.currentTime = seekTo;
          activeElementIds.add(hit.clip.id);
        }
      }

      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      for (const hit of visual) {
        const element = pool.get(hit.clip.id);
        if (!element || element.readyState < 2) continue;
        const source = sourceRectFor(hit.clip);
        const dest = destRectFor(hit.clip, source, state.width, state.height);
        ctx.globalAlpha = Math.max(0, Math.min(1, hit.clip.opacity));
        ctx.drawImage(element, source.sx, source.sy, source.sw, source.sh, dest.dx, dest.dy, dest.dw, dest.dh);
      }
      ctx.globalAlpha = 1;

      onProgress?.({ frame, durationFrames });
      frame += 1;
      const elapsed = performance.now() - frameStart;
      if (elapsed < frameDurationMs) await new Promise((resolve) => setTimeout(resolve, frameDurationMs - elapsed));
    }

    recorder.stop();
    await stopped;
    return new Blob(chunks, { type: mimeType });
  } finally {
    for (const element of pool.values()) { element.pause(); element.remove(); }
    for (const source of sources.values()) source.disconnect();
    container.remove();
    void audioContext.close();
  }
}
