import { useCallback, useEffect, useRef, useState } from "react";
import type { VravioDocument } from "@vravio/kernel";
import {
  cloneAudioState, decodeWav, generateMonoPeaks, isAudioDocumentState, mixdownAudioDocument, readPeak, timelineDurationSamples,
  type AudioClip, type AudioDocumentState, type AudioTrack, type DecodedWav,
} from "@vravio/env-audio";
import type { AssetId } from "@vravio/kernel";
import { kernel } from "./kernel";
import { useShellStore } from "./store";
import { text } from "./i18n";
import { AudioPlaybackEngine } from "./audioPlayback";
import {
  addAudioTrack, addClipFromAsset, changeAudioDocument, commitAudioDrag, deleteSelectedClips, previewMoveClip, previewTrimClip,
  removeAudioTrack, setClipFade, setClipGain, setSelection, setTrackMuted, setTrackPan, setTrackSoloed, setTrackVolume, splitClipAt,
} from "./audio-commands";
import { decodeAudioFileToWav, startMicrophoneRecording, type AudioRecorder } from "./audioImport";

const TRACK_HEIGHT = 72;
const TRIM_HANDLE_PX = 8;
const DEFAULT_PIXELS_PER_SECOND = 100;

/** Decoded audio, keyed by asset id — populated lazily as clips referencing that asset come
 * into view. Module-level (not component state): every AudioWorkspace instance for the same
 * document benefits from a decode that already happened, and a document switch away and back
 * doesn't re-read+re-decode bytes it already has. */
const decodedAssetCache = new Map<string, Promise<DecodedWav>>();

function decodedAsset(assetId: string): Promise<DecodedWav> {
  let cached = decodedAssetCache.get(assetId);
  if (!cached) {
    cached = kernel.assets.read(assetId as AssetId).then((bytes) => { if (!bytes) throw new Error(`Asset ${assetId} has no bytes`); return decodeWav(bytes); });
    decodedAssetCache.set(assetId, cached);
  }
  return cached;
}

function formatTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60), rest = seconds - minutes * 60;
  return `${minutes}:${rest.toFixed(2).padStart(5, "0")}`;
}

function WaveformCanvas({ assetId, offsetSamples, durationSamples, sourceSampleRate, widthPx, color }: {
  assetId: string; offsetSamples: number; durationSamples: number; sourceSampleRate: number; widthPx: number; color: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [decoded, setDecoded] = useState<DecodedWav | null>(null);

  useEffect(() => {
    let cancelled = false;
    void decodedAsset(assetId).then((result) => { if (!cancelled) setDecoded(result); }).catch(() => { if (!cancelled) setDecoded(null); });
    return () => { cancelled = true; };
  }, [assetId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !decoded) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const width = Math.max(1, Math.round(widthPx)), height = canvas.height;
    canvas.width = width;
    context.clearRect(0, 0, width, height);

    const sourceOffset = Math.round(offsetSamples * (decoded.sampleRate / sourceSampleRate));
    const sourceDuration = Math.max(1, Math.round(durationSamples * (decoded.sampleRate / sourceSampleRate)));
    const windowChannels = decoded.channelData.map((channel) => channel.subarray(Math.max(0, sourceOffset), Math.min(channel.length, sourceOffset + sourceDuration)));
    const samplesPerPixel = Math.max(1, Math.floor(sourceDuration / width));
    const peaks = generateMonoPeaks(windowChannels, samplesPerPixel, 16);
    const columns = Math.floor(peaks.length / 2);

    context.fillStyle = color;
    const mid = height / 2;
    for (let x = 0; x < Math.min(width, columns); x += 1) {
      const { min, max } = readPeak(peaks, x, 16);
      const top = mid - max * mid, bottom = mid - min * mid;
      context.fillRect(x, top, 1, Math.max(1, bottom - top));
    }
  }, [decoded, offsetSamples, durationSamples, sourceSampleRate, widthPx, color]);

  return <canvas ref={canvasRef} height={TRACK_HEIGHT - 8} style={{ width: `${widthPx}px`, height: `${TRACK_HEIGHT - 8}px`, display: "block" }} />;
}

interface DragState {
  readonly kind: "move" | "trim-left" | "trim-right";
  readonly trackId: string;
  readonly clipId: string;
  readonly startClientX: number;
  readonly before: AudioDocumentState;
  appliedSamples: number;
}

