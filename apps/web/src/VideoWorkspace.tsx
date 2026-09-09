import { useCallback, useEffect, useRef, useState } from "react";
import type { VravioDocument } from "@vravio/kernel";
import {
  applyCropEdge, isVideoDocumentState, snapFrame, timelineDurationFrames, type VideoClip, type VideoDocumentState, type VideoTrack,
} from "@vravio/env-video";
import { kernel } from "./kernel";
import { useShellStore } from "./store";
import { text } from "./i18n";
import {
  addClipFromAsset, addVideoTrack, changeVideoDocument, commitVideoDrag, deleteSelectedClips, previewMoveClip, previewTrimClip,
  removeVideoTrack, setClipCrop, setClipTransform, setSelection, setTrackHidden, setTrackLocked, setTrackMuted, setTrackVolume, splitClipAt,
} from "./video-commands";
import { probeVideoMetadata } from "./videoImport";
import { VideoCompositor } from "./videoCompositor";
import { exportVideoDocument } from "./videoExport";

const TRACK_HEIGHT = 56;
const TRIM_HANDLE_PX = 8;
const DEFAULT_PIXELS_PER_SECOND = 80;
const SNAP_THRESHOLD_PX = 8;

function formatTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60), rest = seconds - minutes * 60;
  return `${minutes}:${rest.toFixed(2).padStart(5, "0")}`;
}

/** Every clip-edge frame on `tracks` except those belonging to `excludeClipId` — the candidate
 * set `snapFrame` magnetizes a drag toward (docs/master-plan.md §9.1's `snapping` checklist
 * item). Includes 0 and the playhead itself so a drag can also land exactly on either. */
