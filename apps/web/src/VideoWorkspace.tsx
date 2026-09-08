import { useCallback, useEffect, useRef, useState } from "react";
import type { AssetId, VravioDocument } from "@vravio/kernel";
import { isVideoDocumentState, timelineDurationFrames, type VideoClip, type VideoDocumentState, type VideoTrack } from "@vravio/env-video";
import { kernel } from "./kernel";
import { useShellStore } from "./store";
import { text } from "./i18n";
import {
  addClipFromAsset, addVideoTrack, changeVideoDocument, commitVideoDrag, deleteSelectedClips, previewMoveClip, previewTrimClip,
  removeVideoTrack, setSelection, setTrackHidden, setTrackLocked, setTrackMuted, setTrackVolume, splitClipAt,
} from "./video-commands";
import { probeVideoMetadata } from "./videoImport";

const TRACK_HEIGHT = 56;
const TRIM_HANDLE_PX = 8;
const DEFAULT_PIXELS_PER_SECOND = 80;

/** Blob URLs for video assets, keyed by asset id — same lazy-populate-once shape as
 * `AudioWorkspace.tsx`'s own `decodedAssetCache`, holding a URL instead of decoded PCM (a video
 * container isn't decoded by this codebase at all; the browser's own `<video>` element does
 * that, see `environment.ts`'s doc comment on why this package stays DOM-free). Module-level so
 * a document switch away and back doesn't re-read bytes it already fetched; revoked only when
 * the whole tab closes, the same trade-off audio's cache makes for decoded buffers. */
const videoAssetUrlCache = new Map<string, Promise<string>>();

function videoAssetUrl(assetId: string): Promise<string> {
  let cached = videoAssetUrlCache.get(assetId);
  if (!cached) {
    cached = kernel.assets.read(assetId as AssetId).then((bytes) => {
      if (!bytes) throw new Error(`Asset ${assetId} has no bytes`);
      const mime = kernel.assets.get(assetId as AssetId)?.mime || "video/mp4";
      return URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: mime }));
    });
    videoAssetUrlCache.set(assetId, cached);
  }
  return cached;
}

function formatTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60), rest = seconds - minutes * 60;
  return `${minutes}:${rest.toFixed(2).padStart(5, "0")}`;
}

/** The video-kind clip, if any, covering `frame` — first match in track order (tracks earlier in
 * the array composite under later ones is a later feature; for this pass exactly one clip is
 * ever previewed at a time, so "first that covers the playhead" is the whole rule). */
function clipUnderPlayhead(tracks: readonly VideoTrack[], frame: number): { track: VideoTrack; clip: VideoClip } | null {
  for (const track of tracks) {
    if (track.kind !== "video" || track.hidden) continue;
    const clip = track.clips.find((item) => frame >= item.startFrame && frame < item.startFrame + item.durationFrames);
    if (clip) return { track, clip };
  }
  return null;
}

interface DragState {
  readonly kind: "move" | "trim-left" | "trim-right";
  readonly trackId: string;
  readonly clipId: string;
  readonly startClientX: number;
  readonly before: VideoDocumentState;
  appliedFrames: number;
}