export function AudioWorkspace({ document }: { document: VravioDocument }) {
  const language = useShellStore((shell) => shell.language);
  const [pixelsPerSecond, setPixelsPerSecond] = useState(DEFAULT_PIXELS_PER_SECOND);
  const [playheadSample, setPlayheadSample] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [splitMode, setSplitMode] = useState(false);
  const [recorder, setRecorder] = useState<AudioRecorder | null>(null);
  const engineRef = useRef<AudioPlaybackEngine | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const rafRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const engine = () => (engineRef.current ??= new AudioPlaybackEngine());
  useEffect(() => () => { engineRef.current?.dispose(); engineRef.current = null; }, [document.id]);

  if (!isAudioDocumentState(document.state)) return <div className="workspace-error">Invalid audio document state</div>;
  const state = document.state;
  const sampleRate = state.sampleRate;
  const durationSamples = Math.max(sampleRate * 5, timelineDurationSamples(state));
  const pxPerSample = pixelsPerSecond / sampleRate;

  const stopPlayback = useCallback(() => {
    engineRef.current?.stop();
    setIsPlaying(false);
    if (rafRef.current !== null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
  }, []);

  const startPlayback = useCallback(async () => {
    const current = kernel.documents.get<AudioDocumentState>(document.id)?.state;
    if (!current) return;
    await engine().play(current, playheadSample, async (assetId) => kernel.assets.read(assetId as AssetId));
    setIsPlaying(true);
    const tick = () => {
      const eng = engineRef.current;
      if (!eng?.isPlaying) { setIsPlaying(false); rafRef.current = null; return; }
      setPlayheadSample(Math.round(eng.currentTimeSeconds() * sampleRate));
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [document.id, playheadSample, sampleRate]);

  useEffect(() => { engine().onEnded(() => { setIsPlaying(false); setPlayheadSample(0); }); }, []);
  useEffect(() => () => { if (rafRef.current !== null) cancelAnimationFrame(rafRef.current); }, []);

  const togglePlay = () => { if (isPlaying) { engineRef.current?.pause(); stopPlayback(); } else void startPlayback(); };
  const stopToStart = () => { stopPlayback(); setPlayheadSample(0); };

  const onRulerClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const sample = Math.max(0, Math.round((event.clientX - rect.left) / pxPerSample));
    stopPlayback();
    setPlayheadSample(sample);
  };

  const beginDrag = (event: React.PointerEvent, kind: DragState["kind"], track: AudioTrack, clip: AudioClip) => {
    if (track.locked) return;
    event.stopPropagation();
    (event.target as Element).setPointerCapture(event.pointerId);
    const before = cloneAudioState(kernel.documents.get<AudioDocumentState>(document.id)!.state);
    dragRef.current = { kind, trackId: track.id, clipId: clip.id, startClientX: event.clientX, before, appliedSamples: 0 };
    setSelection(document.id, track.id, [clip.id]);
  };

  const onDragMove = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const deltaPx = event.clientX - drag.startClientX;
    const deltaSamples = Math.round(deltaPx / pxPerSample) - drag.appliedSamples;
    if (deltaSamples === 0) return;
    const applied = drag.kind === "move"
      ? previewMoveClip(document.id, drag.trackId, drag.clipId, deltaSamples)
      : previewTrimClip(document.id, drag.trackId, drag.clipId, drag.kind === "trim-left" ? "left" : "right", deltaSamples);
    drag.appliedSamples += applied;
  };

  const onDragEnd = () => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    if (drag.appliedSamples !== 0) {
      const label = drag.kind === "move" ? "Move Clip (Переместить клип)" : "Trim Clip (Обрезать клип)";
      commitAudioDrag(document.id, label, drag.before);
    }
  };

  const onClipClick = (track: AudioTrack, clip: AudioClip, event: React.MouseEvent) => {
    if (splitMode) {
      const rect = event.currentTarget.getBoundingClientRect();
      const clickedSample = clip.startSample + Math.round((event.clientX - rect.left) / pxPerSample);
      splitClipAt(document.id, track.id, clip.id, clickedSample);
      return;
    }
    setSelection(document.id, track.id, [clip.id]);
  };

  const addWavAsNewClip = async (wav: Uint8Array, name: string, startSample?: number) => {
    const assetId = await kernel.assets.importAsset(wav, { kind: "audio", mime: "audio/wav", name });
    const decoded = decodeWav(wav);
    const at = startSample ?? Math.round(timelineDurationSamples(kernel.documents.get<AudioDocumentState>(document.id)!.state));
    await addClipFromAsset(document.id, assetId, name, decoded.channelData[0]?.length ?? 0, decoded.sampleRate, undefined, at);
  };

  const importFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    for (const file of Array.from(files)) {
      const wav = await decodeAudioFileToWav(file);
      if (wav) await addWavAsNewClip(wav, file.name);
    }
  };

  const toggleRecording = async () => {
    if (recorder) {
      const wav = await recorder.stop();
      setRecorder(null);
      if (wav) await addWavAsNewClip(wav, `Recording (Запись) ${new Date().toLocaleTimeString()}`, playheadSample);
      return;
    }
    try { setRecorder(await startMicrophoneRecording()); }
    catch { /* permission denied or no microphone — nothing to record */ }
  };

  const mixdownAndExport = async () => {
    const current = kernel.documents.get<AudioDocumentState>(document.id)!.state;
    const decoded = new Map<string, DecodedWav>();
    for (const track of current.tracks) for (const clip of track.clips) {
      if (decoded.has(clip.assetId)) continue;
      try { decoded.set(clip.assetId, await decodedAsset(clip.assetId)); } catch { /* skip unreadable asset */ }
    }
    return mixdownAudioDocument(current, (assetId) => decoded.get(assetId));
  };

  const exportMixdown = async () => {
    const { encodeWav } = await import("@vravio/env-audio");
    const mixed = await mixdownAndExport();
    const bytes = encodeWav(mixed, state.sampleRate, 16);
    const blob = new Blob([bytes.buffer as ArrayBuffer], { type: "audio/wav" });
    const name = `${document.name.replace(/\.[^.]+$/, "").trim() || "mixdown"}.wav`;
    await kernel.platform.fs.saveFile({ name, mime: "audio/wav", data: blob });
  };

  const timelineWidthPx = Math.max(400, Math.round((durationSamples / sampleRate) * pixelsPerSecond) + 100);
  const selectedClip = state.selection ? state.tracks.find((track) => track.id === state.selection!.trackId)?.clips.find((clip) => state.selection!.clipIds.includes(clip.id)) : undefined;

  return <div className="audio-workspace">
    <div className="audio-transport">
      <button onClick={togglePlay} title={text(language, "Play/Pause", "Играть/Пауза")}>{isPlaying ? "⏸" : "▶"}</button>
      <button onClick={stopToStart} title={text(language, "Stop", "Стоп")}>⏹</button>
      <span className="audio-time">{formatTime(playheadSample / sampleRate)} / {formatTime(durationSamples / sampleRate)}</span>
      <button className={splitMode ? "active" : ""} onClick={() => setSplitMode((value) => !value)} title={text(language, "Split tool", "Инструмент разреза")}>✂</button>
      <span className="audio-transport-sep" />
      <button onClick={() => setPixelsPerSecond((value) => Math.max(10, value / 1.5))} title={text(language, "Zoom out", "Уменьшить")}>−</button>
      <button onClick={() => setPixelsPerSecond((value) => Math.min(2000, value * 1.5))} title={text(language, "Zoom in", "Увеличить")}>+</button>
      <span className="audio-transport-sep" />
      <button onClick={() => addAudioTrack(document.id)}>{text(language, "+ Track", "+ Дорожка")}</button>
      <button onClick={() => fileInputRef.current?.click()}>{text(language, "Import…", "Импорт…")}</button>
      <input ref={fileInputRef} type="file" accept="audio/*" multiple hidden onChange={(event) => { void importFiles(event.target.files); event.target.value = ""; }} />
      <button className={recorder ? "active" : ""} onClick={() => void toggleRecording()} title={text(language, "Record from microphone", "Запись с микрофона")}>⏺</button>
      <button onClick={() => void exportMixdown()}>{text(language, "Export WAV…", "Экспорт WAV…")}</button>
      {state.selection && <button data-role="trash" onClick={() => deleteSelectedClips(document.id)}>{text(language, "Delete Clip", "Удалить клип")}</button>}
    </div>

    {selectedClip && state.selection && <div className="audio-clip-inspector">
      <label><span>{text(language, "Gain", "Громкость")}</span><input type="range" min={0} max={2} step={0.01} value={selectedClip.gain} onChange={(event) => setClipGain(document.id, state.selection!.trackId, selectedClip.id, event.target.valueAsNumber)} /></label>
      <label><span>{text(language, "Fade In", "Фейд-ин")}</span><input type="number" min={0} step={0.05} value={+(selectedClip.fadeInSamples / sampleRate).toFixed(2)} onChange={(event) => setClipFade(document.id, state.selection!.trackId, selectedClip.id, "in", Math.max(0, event.target.valueAsNumber) * sampleRate)} />s</label>
      <label><span>{text(language, "Fade Out", "Фейд-аут")}</span><input type="number" min={0} step={0.05} value={+(selectedClip.fadeOutSamples / sampleRate).toFixed(2)} onChange={(event) => setClipFade(document.id, state.selection!.trackId, selectedClip.id, "out", Math.max(0, event.target.valueAsNumber) * sampleRate)} />s</label>
    </div>}

    <div className="audio-body">
      <div className="audio-track-headers">
        <div className="audio-ruler-spacer" />
        {state.tracks.map((track) => <div key={track.id} className="audio-track-header" style={{ height: TRACK_HEIGHT }}>
          <input className="audio-track-name" value={track.name} onChange={(event) => void changeAudioDocument(document.id, "Rename Track (Переименовать дорожку)", (draft) => { const found = draft.tracks.find((item) => item.id === track.id); if (!found) return false; found.name = event.target.value; return true; })} />
          <div className="audio-track-controls">
            <button className={track.muted ? "active" : ""} onClick={() => setTrackMuted(document.id, track.id, !track.muted)} title={text(language, "Mute", "Заглушить")}>M</button>
            <button className={track.soloed ? "active" : ""} onClick={() => setTrackSoloed(document.id, track.id, !track.soloed)} title={text(language, "Solo", "Соло")}>S</button>
            <button disabled={state.tracks.length <= 1} onClick={() => removeAudioTrack(document.id, track.id)} title={text(language, "Delete track", "Удалить дорожку")}>×</button>
          </div>
          <label className="audio-track-slider"><span>{text(language, "Vol", "Гр")}</span><input type="range" min={0} max={1.5} step={0.01} value={track.volume} onChange={(event) => setTrackVolume(document.id, track.id, event.target.valueAsNumber)} /></label>
          <label className="audio-track-slider"><span>{text(language, "Pan", "Пан")}</span><input type="range" min={-1} max={1} step={0.01} value={track.pan} onChange={(event) => setTrackPan(document.id, track.id, event.target.valueAsNumber)} /></label>
        </div>)}
      </div>

      <div className="audio-timeline-scroll">
        <div className="audio-ruler" style={{ width: timelineWidthPx }} onClick={onRulerClick}>
          {Array.from({ length: Math.ceil(timelineWidthPx / pixelsPerSecond) + 1 }, (_, second) => <span key={second} className="audio-ruler-tick" style={{ left: second * pixelsPerSecond }}>{formatTime(second)}</span>)}
          <div className="audio-playhead" style={{ left: playheadSample * pxPerSample }} />
        </div>
        <div className="audio-tracks" style={{ width: timelineWidthPx }} onPointerMove={onDragMove} onPointerUp={onDragEnd}>
          <div className="audio-playhead audio-playhead-body" style={{ left: playheadSample * pxPerSample }} />
          {state.tracks.map((track) => <div key={track.id} className="audio-track-lane" style={{ height: TRACK_HEIGHT }} onClick={() => setSelection(document.id, null, [])}>
            {track.clips.map((clip) => {
              const selected = state.selection?.trackId === track.id && state.selection.clipIds.includes(clip.id);
              const left = clip.startSample * pxPerSample, width = Math.max(4, clip.durationSamples * pxPerSample);
              return <div key={clip.id} className={`audio-clip${selected ? " selected" : ""}`} style={{ left, width, height: TRACK_HEIGHT - 6 }}
                onPointerDown={(event) => beginDrag(event, "move", track, clip)}
                onClick={(event) => onClipClick(track, clip, event)}>
                <div className="audio-clip-trim audio-clip-trim-left" style={{ width: TRIM_HANDLE_PX }} onPointerDown={(event) => beginDrag(event, "trim-left", track, clip)} />
                <span className="audio-clip-name">{clip.name}</span>
                <WaveformCanvas assetId={clip.assetId} offsetSamples={clip.offsetSamples} durationSamples={clip.durationSamples} sourceSampleRate={clip.sourceSampleRate} widthPx={width} color={selected ? "#ffffff" : "#0068ff"} />
                <div className="audio-clip-trim audio-clip-trim-right" style={{ width: TRIM_HANDLE_PX }} onPointerDown={(event) => beginDrag(event, "trim-right", track, clip)} />
              </div>;
            })}
          </div>)}
        </div>
      </div>
    </div>
  </div>;
}