function snapTargets(tracks: readonly VideoTrack[], excludeClipId: string, playheadFrame: number): number[] {
  const targets = [0, playheadFrame];
  for (const track of tracks) for (const clip of track.clips) {
    if (clip.id === excludeClipId) continue;
    targets.push(clip.startFrame, clip.startFrame + clip.durationFrames);
  }
  return targets;
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
  const [workspaceMode, setWorkspaceMode] = useState<"edit" | "effects" | "audio" | "export">("edit");
  const [pixelsPerSecond, setPixelsPerSecond] = useState(DEFAULT_PIXELS_PER_SECOND);
  const [playheadFrame, setPlayheadFrame] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [splitMode, setSplitMode] = useState(false);
  const [rippleMode, setRippleMode] = useState(false);
  const [snapMode, setSnapMode] = useState(true);
  const [exportProgress, setExportProgress] = useState<{ frame: number; durationFrames: number } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const compositorRef = useRef<VideoCompositor | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!isVideoDocumentState(document.state)) return <div className="workspace-error">Invalid video document state</div>;
  const state = document.state;
  const frameRate = state.frameRate;
  const durationFrames = Math.max(frameRate * 5, timelineDurationFrames(state));
  const pxPerFrame = pixelsPerSecond / frameRate;
  const snapThresholdFrames = Math.max(1, Math.round(SNAP_THRESHOLD_PX / pxPerFrame));

  const compositor = () => (compositorRef.current ??= new VideoCompositor());
  useEffect(() => { if (canvasRef.current) compositor().attachCanvas(canvasRef.current); }, []);
  useEffect(() => () => { compositorRef.current?.dispose(); compositorRef.current = null; }, [document.id]);

  const stopPlayback = useCallback(() => {
    compositorRef.current?.pause();
    setIsPlaying(false);
  }, []);

  // Paints the composited frame under the playhead, paused — every visible video track's
  // current clip, alpha-blended per `compositor-math.ts` (`VideoCompositor.renderFrame`), not
  // just the topmost one.
  // `document.state` is mutated in place (`kernel.documents.update`, docs/master-plan.md's own
  // documented convention) — its reference never changes, so `document.revision` (a plain number
  // bumped on every mutation) is the dependency that actually tells this effect something
  // changed, the same trap `ToolContext.state` already caught elsewhere in this codebase
  // (CLAUDE.md §2: "a snapshot on the moment of construction, not a live value").
  useEffect(() => { if (!isPlaying) compositor().renderFrame(state, playheadFrame); }, [playheadFrame, isPlaying, document.revision]);

  // Plays every track's active clip in real time, compositing continuously — a real master
  // clock (`VideoCompositor`'s own wall-clock timer), not any single clip's playback rate. Stops
  // automatically once the playhead passes the last clip on the timeline.
  const startPlayback = useCallback(() => {
    compositor().onFrame((frame) => setPlayheadFrame(frame));
    compositor().onEnded(() => { setIsPlaying(false); setPlayheadFrame(0); });
    compositor().play(state, playheadFrame);
    setIsPlaying(true);
  }, [state, playheadFrame]);

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
    let deltaFrames = Math.round(deltaPx / pxPerFrame) - drag.appliedFrames;
    if (deltaFrames === 0) return;

    if (snapMode) {
      const live = kernel.documents.get<VideoDocumentState>(document.id)!.state as VideoDocumentState;
      const liveClip = live.tracks.find((item) => item.id === drag.trackId)?.clips.find((item) => item.id === drag.clipId);
      if (liveClip) {
        const targets = snapTargets(live.tracks, drag.clipId, playheadFrame);
        const edgeFrame = drag.kind === "move" ? liveClip.startFrame
          : drag.kind === "trim-left" ? liveClip.startFrame
          : liveClip.startFrame + liveClip.durationFrames;
        const snapped = snapFrame(edgeFrame + deltaFrames, targets, snapThresholdFrames);
        deltaFrames = snapped - edgeFrame;
      }
    }
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
      await addClipFromAsset(document.id, assetId, file.name, durationFramesForClip, meta?.frameRate ?? frameRate, isAudio ? "audio" : "video", undefined, at, meta?.width ?? 0, meta?.height ?? 0);
    }
  };

  const exportVideo = async () => {
    if (exportProgress) return;
    stopPlayback();
    setExportProgress({ frame: 0, durationFrames });
    try {
      const current = kernel.documents.get<VideoDocumentState>(document.id)!.state;
      const blob = await exportVideoDocument(current, (progress) => setExportProgress(progress));
      const name = `${document.name.replace(/\.[^.]+$/, "").trim() || "export"}.webm`;
      await kernel.platform.fs.saveFile({ name, mime: blob.type || "video/webm", data: blob });
    } finally {
      setExportProgress(null);
    }
  };

  const timelineWidthPx = Math.max(400, Math.round((durationFrames / frameRate) * pixelsPerSecond) + 100);
  const selectedTrack = state.selection ? state.tracks.find((track) => track.id === state.selection!.trackId) : undefined;
  const selectedClip = selectedTrack && state.selection!.clipIds.length === 1 ? selectedTrack.clips.find((clip) => clip.id === state.selection!.clipIds[0]) : undefined;
  const clipCount = state.tracks.reduce((count, track) => count + track.clips.length, 0);

  return <div className="video-workspace">
    <header className="media-workspace-switcher" aria-label={text(language, "Video workspaces", "Рабочие среды видео")}>
      {([
        ["edit", "Edit", "Монтаж"],
        ["effects", "Effects", "Эффекты"],
        ["audio", "Audio", "Аудио"],
        ["export", "Export", "Экспорт"],
      ] as const).map(([id, en, ru]) => <button key={id} className={workspaceMode === id ? "active" : ""} onClick={() => setWorkspaceMode(id)}>{text(language, en, ru)}</button>)}
      <button className="media-workspace-planned" disabled title={text(language, "Colour tools need the planned colour-management and scopes stage", "Инструменты цвета появятся после этапа управления цветом и scopes")}>{text(language, "Color", "Цвет")}</button>
      <span className="media-workspace-meta">{state.width}×{state.height} · {frameRate} fps · {state.tracks.length} {text(language, "tracks", "дорожек")}</span>
    </header>
    <div className="video-transport">
      <div className="media-control-group" aria-label={text(language, "Transport", "Транспорт")}>
        <button className="media-icon-button" onClick={togglePlay} title={text(language, "Play/Pause", "Играть/Пауза")} aria-label={text(language, "Play/Pause", "Играть/Пауза")}>{isPlaying ? "Ⅱ" : "▶"}</button>
        <button className="media-icon-button" onClick={stopToStart} title={text(language, "Stop", "Стоп")} aria-label={text(language, "Stop", "Стоп")}>■</button>
      </div>
      <span className="video-time">{formatTime(playheadFrame / frameRate)} / {formatTime(durationFrames / frameRate)}</span>
      {state.selection && <button data-role="trash" onClick={() => deleteSelectedClips(document.id, rippleMode)}>{text(language, "Delete Clip", "Удалить клип")}</button>}
    </div>
    <div className="media-edit-toolbar" aria-label={text(language, "Timeline tools", "Инструменты таймлайна")}>
      <div className="media-control-group">
        <button className={splitMode ? "active" : ""} onClick={() => setSplitMode((value) => !value)} title={text(language, "Split tool", "Инструмент разреза")}>{text(language, "Split", "Разрез")}</button>
        <button className={rippleMode ? "active" : ""} onClick={() => setRippleMode((value) => !value)} title={text(language, "Ripple: deleting or right-edge-trimming a clip shifts later clips to close/open the gap", "Сдвиг: удаление или обрезка правого края клипа сдвигает следующие клипы, закрывая или открывая пробел")}>{text(language, "Ripple", "Сдвиг")}</button>
        <button className={snapMode ? "active" : ""} onClick={() => setSnapMode((value) => !value)} title={text(language, "Snap clip edges to other clips, the playhead and frame 0", "Привязка краёв клипа к другим клипам, плейхеду и нулевому кадру")}>{text(language, "Snap", "Привязка")}</button>
      </div>
      <div className="media-control-group media-zoom-group">
        <button className="media-icon-button" onClick={() => setPixelsPerSecond((value) => Math.max(5, value / 1.5))} title={text(language, "Zoom out", "Уменьшить")} aria-label={text(language, "Zoom out", "Уменьшить")}>−</button>
        <button className="media-icon-button" onClick={() => setPixelsPerSecond((value) => Math.min(1000, value * 1.5))} title={text(language, "Zoom in", "Увеличить")} aria-label={text(language, "Zoom in", "Увеличить")}>+</button>
      </div>
      <div className="media-project-actions">
        <button onClick={() => addVideoTrack(document.id, "video")}>{text(language, "+ Video", "+ Видео")}</button>
        <button onClick={() => addVideoTrack(document.id, "audio")}>{text(language, "+ Audio", "+ Аудио")}</button>
        <button onClick={() => fileInputRef.current?.click()}>{text(language, "Import…", "Импорт…")}</button>
        <input ref={fileInputRef} type="file" accept="video/*,audio/*" multiple hidden onChange={(event) => { void importFiles(event.target.files); event.target.value = ""; }} />
        <button disabled={!!exportProgress} onClick={() => void exportVideo()} title={text(language, "Export renders the timeline in real time (capture, not an instant offline encode) — takes as long as the video itself", "Экспорт рендерит таймлайн в реальном времени (захват, а не мгновенный офлайн-рендер) — займёт столько же, сколько сам ролик")}>
          {exportProgress ? `${text(language, "Exporting…", "Экспорт…")} ${Math.round((exportProgress.frame / exportProgress.durationFrames) * 100)}%` : text(language, "Export…", "Экспорт…")}
        </button>
      </div>
    </div>

    {workspaceMode === "audio" && <section className="video-workspace-strip" aria-label={text(language, "Audio timeline", "Аудиодорожки")}>
      <strong>{text(language, "Audio timeline", "Аудиодорожки")}</strong>
      <span>{text(language, "Audio clips and tracks use amber; mute and volume remain available in each track header.", "Аудиоклипы и дорожки отмечены янтарным; заглушение и громкость доступны в заголовке каждой дорожки.")}</span>
    </section>}
    {workspaceMode === "effects" && <section className="video-workspace-strip" aria-label={text(language, "Clip inspector", "Инспектор клипа")}>
      <strong>{text(language, "Clip inspector", "Инспектор клипа")}</strong>
      <span>{selectedClip ? text(language, "Transform and crop controls for the selected clip are shown below.", "Ниже показаны параметры трансформации и кропа выбранного клипа.") : text(language, "Select one video clip to edit its transform and crop.", "Выберите один видеоклип для изменения трансформации и кропа.")}</span>
    </section>}
    {workspaceMode === "export" && <section className="video-export-panel" aria-label={text(language, "Export", "Экспорт")}>
      <div><strong>{text(language, "Export timeline", "Экспорт таймлайна")}</strong><span>{state.width}×{state.height} · {frameRate} fps · WebM</span></div>
      <p>{text(language, "The browser renderer exports the whole timeline in real time. Additional codecs and an export queue belong to the desktop render stage.", "Браузерный рендер экспортирует весь таймлайн в реальном времени. Другие кодеки и очередь экспорта относятся к desktop-этапу рендеринга.")}</p>
      <button disabled={!!exportProgress} onClick={() => void exportVideo()}>{exportProgress ? `${text(language, "Exporting…", "Экспорт…")} ${Math.round((exportProgress.frame / exportProgress.durationFrames) * 100)}%` : text(language, "Export WebM…", "Экспортировать WebM…")}</button>
    </section>}

    {selectedClip && selectedTrack?.kind === "video" && <div className="video-clip-inspector" aria-label={text(language, "Selected clip properties", "Свойства выбранного клипа")}>
      <label><span>{text(language, "X", "X")}</span><input type="number" step={1} value={Math.round(selectedClip.x)} onChange={(event) => setClipTransform(document.id, selectedTrack.id, selectedClip.id, { x: event.target.valueAsNumber || 0 })} /></label>
      <label><span>{text(language, "Y", "Y")}</span><input type="number" step={1} value={Math.round(selectedClip.y)} onChange={(event) => setClipTransform(document.id, selectedTrack.id, selectedClip.id, { y: event.target.valueAsNumber || 0 })} /></label>
      <label><span>{text(language, "Scale", "Масштаб")}</span><input type="range" min={0.05} max={3} step={0.01} value={selectedClip.scale} onChange={(event) => setClipTransform(document.id, selectedTrack.id, selectedClip.id, { scale: event.target.valueAsNumber })} /></label>
      <label><span>{text(language, "Opacity", "Прозрачность")}</span><input type="range" min={0} max={1} step={0.01} value={selectedClip.opacity} onChange={(event) => setClipTransform(document.id, selectedTrack.id, selectedClip.id, { opacity: event.target.valueAsNumber })} /></label>
      <span className="video-transport-sep" />
      <label><span>{text(language, "Crop L", "Кроп Л")}</span><input type="range" min={0} max={0.9} step={0.01} value={selectedClip.cropLeft} onChange={(event) => setClipCrop(document.id, selectedTrack.id, selectedClip.id, "left", event.target.valueAsNumber)} /></label>
      <label><span>{text(language, "Crop T", "Кроп В")}</span><input type="range" min={0} max={0.9} step={0.01} value={selectedClip.cropTop} onChange={(event) => setClipCrop(document.id, selectedTrack.id, selectedClip.id, "top", event.target.valueAsNumber)} /></label>
      <label><span>{text(language, "Crop R", "Кроп П")}</span><input type="range" min={0} max={0.9} step={0.01} value={selectedClip.cropRight} onChange={(event) => setClipCrop(document.id, selectedTrack.id, selectedClip.id, "right", event.target.valueAsNumber)} /></label>
      <label><span>{text(language, "Crop B", "Кроп Н")}</span><input type="range" min={0} max={0.9} step={0.01} value={selectedClip.cropBottom} onChange={(event) => setClipCrop(document.id, selectedTrack.id, selectedClip.id, "bottom", event.target.valueAsNumber)} /></label>
      <button onClick={() => setClipTransform(document.id, selectedTrack.id, selectedClip.id, { x: 0, y: 0, scale: 1, opacity: 1 })}>{text(language, "Reset transform", "Сбросить трансформацию")}</button>
    </div>}

    <div className="video-body">
      <div className="video-preview"><header><strong>{text(language, "Program", "Программа")}</strong><span>{formatTime(playheadFrame / frameRate)} · {state.width}×{state.height}</span></header><canvas ref={canvasRef} width={state.width} height={state.height} /></div>

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
    <footer className="video-workspace-footer"><span>{text(language, "Timeline", "Таймлайн")}: {clipCount} {text(language, "clips", "клипов")}</span><span>{snapMode ? text(language, "Snapping on", "Прилипание включено") : text(language, "Snapping off", "Прилипание выключено")}</span></footer>
  </div>;
}