export function VideoWorkspace({ document }: { document: VravioDocument }) {
  const language = useShellStore((shell) => shell.language);
  const [pixelsPerSecond, setPixelsPerSecond] = useState(DEFAULT_PIXELS_PER_SECOND);
  const [playheadFrame, setPlayheadFrame] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [splitMode, setSplitMode] = useState(false);
  const [rippleMode, setRippleMode] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const rafRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const playingClipIdRef = useRef<string | null>(null);

  if (!isVideoDocumentState(document.state)) return <div className="workspace-error">Invalid video document state</div>;
  const state = document.state;
  const frameRate = state.frameRate;
  const durationFrames = Math.max(frameRate * 5, timelineDurationFrames(state));
  const pxPerFrame = pixelsPerSecond / frameRate / 1;

  const stopPlayback = useCallback(() => {
    videoRef.current?.pause();
    playingClipIdRef.current = null;
    setIsPlaying(false);
    if (rafRef.current !== null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
  }, []);

  // Seeks the single preview <video> element to whatever clip covers `frame`, paused — this is
  // what makes scrubbing show a real picture. Deliberately does not attempt to composite more
  // than one video track (docs/master-plan.md §9.1: v0.1 is the timeline model — move/trim/
  // split/playhead — not yet the compositing pipeline multi-track overlay needs).
  const showFrame = useCallback((frame: number) => {
    const hit = clipUnderPlayhead(state.tracks, frame);
    const video = videoRef.current;
    if (!video) return;
    if (!hit) { video.removeAttribute("src"); playingClipIdRef.current = null; return; }
    const seekTo = (hit.clip.offsetFrames + (frame - hit.clip.startFrame)) / hit.clip.sourceFrameRate;
    void videoAssetUrl(hit.clip.assetId).then((url) => {
      if (video.src !== url) video.src = url;
      video.currentTime = seekTo;
    }).catch(() => {});
  }, [state.tracks]);

  useEffect(() => { if (!isPlaying) showFrame(playheadFrame); }, [playheadFrame, isPlaying, showFrame]);
  useEffect(() => () => { if (rafRef.current !== null) cancelAnimationFrame(rafRef.current); }, []);

  // Plays exactly the clip under the playhead at the moment Play was pressed, stopping at its
  // own end rather than seeking across the boundary into whatever clip comes next — seamless
  // multi-clip/multi-track real-time playback is a follow-up (docs/master-plan.md §9.1), the
  // same scope line audio's own v0.1 phase drew before later phases added realtime effects.
  const startPlayback = useCallback(() => {
    const hit = clipUnderPlayhead(state.tracks, playheadFrame);
    const video = videoRef.current;
    if (!hit || !video) return;
    playingClipIdRef.current = hit.clip.id;
    const clipEndFrame = hit.clip.startFrame + hit.clip.durationFrames;
    void videoAssetUrl(hit.clip.assetId).then(async (url) => {
      if (video.src !== url) video.src = url;
      video.currentTime = (hit.clip.offsetFrames + (playheadFrame - hit.clip.startFrame)) / hit.clip.sourceFrameRate;
      await video.play();
      setIsPlaying(true);
      const tick = () => {
        if (playingClipIdRef.current !== hit.clip.id) return;
        const currentFrame = hit.clip.startFrame + Math.round((video.currentTime - hit.clip.offsetFrames / hit.clip.sourceFrameRate) * frameRate);
        if (video.paused || currentFrame >= clipEndFrame) { stopPlayback(); setPlayheadFrame(Math.min(clipEndFrame, currentFrame)); return; }
        setPlayheadFrame(currentFrame);
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    }).catch(() => {});
  }, [state.tracks, playheadFrame, frameRate, stopPlayback]);

  const togglePlay = () => { if (isPlaying) stopPlayback(); else startPlayback(); };
  const stopToStart = () => { stopPlayback(); setPlayheadFrame(0); };

  const onRulerClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const frame = Math.max(0, Math.round((event.clientX - rect.left) / pxPerFrame));
    stopPlayback();
    setPlayheadFrame(frame);
  };

  const beginDrag = (event: React.PointerEvent, kind: DragState["kind"], track: VideoTrack, clip: VideoClip) => {
    if (track.locked) return;
    event.stopPropagation();
    (event.target as Element).setPointerCapture(event.pointerId);
    const before = kernel.documents.get<VideoDocumentState>(document.id)!.state;
    dragRef.current = { kind, trackId: track.id, clipId: clip.id, startClientX: event.clientX, before: structuredClone(before), appliedFrames: 0 };
    if (event.shiftKey && state.selection?.trackId === track.id) {
      const already = state.selection.clipIds.includes(clip.id);
      setSelection(document.id, track.id, already ? state.selection.clipIds.filter((id) => id !== clip.id) : [...state.selection.clipIds, clip.id]);
    } else {
      setSelection(document.id, track.id, [clip.id]);
    }
  };

  const onDragMove = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const deltaPx = event.clientX - drag.startClientX;
    const deltaFrames = Math.round(deltaPx / pxPerFrame) - drag.appliedFrames;
    if (deltaFrames === 0) return;
    const applied = drag.kind === "move"
      ? previewMoveClip(document.id, drag.trackId, drag.clipId, deltaFrames)
      : previewTrimClip(document.id, drag.trackId, drag.clipId, drag.kind === "trim-left" ? "left" : "right", deltaFrames, rippleMode);
    drag.appliedFrames += applied;
  };

  const onDragEnd = () => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    if (drag.appliedFrames !== 0) {
      const label = drag.kind === "move" ? "Move Clip (Переместить клип)" : "Trim Clip (Обрезать клип)";
      commitVideoDrag(document.id, label, drag.before);
    }
  };

  const onClipClick = (track: VideoTrack, clip: VideoClip, event: React.MouseEvent) => {
    if (splitMode) {
      const rect = event.currentTarget.getBoundingClientRect();
      const clickedFrame = clip.startFrame + Math.round((event.clientX - rect.left) / pxPerFrame);
      splitClipAt(document.id, track.id, clip.id, clickedFrame);
    }
  };

  const importFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    for (const file of Array.from(files)) {
      const isAudio = file.type.startsWith("audio/");
      const meta = isAudio ? null : await probeVideoMetadata(file, frameRate);
      if (!isAudio && !meta) continue; // browser could not decode this file's metadata at all
      const assetId = await kernel.assets.importAsset(file, { kind: isAudio ? "audio" : "video", mime: file.type || "video/mp4", name: file.name, ...(meta ? { meta: meta as unknown as Record<string, unknown> } : {}) });
      const durationFramesForClip = meta?.durationFrames ?? Math.round(frameRate * 5); // audio track: real duration deferred, see below
      const at = Math.round(timelineDurationFrames(kernel.documents.get<VideoDocumentState>(document.id)!.state));
      await addClipFromAsset(document.id, assetId, file.name, durationFramesForClip, meta?.frameRate ?? frameRate, isAudio ? "audio" : "video", undefined, at);
    }
  };

  const timelineWidthPx = Math.max(400, Math.round((durationFrames / frameRate) * pixelsPerSecond) + 100);

  return <div className="video-workspace">
    <div className="video-transport">
      <button onClick={togglePlay} title={text(language, "Play/Pause", "Играть/Пауза")}>{isPlaying ? "⏸" : "▶"}</button>
      <button onClick={stopToStart} title={text(language, "Stop", "Стоп")}>⏹</button>
      <span className="video-time">{formatTime(playheadFrame / frameRate)} / {formatTime(durationFrames / frameRate)}</span>
      <button className={splitMode ? "active" : ""} onClick={() => setSplitMode((value) => !value)} title={text(language, "Split tool", "Инструмент разреза")}>✂</button>
      <button className={rippleMode ? "active" : ""} onClick={() => setRippleMode((value) => !value)} title={text(language, "Ripple: deleting or right-edge-trimming a clip shifts later clips to close/open the gap", "Сдвиг: удаление или обрезка правого края клипа сдвигает следующие клипы, закрывая или открывая пробел")}>{text(language, "Ripple", "Сдвиг")}</button>
      <span className="video-transport-sep" />
      <button onClick={() => setPixelsPerSecond((value) => Math.max(5, value / 1.5))} title={text(language, "Zoom out", "Уменьшить")}>−</button>
      <button onClick={() => setPixelsPerSecond((value) => Math.min(1000, value * 1.5))} title={text(language, "Zoom in", "Увеличить")}>+</button>
      <span className="video-transport-sep" />
      <button onClick={() => addVideoTrack(document.id, "video")}>{text(language, "+ Video Track", "+ Видеодорожка")}</button>
      <button onClick={() => addVideoTrack(document.id, "audio")}>{text(language, "+ Audio Track", "+ Аудиодорожка")}</button>
      <button onClick={() => fileInputRef.current?.click()}>{text(language, "Import…", "Импорт…")}</button>
      <input ref={fileInputRef} type="file" accept="video/*,audio/*" multiple hidden onChange={(event) => { void importFiles(event.target.files); event.target.value = ""; }} />
      {state.selection && <button data-role="trash" onClick={() => deleteSelectedClips(document.id, rippleMode)}>{text(language, "Delete Clip", "Удалить клип")}</button>}
    </div>

    <div className="video-body">
      <div className="video-preview"><video ref={videoRef} muted playsInline /></div>

      <div className="video-track-headers">
        <div className="video-ruler-spacer" />
        {state.tracks.map((track) => <div key={track.id} className="video-track-header" data-track-kind={track.kind} style={{ height: TRACK_HEIGHT }}>
          <input className="video-track-name" value={track.name} onChange={(event) => void changeVideoDocument(document.id, "Rename Track (Переименовать дорожку)", (draft) => { const found = draft.tracks.find((item) => item.id === track.id); if (!found) return false; found.name = event.target.value; return true; })} />
          <div className="video-track-controls">
            {track.kind === "video" && <button className={track.hidden ? "active" : ""} onClick={() => setTrackHidden(document.id, track.id, !track.hidden)} title={text(language, "Hide", "Скрыть")}>👁</button>}
            <button className={track.muted ? "active" : ""} onClick={() => setTrackMuted(document.id, track.id, !track.muted)} title={text(language, "Mute", "Заглушить")}>M</button>
            <button className={track.locked ? "active" : ""} onClick={() => setTrackLocked(document.id, track.id, !track.locked)} title={text(language, "Lock", "Заблокировать")}>🔒</button>
            <button disabled={state.tracks.length <= 1} onClick={() => removeVideoTrack(document.id, track.id)} title={text(language, "Delete track", "Удалить дорожку")}>×</button>
          </div>
          <label className="video-track-slider"><span>{text(language, "Vol", "Гр")}</span><input type="range" min={0} max={1.5} step={0.01} value={track.volume} onChange={(event) => setTrackVolume(document.id, track.id, event.target.valueAsNumber)} /></label>
        </div>)}
      </div>

      <div className="video-timeline-scroll">
        <div className="video-ruler" style={{ width: timelineWidthPx }} onClick={onRulerClick}>
          {Array.from({ length: Math.ceil(timelineWidthPx / pixelsPerSecond) + 1 }, (_, second) => <span key={second} className="video-ruler-tick" style={{ left: second * pixelsPerSecond }}>{formatTime(second)}</span>)}
          <div className="video-playhead" style={{ left: playheadFrame * pxPerFrame }} />
        </div>
        <div className="video-tracks" style={{ width: timelineWidthPx }} onPointerMove={onDragMove} onPointerUp={onDragEnd}>
          <div className="video-playhead video-playhead-body" style={{ left: playheadFrame * pxPerFrame }} />
          {state.tracks.map((track) => <div key={track.id} className="video-track-lane" data-track-kind={track.kind} style={{ height: TRACK_HEIGHT }} onClick={() => setSelection(document.id, null, [])}>
            {track.clips.map((clip) => {
              const selected = state.selection?.trackId === track.id && state.selection.clipIds.includes(clip.id);
              const left = clip.startFrame * pxPerFrame, width = Math.max(4, clip.durationFrames * pxPerFrame);
              return <div key={clip.id} className={`video-clip${selected ? " selected" : ""}`} data-track-kind={track.kind} style={{ left, width, height: TRACK_HEIGHT - 6 }}
                onPointerDown={(event) => beginDrag(event, "move", track, clip)}
                onClick={(event) => { event.stopPropagation(); onClipClick(track, clip, event); }}>
                <div className="video-clip-trim video-clip-trim-left" style={{ width: TRIM_HANDLE_PX }} onPointerDown={(event) => beginDrag(event, "trim-left", track, clip)} />
                <span className="video-clip-name">{clip.name}</span>
                <span className="video-clip-duration">{formatTime(clip.durationFrames / frameRate)}</span>
                <div className="video-clip-trim video-clip-trim-right" style={{ width: TRIM_HANDLE_PX }} onPointerDown={(event) => beginDrag(event, "trim-right", track, clip)} />
              </div>;
            })}
          </div>)}
        </div>
      </div>
    </div>
  </div>;
}
