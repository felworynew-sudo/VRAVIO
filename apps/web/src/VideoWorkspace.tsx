import { useCallback, useEffect, useRef, useState } from "react";
import type { VravioDocument } from "@vravio/kernel";
import {
  applyCropEdge, cloneVideoState, effectiveClipValue, isVideoDocumentState, snapFrame, timelineDurationFrames, videoEffectCatalog,
  type VideoClip, type VideoDocumentState, type VideoEffectId, type VideoKeyframeableParam, type VideoTrack,
} from "@vravio/env-video";
import { kernel } from "./kernel";
import { useShellStore } from "./store";
import { text } from "./i18n";
import {
  addClipEffect, addTitleClip, addTransition, addVideoMarker, addVideoTrack, changeVideoDocument, commitVideoDrag, deleteSelectedClips,
  importToBin, insertBinItemToTimeline, moveVideoMarker, previewClipEffectParam, previewMoveClip, previewTrimClip, removeBinItem,
  removeClipEffect, removeTransition, removeVideoMarker, removeVideoTrack, renameVideoMarker, reorderClipEffect, resetClipTransform,
  setClipCrop, setClipEffectEnabled, setClipParamAtPlayhead, setSelection, setTitleStyle, setTitleText, setTrackHidden, setTrackLocked,
  setTrackMuted, setTrackVolume, splitClipAt, toggleClipKeyframeAtPlayhead,
} from "./video-commands";
import { probeVideoMetadata } from "./videoImport";
import { assetUrl, VideoCompositor } from "./videoCompositor";
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
  const [shuttleRate, setShuttleRate] = useState(1);
  const [splitMode, setSplitMode] = useState(false);
  const [rippleMode, setRippleMode] = useState(false);
  const [snapMode, setSnapMode] = useState(true);
  const [exportProgress, setExportProgress] = useState<{ frame: number; durationFrames: number } | null>(null);
  const [previewMode, setPreviewMode] = useState<"program" | "source">("program");
  const [sourceBinItemId, setSourceBinItemId] = useState<string | null>(null);
  const [sourceInFrame, setSourceInFrame] = useState(0);
  const [sourceOutFrame, setSourceOutFrame] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const compositorRef = useRef<VideoCompositor | null>(null);
  const sourceVideoRef = useRef<HTMLVideoElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const markerDragRef = useRef<{ markerId: string; before: VideoDocumentState } | null>(null);

  if (!isVideoDocumentState(document.state)) return <div className="workspace-error">Invalid video document state</div>;
  const state = document.state;
  const frameRate = state.frameRate;
  const durationFrames = Math.max(frameRate * 5, timelineDurationFrames(state));
  const pxPerFrame = pixelsPerSecond / frameRate;
  const snapThresholdFrames = Math.max(1, Math.round(SNAP_THRESHOLD_PX / pxPerFrame));

  const compositor = () => (compositorRef.current ??= new VideoCompositor());
  // Switching between two *video* documents (clicking a different video tab) doesn't remount
  // this component — React sees the same `VideoWorkspace` component type at the same position
  // in the tree and reuses the fiber, only updating props, since nothing here keys the element
  // on `document.id`. So the dispose-on-document-change effect below nulls `compositorRef`, but
  // without this effect also depending on `document.id`, the freshly (lazily) recreated
  // compositor next render never gets `attachCanvas` called on it — same symptom as the
  // Program/Source mount bug fixed above, different trigger. Found live: a second video document
  // opened in the same tab stayed solid black forever, timecode and frame math still advancing
  // correctly, because the new compositor instance's `#canvas` was simply never set.
  useEffect(() => { if (canvasRef.current) compositor().attachCanvas(canvasRef.current); }, [document.id]);
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
  // automatically once the playhead passes the last clip on the timeline (forward) or frame 0
  // (reverse shuttle). `rate` is the J/K/L shuttle speed — 1 for the plain transport button.
  const startPlayback = useCallback((rate = 1) => {
    compositor().onFrame((frame) => setPlayheadFrame(frame));
    // A reverse shuttle running off the front of the timeline stops at frame 0 rather than
    // resetting to it — `onEnded` fires there too (`VideoCompositor.play`'s own reverse-floor
    // branch), and forward `onEnded` resetting the playhead to 0 would be wrong for that case.
    compositor().onEnded(() => { setIsPlaying(false); setShuttleRate(1); });
    compositor().play(state, playheadFrame, rate);
    setShuttleRate(rate);
    setIsPlaying(true);
  }, [state, playheadFrame]);

  const togglePlay = () => { if (isPlaying) stopPlayback(); else startPlayback(1); };
  const stopToStart = () => { stopPlayback(); setPlayheadFrame(0); };

  // J/K/L shuttle transport (Premiere/Resolve convention): L steps forward through 1x/2x/4x/8x on
  // repeated presses, J the mirror in reverse, K stops. Ignored while a text field has focus, and
  // only for the workspace's own active document — the same guard `VectorWorkspace.tsx`'s own
  // keydown handler uses so a shortcut meant for one open document doesn't also fire in another.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (useShellStore.getState().activeDocumentId !== document.id) return;
      const target = event.target as HTMLElement | null;
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable) return;
      if (event.key !== "j" && event.key !== "J" && event.key !== "k" && event.key !== "K" && event.key !== "l" && event.key !== "L") return;
      event.preventDefault();
      const key = event.key.toLowerCase();
      if (key === "k") { stopPlayback(); setShuttleRate(1); return; }
      if (key === "l") {
        const next = isPlaying && shuttleRate > 0 ? Math.min(8, shuttleRate * 2) : 1;
        startPlayback(next);
        return;
      }
      const next = isPlaying && shuttleRate < 0 ? Math.max(-8, shuttleRate * 2) : -1;
      startPlayback(next);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [document.id, isPlaying, shuttleRate, startPlayback, stopPlayback]);

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

  // Import lands in the Project bin, not straight on the timeline — the donor "import then
  // place" split (docs/master-plan.md §33.3's Монтаж layout: a Project/Bin panel distinct from
  // the timeline). Placing a bin item onto a track is `insertFromSource` below, via the Source
  // monitor's own Insert button, same as double-clicking a bin row to load it there first does.
  const importFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    for (const file of Array.from(files)) {
      const isAudio = file.type.startsWith("audio/");
      const meta = isAudio ? null : await probeVideoMetadata(file, frameRate);
      if (!isAudio && !meta) continue; // browser could not decode this file's metadata at all
      const assetId = await kernel.assets.importAsset(file, { kind: isAudio ? "audio" : "video", mime: file.type || "video/mp4", name: file.name, ...(meta ? { meta: meta as unknown as Record<string, unknown> } : {}) });
      const durationFramesForClip = meta?.durationFrames ?? Math.round(frameRate * 5); // audio: real duration deferred, see below
      importToBin(document.id, assetId, file.name, isAudio ? "audio" : "video", durationFramesForClip, meta?.frameRate ?? frameRate, meta?.width ?? 0, meta?.height ?? 0);
    }
  };

  // Loads a bin item into the Source monitor, marked in/out defaulting to the item's full length
  // — the same "double-click a bin row" entry point every donor NLE uses.
  const loadIntoSource = (binItemId: string) => {
    const item = state.bin.find((entry) => entry.id === binItemId);
    if (!item) return;
    setSourceBinItemId(binItemId);
    setSourceInFrame(0);
    setSourceOutFrame(item.sourceDurationFrames);
    setPreviewMode("source");
    void assetUrl(item.assetId).then((url) => { if (sourceVideoRef.current) sourceVideoRef.current.src = url; });
  };

  const sourceBinItem = sourceBinItemId ? state.bin.find((entry) => entry.id === sourceBinItemId) : undefined;

  const markSourceIn = () => { const video = sourceVideoRef.current; if (!video || !sourceBinItem) return; setSourceInFrame(Math.min(sourceOutFrame - 1, Math.round(video.currentTime * sourceBinItem.sourceFrameRate))); };
  const markSourceOut = () => { const video = sourceVideoRef.current; if (!video || !sourceBinItem) return; setSourceOutFrame(Math.max(sourceInFrame + 1, Math.round(video.currentTime * sourceBinItem.sourceFrameRate))); };

  const insertFromSource = () => {
    if (!sourceBinItem) return;
    insertBinItemToTimeline(document.id, sourceBinItem.id, state.selection?.trackId, playheadFrame, sourceInFrame, sourceOutFrame);
  };

  /** The Inspector's own "stopwatch diamond" per transform field — ◆ (filled, accented) when a
   * keyframe sits exactly at the playhead, ◇ (hollow but still accented) when the parameter is
   * keyframed elsewhere, plain when it isn't keyframed at all. Clicking toggles a keyframe at
   * the playhead; the field next to it always shows/edits the *effective* (interpolated) value,
   * so scrubbing past a keyframed parameter shows what will actually render, not a stale static
   * number. */
  const keyframeToggle = (trackId: string, clipId: string, clip: VideoClip, param: VideoKeyframeableParam) => {
    const list = clip.keyframes[param];
    const hasHere = !!list?.some((kf) => Math.abs(kf.frameOnTimeline - playheadFrame) < 1);
    const hasAny = !!list?.length;
    return <button className={`video-keyframe-toggle${hasAny ? " active" : ""}`} onClick={() => toggleClipKeyframeAtPlayhead(document.id, trackId, clipId, param, playheadFrame)} title={text(language, "Toggle keyframe at playhead", "Ключевой кадр в плейхеде")}>{hasHere ? "◆" : "◇"}</button>;
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
        <button className="media-icon-button" onClick={togglePlay} title={text(language, "Play/Pause · Shuttle: J reverse, K stop, L forward — repeat J/L to speed up", "Играть/Пауза · Транспорт: J назад, K стоп, L вперёд — повтор J/L ускоряет")} aria-label={text(language, "Play/Pause", "Играть/Пауза")}>{isPlaying ? "Ⅱ" : "▶"}</button>
        <button className="media-icon-button" onClick={stopToStart} title={text(language, "Stop", "Стоп")} aria-label={text(language, "Stop", "Стоп")}>■</button>
      </div>
      <span className="video-time">{formatTime(playheadFrame / frameRate)} / {formatTime(durationFrames / frameRate)}</span>
      {isPlaying && shuttleRate !== 1 && <span className="video-shuttle-rate" title={text(language, "J/K/L shuttle speed", "Скорость J/K/L")}>{shuttleRate > 0 ? `${shuttleRate}×` : `◀${-shuttleRate}×`}</span>}
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
        <button onClick={() => addTitleClip(document.id, state.selection?.trackId, playheadFrame, text(language, "Title", "Титр"), Math.round(2 * frameRate))} title={text(language, "Add a title clip at the playhead", "Добавить титр в плейхед")}>{text(language, "+ Title", "+ Титр")}</button>
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
    {workspaceMode === "effects" && <section className="video-effects-panel" aria-label={text(language, "Effect stack", "Стек эффектов")}>
      {!selectedClip
        ? <span className="video-bin-empty">{text(language, "Select one video clip to edit its effect stack.", "Выберите один видеоклип, чтобы редактировать его стек эффектов.")}</span>
        : selectedClip.title
        ? <span className="video-bin-empty">{text(language, "Title clips don't support the effect stack yet — edit text and style on the Клип panel above.", "Титры пока не поддерживают стек эффектов — текст и стиль редактируются в панели «Клип» выше.")}</span>
        : <>
            <div className="video-effects-add">
              <strong>{text(language, "Effects", "Эффекты")}</strong>
              <select value="" onChange={(event) => { if (event.target.value) addClipEffect(document.id, selectedTrack!.id, selectedClip.id, event.target.value as VideoEffectId); }}>
                <option value="">{text(language, "+ Add effect…", "+ Добавить эффект…")}</option>
                {videoEffectCatalog.map((effect) => <option key={effect.id} value={effect.id}>{effect.name}</option>)}
              </select>
            </div>
            {selectedClip.effects.length === 0
              ? <span className="video-bin-empty">{text(language, "No effects on this clip yet.", "На этом клипе пока нет эффектов.")}</span>
              : selectedClip.effects.map((effect, index) => {
                  const definition = videoEffectCatalog.find((item) => item.id === effect.effectId);
                  return <div key={effect.id} className={`video-effect-row${effect.enabled ? "" : " bypassed"}`}>
                    <div className="video-effect-header">
                      <button className={effect.enabled ? "active" : ""} onClick={() => setClipEffectEnabled(document.id, selectedTrack!.id, selectedClip.id, effect.id, !effect.enabled)} title={text(language, "Bypass", "Обойти")}>👁</button>
                      <span>{definition?.name ?? effect.effectId}</span>
                      <button disabled={index === 0} onClick={() => reorderClipEffect(document.id, selectedTrack!.id, selectedClip.id, effect.id, "up")} title={text(language, "Move up", "Выше")}>↑</button>
                      <button disabled={index === selectedClip.effects.length - 1} onClick={() => reorderClipEffect(document.id, selectedTrack!.id, selectedClip.id, effect.id, "down")} title={text(language, "Move down", "Ниже")}>↓</button>
                      <button onClick={() => removeClipEffect(document.id, selectedTrack!.id, selectedClip.id, effect.id)} title={text(language, "Remove effect", "Убрать эффект")}>×</button>
                    </div>
                    {definition?.parameters.map((param) => <label key={param.id} className="video-effect-param">
                      <span>{param.name}</span>
                      <input type="range" min={param.min} max={param.max} step={param.step} value={effect.params[param.id] ?? param.value}
                        onChange={(event) => previewClipEffectParam(document.id, selectedTrack!.id, selectedClip.id, effect.id, param.id, event.target.valueAsNumber)} />
                      <output>{effect.params[param.id] ?? param.value}</output>
                    </label>)}
                  </div>;
                })}
          </>}
    </section>}
    {workspaceMode === "export" && <section className="video-export-panel" aria-label={text(language, "Export", "Экспорт")}>
      <div><strong>{text(language, "Export timeline", "Экспорт таймлайна")}</strong><span>{state.width}×{state.height} · {frameRate} fps · WebM</span></div>
      <p>{text(language, "The browser renderer exports the whole timeline in real time. Additional codecs and an export queue belong to the desktop render stage.", "Браузерный рендер экспортирует весь таймлайн в реальном времени. Другие кодеки и очередь экспорта относятся к desktop-этапу рендеринга.")}</p>
      <button disabled={!!exportProgress} onClick={() => void exportVideo()}>{exportProgress ? `${text(language, "Exporting…", "Экспорт…")} ${Math.round((exportProgress.frame / exportProgress.durationFrames) * 100)}%` : text(language, "Export WebM…", "Экспортировать WebM…")}</button>
    </section>}

    {selectedClip && selectedTrack?.kind === "video" && <div className="video-clip-inspector" aria-label={text(language, "Selected clip properties", "Свойства выбранного клипа")}>
      <label>{keyframeToggle(selectedTrack.id, selectedClip.id, selectedClip, "x")}<span>{text(language, "X", "X")}</span><input type="number" step={1} value={Math.round(effectiveClipValue(selectedClip, "x", playheadFrame))} onChange={(event) => setClipParamAtPlayhead(document.id, selectedTrack.id, selectedClip.id, "x", playheadFrame, event.target.valueAsNumber || 0)} /></label>
      <label>{keyframeToggle(selectedTrack.id, selectedClip.id, selectedClip, "y")}<span>{text(language, "Y", "Y")}</span><input type="number" step={1} value={Math.round(effectiveClipValue(selectedClip, "y", playheadFrame))} onChange={(event) => setClipParamAtPlayhead(document.id, selectedTrack.id, selectedClip.id, "y", playheadFrame, event.target.valueAsNumber || 0)} /></label>
      <label>{keyframeToggle(selectedTrack.id, selectedClip.id, selectedClip, "scale")}<span>{text(language, "Scale", "Масштаб")}</span><input type="range" min={0.05} max={3} step={0.01} value={effectiveClipValue(selectedClip, "scale", playheadFrame)} onChange={(event) => setClipParamAtPlayhead(document.id, selectedTrack.id, selectedClip.id, "scale", playheadFrame, event.target.valueAsNumber)} /></label>
      <label>{keyframeToggle(selectedTrack.id, selectedClip.id, selectedClip, "opacity")}<span>{text(language, "Opacity", "Прозрачность")}</span><input type="range" min={0} max={1} step={0.01} value={effectiveClipValue(selectedClip, "opacity", playheadFrame)} onChange={(event) => setClipParamAtPlayhead(document.id, selectedTrack.id, selectedClip.id, "opacity", playheadFrame, event.target.valueAsNumber)} /></label>
      <span className="video-transport-sep" />
      {selectedClip.title
        ? <>
            <input className="video-title-text" value={selectedClip.title.text} placeholder={text(language, "Title text", "Текст титра")} onChange={(event) => setTitleText(document.id, selectedTrack.id, selectedClip.id, event.target.value)} />
            <label><span>{text(language, "Size", "Размер")}</span><input type="range" min={12} max={200} step={1} value={selectedClip.title.fontSize} onChange={(event) => setTitleStyle(document.id, selectedTrack.id, selectedClip.id, { fontSize: event.target.valueAsNumber })} /></label>
            <label><span>{text(language, "Color", "Цвет")}</span><input type="color" value={selectedClip.title.color} onChange={(event) => setTitleStyle(document.id, selectedTrack.id, selectedClip.id, { color: event.target.value })} /></label>
            <div className="media-control-group">
              {(["left", "center", "right"] as const).map((align) => <button key={align} className={selectedClip.title!.align === align ? "active" : ""} onClick={() => setTitleStyle(document.id, selectedTrack.id, selectedClip.id, { align })}>{align === "left" ? "⯇" : align === "right" ? "⯈" : "≡"}</button>)}
            </div>
          </>
        : <>
            <label><span>{text(language, "Crop L", "Кроп Л")}</span><input type="range" min={0} max={0.9} step={0.01} value={selectedClip.cropLeft} onChange={(event) => setClipCrop(document.id, selectedTrack.id, selectedClip.id, "left", event.target.valueAsNumber)} /></label>
            <label><span>{text(language, "Crop T", "Кроп В")}</span><input type="range" min={0} max={0.9} step={0.01} value={selectedClip.cropTop} onChange={(event) => setClipCrop(document.id, selectedTrack.id, selectedClip.id, "top", event.target.valueAsNumber)} /></label>
            <label><span>{text(language, "Crop R", "Кроп П")}</span><input type="range" min={0} max={0.9} step={0.01} value={selectedClip.cropRight} onChange={(event) => setClipCrop(document.id, selectedTrack.id, selectedClip.id, "right", event.target.valueAsNumber)} /></label>
            <label><span>{text(language, "Crop B", "Кроп Н")}</span><input type="range" min={0} max={0.9} step={0.01} value={selectedClip.cropBottom} onChange={(event) => setClipCrop(document.id, selectedTrack.id, selectedClip.id, "bottom", event.target.valueAsNumber)} /></label>
          </>}
      <button onClick={() => resetClipTransform(document.id, selectedTrack.id, selectedClip.id)}>{text(language, "Reset transform", "Сбросить трансформацию")}</button>
    </div>}

    <div className="video-body">
      <div className="video-preview">
        <header>
          <span className="video-preview-tabs">
            <button className={previewMode === "program" ? "active" : ""} onClick={() => setPreviewMode("program")}>{text(language, "Program", "Программа")}</button>
            {sourceBinItem && <button className={previewMode === "source" ? "active" : ""} onClick={() => setPreviewMode("source")}>{text(language, "Source", "Исходник")}</button>}
          </span>
          <span>{previewMode === "program" ? `${formatTime(playheadFrame / frameRate)} · ${state.width}×${state.height}` : sourceBinItem ? `${formatTime(sourceInFrame / sourceBinItem.sourceFrameRate)} – ${formatTime(sourceOutFrame / sourceBinItem.sourceFrameRate)}` : ""}</span>
        </header>
        {/* Both stay mounted, toggled by `hidden`, rather than an either/or conditional render —
            unmounting the canvas would drop the DOM node `attachCanvas`'s one-time mount effect
            (below) attached the compositor to, leaving it painting into a detached element the
            next time this mode was picked again. Found live: the Program monitor stayed solid
            black after a round trip through Source, even though frame/time math kept advancing
            correctly — the compositor was still running, just against a canvas nothing showed. */}
        <canvas ref={canvasRef} width={state.width} height={state.height} hidden={previewMode !== "program"} />
        <video ref={sourceVideoRef} hidden={previewMode !== "source"} />
        {previewMode === "source" && sourceBinItem && <div className="video-source-transport">
          <button className="media-icon-button" onClick={() => sourceVideoRef.current?.play()} title={text(language, "Play", "Играть")}>▶</button>
          <button className="media-icon-button" onClick={() => sourceVideoRef.current?.pause()} title={text(language, "Pause", "Пауза")}>Ⅱ</button>
          <button onClick={markSourceIn} title={text(language, "Mark In (I)", "Отметить начало (I)")}>{text(language, "In", "Начало")}</button>
          <button onClick={markSourceOut} title={text(language, "Mark Out (O)", "Отметить конец (O)")}>{text(language, "Out", "Конец")}</button>
          <button data-role="primary" onClick={insertFromSource} title={text(language, "Insert the marked range at the playhead on the selected track", "Вставить отмеченный диапазон в плейхед на выбранной дорожке")}>{text(language, "Insert", "Вставить")}</button>
        </div>}
      </div>

      <div className="video-track-headers">
        <div className="video-bin" aria-label={text(language, "Project bin", "Корзина проекта")}>
          <strong>{text(language, "Bin", "Корзина")}</strong>
          {state.bin.length === 0
            ? <span className="video-bin-empty">{text(language, "Import media to add it here", "Импортируйте материалы, чтобы они появились здесь")}</span>
            : state.bin.map((item) => <div key={item.id} className={`video-bin-item${sourceBinItemId === item.id ? " active" : ""}`} onDoubleClick={() => loadIntoSource(item.id)} title={text(language, "Double-click to open in Source", "Двойной клик — открыть в мониторе исходника")}>
                <span>{item.name}</span>
                <small>{formatTime(item.sourceDurationFrames / item.sourceFrameRate)}</small>
                <button onClick={(event) => { event.stopPropagation(); removeBinItem(document.id, item.id); if (sourceBinItemId === item.id) setSourceBinItemId(null); }} title={text(language, "Remove from bin", "Убрать из корзины")}>×</button>
              </div>)}
        </div>
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
        <div className="audio-marker-lane" style={{ width: timelineWidthPx }} onDoubleClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); addVideoMarker(document.id, Math.max(0, Math.round((event.clientX - rect.left) / pxPerFrame))); }} title={text(language, "Double-click to add a marker", "Двойной клик — добавить маркер")}>
          {state.markers.map((marker) => <div key={marker.id} className="audio-marker-flag" style={{ left: marker.frameAt * pxPerFrame }}
            onPointerDown={(event) => { event.stopPropagation(); markerDragRef.current = { markerId: marker.id, before: cloneVideoState(state) }; event.currentTarget.setPointerCapture(event.pointerId); }}
            onPointerMove={(event) => { const drag = markerDragRef.current; if (!drag || drag.markerId !== marker.id) return; const rect = event.currentTarget.parentElement!.getBoundingClientRect(); moveVideoMarker(document.id, marker.id, (event.clientX - rect.left) / pxPerFrame); }}
            onPointerUp={() => { const drag = markerDragRef.current; if (!drag) return; markerDragRef.current = null; commitVideoDrag(document.id, "Move Marker (Переместить маркер)", drag.before); }}
            onDoubleClick={(event) => { event.stopPropagation(); const next = window.prompt(text(language, "Marker name", "Имя маркера"), marker.name); if (next !== null && next.trim()) renameVideoMarker(document.id, marker.id, next.trim()); }}
            title={`${marker.name} — ${formatTime(marker.frameAt / frameRate)}`}>
            <span>{marker.name}</span>
            <button className="audio-marker-delete" onClick={(event) => { event.stopPropagation(); removeVideoMarker(document.id, marker.id); }} title={text(language, "Delete marker", "Удалить маркер")}>×</button>
          </div>)}
        </div>
        <div className="video-tracks" style={{ width: timelineWidthPx }} onPointerMove={onDragMove} onPointerUp={onDragEnd}>
          <div className="video-playhead video-playhead-body" style={{ left: playheadFrame * pxPerFrame }} />
          {state.tracks.map((track) => {
            const sortedClips = [...track.clips].sort((a, b) => a.startFrame - b.startFrame);
            return <div key={track.id} className="video-track-lane" data-track-kind={track.kind} style={{ height: TRACK_HEIGHT }} onClick={() => setSelection(document.id, null, [])}>
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
              {track.kind === "video" && sortedClips.slice(0, -1).map((clip, index) => {
                const next = sortedClips[index + 1]!;
                const touching = clip.startFrame + clip.durationFrames === next.startFrame;
                const existing = state.transitions.find((item) => item.trackId === track.id && item.leftClipId === clip.id && item.rightClipId === next.id);
                if (!touching && !existing) return null; // not adjacent and no transition already connecting them
                const left = next.startFrame * pxPerFrame;
                return <div key={`transition-${clip.id}`} className={`video-transition-marker${existing ? " active" : ""}`} style={{ left }} onClick={(event) => event.stopPropagation()}>
                  {existing
                    ? <button onClick={() => removeTransition(document.id, existing.id)} title={text(language, "Remove transition", "Убрать переход")}>⧖</button>
                    : <button onClick={() => addTransition(document.id, track.id, clip.id, next.id, Math.round(0.5 * frameRate))} title={text(language, "Add crossfade (0.5s)", "Добавить кроссфейд (0.5с)")}>+</button>}
                </div>;
              })}
            </div>;
          })}
        </div>
      </div>
    </div>
    <footer className="video-workspace-footer"><span>{text(language, "Timeline", "Таймлайн")}: {clipCount} {text(language, "clips", "клипов")}</span><span>{snapMode ? text(language, "Snapping on", "Прилипание включено") : text(language, "Snapping off", "Прилипание выключено")}</span></footer>
  </div>;
}
