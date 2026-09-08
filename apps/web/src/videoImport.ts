import type { VideoAssetMeta } from "@vravio/env-video";

/**
 * Probes a dropped video file's duration/dimensions via `HTMLVideoElement`'s own
 * `loadedmetadata` event — the same technique `MediaWorkspace.tsx` used before this environment
 * existed (docs/master-plan.md §9.1). Unlike audio, the file's own container bytes are kept
 * as-is (there is no VRAVIO-internal video re-encode the way `audioImport.ts` re-encodes to
 * WAV) — playback happens through the browser's own decoder in `VideoWorkspace.tsx`, which seeks
 * by *time*, not by frame.
 *
 * `frameRate` in the result is the *document's* frame rate, not a value read off the container:
 * browsers do not expose a reliable, cross-engine "true encoded fps" for an arbitrary file
 * without decoding it frame-by-frame (`requestVideoFrameCallback` counting is slow and Chrome-
 * only), and `HTMLVideoElement` itself is entirely time-based — `currentTime` is seconds, not a
 * frame index. Treating the source as if it played at the document's own rate
 * (`durationFrames = round(duration * documentFrameRate)`) is what actually matches how seeking
 * this clip back works (`video-commands.ts`'s clips are addressed in frames at the document's
 * rate); a source that is genuinely a different native frame rate would drift by a fraction of a
 * frame over a very long clip, the same rounding trade every non-frame-accurate web NLE preview
 * makes. Documented here rather than silently assumed.
 */
export async function probeVideoMetadata(file: File, documentFrameRate: number): Promise<VideoAssetMeta | null> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.preload = "metadata";
  video.src = url;
  try {
    const { duration, width, height } = await new Promise<{ duration: number; width: number; height: number }>((resolve, reject) => {
      video.onloadedmetadata = () => resolve({ duration: video.duration, width: video.videoWidth, height: video.videoHeight });
      video.onerror = () => reject(new Error(`Cannot decode ${file.name}`));
    });
    if (!Number.isFinite(duration) || duration <= 0 || width <= 0 || height <= 0) return null;
    return { durationFrames: Math.max(1, Math.round(duration * documentFrameRate)), width, height, frameRate: documentFrameRate };
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}
