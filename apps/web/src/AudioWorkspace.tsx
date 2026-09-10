import { useCallback, useEffect, useRef, useState } from "react";
import type { VravioDocument } from "@vravio/kernel";
import {
  audioEffectCatalog, audioEffectDefaults, cloneAudioState, computeSpectrogram, decodeWav, formatBarBeat, generateMonoPeaks,
  heatMapColor, isAudioDocumentState, nearestBarSample, nearestBeatSample, readPeak, removeAutomationPoint,
  sampleToBarBeat, samplesPerBar, setAutomationPoint, timelineDurationSamples, volumeAt,
  type AudioClip, type AudioDocumentState, type AudioEffectId, type AudioMarker, type AudioTrack, type DecodedWav,
} from "@vravio/env-audio";
import type { AssetId } from "@vravio/kernel";
import { kernel } from "./kernel";
import { useShellStore } from "./store";
import { text } from "./i18n";
import { AudioPlaybackEngine, renderAudioOffline } from "./audioPlayback";
import { AUTOMATABLE_EFFECT_PARAMS } from "./audioEffects";
import {
  addAudioTrack, addClipFromAsset, addMarker, addTrackEffect, applyEffectToClip, changeAudioDocument, clearEffectParamAutomation,
  clearTrackVolumeAutomation, commitAudioDrag, commitLoopRegion, cycleClipTake, deleteSelectedClips, moveMarker, previewMoveClip,
  previewTrimClip, punchInRecording, removeAudioTrack, removeEffectParamAutomationPoint, removeMarker, removeTrackEffect,
  removeTrackVolumeAutomationPoint, renameMarker, setClipFade, setEffectParamAutomationPoint, setClipGain, setLoopEnabled, setLoopRegion,
  setSelection, setTempo, setTimeSignature, setTrackEffectEnabled, setTrackEffectParam, setTrackMuted, setTrackPan, setTrackSoloed,
  setTrackVolume, setTrackVolumeAutomationPoint, splitClipAt,
} from "./audio-commands";
import { decodeAudioFileToWav, startMicrophoneRecording, type AudioRecorder } from "./audioImport";
import { usePluginRuns } from "./plugins/usePluginRuns";
import type { AudioPluginDoor } from "./environments/audio/plugins/surface";

const TRACK_HEIGHT = 72;
const TRIM_HANDLE_PX = 8;
const DEFAULT_PIXELS_PER_SECOND = 100;
const AUTOMATION_MAX_VOLUME = 1.5;

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

/** The spectrogram alternative to `WaveformCanvas` — same clip-window slicing, but a
 * frequency-over-time heat map (`computeSpectrogram`/`heatMapColor`) instead of an amplitude
 * envelope. Recomputed only when the clip's audible window changes, not on every render. */
function SpectrogramCanvas({ assetId, offsetSamples, durationSamples, sourceSampleRate, widthPx }: {
  assetId: string; offsetSamples: number; durationSamples: number; sourceSampleRate: number; widthPx: number;
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
    const mono = decoded.channelData[0]!.subarray(Math.max(0, sourceOffset), Math.min(decoded.channelData[0]!.length, sourceOffset + sourceDuration));
    if (mono.length < 256) return; // too short for even the smallest useful FFT window

    const fftSize = mono.length < 4096 ? 256 : 1024;
    const { frames } = computeSpectrogram(Float32Array.from(mono), decoded.sampleRate, { fftSize, hopSize: Math.max(1, Math.floor(mono.length / Math.max(1, width))) });
    if (frames.length === 0) return;

    const image = context.createImageData(width, height);
    const binsPerPixelRow = Math.max(1, Math.floor(frames[0]!.length / height));
    for (let x = 0; x < width; x += 1) {
      const frame = frames[Math.min(frames.length - 1, Math.floor((x / width) * frames.length))]!;
      for (let y = 0; y < height; y += 1) {
        // Low frequencies at the bottom, high at the top — the same orientation every
        // spectrogram viewer (Audacity included) uses.
        const bin = Math.min(frame.length - 1, Math.floor(((height - 1 - y) / height) * frame.length));
        let db = -100;
        for (let b = bin; b < Math.min(frame.length, bin + binsPerPixelRow); b += 1) db = Math.max(db, frame[b]!);
        const normalized = (db + 100) / 100;
        const [r, g, b] = heatMapColor(normalized);
        const pixelIndex = (y * width + x) * 4;
        image.data[pixelIndex] = r; image.data[pixelIndex + 1] = g; image.data[pixelIndex + 2] = b; image.data[pixelIndex + 3] = 255;
      }
    }
    context.putImageData(image, 0, 0);
  }, [decoded, offsetSamples, durationSamples, sourceSampleRate, widthPx]);

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

interface AutomationDragState {
  readonly trackId: string;
  readonly pointId: string;
  readonly before: AudioDocumentState;
  readonly laneLeft: number;
  readonly laneTop: number;
}

export function AudioWorkspace({ document }: { document: VravioDocument }) {
  const language = useShellStore((shell) => shell.language);
  const [workspaceMode, setWorkspaceMode] = useState<"edit" | "record" | "mix" | "master">("edit");
  const [pixelsPerSecond, setPixelsPerSecond] = useState(DEFAULT_PIXELS_PER_SECOND);
  const [playheadSample, setPlayheadSample] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [splitMode, setSplitMode] = useState(false);
  const [recorder, setRecorder] = useState<AudioRecorder | null>(null);
  const [punchMode, setPunchMode] = useState(false);
  const recordStartSampleRef = useRef(0);
  const [effectId, setEffectId] = useState<AudioEffectId>("normalize");
  const [effectParams, setEffectParams] = useState<Record<string, number>>(() => audioEffectDefaults("normalize"));
  const [applyingEffect, setApplyingEffect] = useState(false);
  const [openFxTrackId, setOpenFxTrackId] = useState<string | null>(null);
  const [automatingParam, setAutomatingParam] = useState<{ effectId: string; paramId: string } | null>(null);
  const [newTrackEffectId, setNewTrackEffectId] = useState<AudioEffectId>("eq");
  const [rippleMode, setRippleMode] = useState(false);
  const [viewMode, setViewMode] = useState<"waveform" | "spectrogram">("waveform");
  const [showBars, setShowBars] = useState(false);
  const [snapToGrid, setSnapToGrid] = useState(false);
  const markerDragRef = useRef<{ markerId: string; before: AudioDocumentState } | null>(null);
  const [automationMode, setAutomationMode] = useState(false);
  const dragPointRef = useRef<AutomationDragState | null>(null);
  const loopDragRef = useRef<{ mode: "create" | "left" | "right"; anchorSample: number; before: AudioDocumentState } | null>(null);
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
  const barSamples = samplesPerBar(state);

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

  const sampleAtClientX = (rect: DOMRect, clientX: number) => Math.max(0, Math.round((clientX - rect.left) / pxPerSample));

  const beginLoopDrag = (event: React.PointerEvent<HTMLDivElement>, mode: "create" | "left" | "right") => {
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const rect = event.currentTarget.closest(".audio-loop-lane")!.getBoundingClientRect();
    const sample = sampleAtClientX(rect, event.clientX);
    loopDragRef.current = { mode, anchorSample: mode === "create" ? sample : mode === "left" ? state.loopEnd : state.loopStart, before: cloneAudioState(state) };
    if (mode === "create") setLoopRegion(document.id, sample, sample);
  };

  const onLoopDragMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = loopDragRef.current;
    if (!drag) return;
    const sample = sampleAtClientX(event.currentTarget.getBoundingClientRect(), event.clientX);
    setLoopRegion(document.id, drag.anchorSample, sample);
  };

  const onLoopDragEnd = () => {
    const drag = loopDragRef.current;
    if (!drag) return;
    loopDragRef.current = null;
    commitLoopRegion(document.id, drag.before);
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
      : previewTrimClip(document.id, drag.trackId, drag.clipId, drag.kind === "trim-left" ? "left" : "right", deltaSamples, rippleMode);
    drag.appliedSamples += applied;
  };

  const onDragEnd = () => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    if (drag.appliedSamples === 0) return;
    if (snapToGrid && drag.kind === "move") {
      const current = kernel.documents.get<AudioDocumentState>(document.id)?.state;
      const clip = current?.tracks.find((item) => item.id === drag.trackId)?.clips.find((item) => item.id === drag.clipId);
      if (clip) previewMoveClip(document.id, drag.trackId, drag.clipId, nearestBeatSample(current!, clip.startSample) - clip.startSample);
    }
    const label = drag.kind === "move" ? "Move Clip (Переместить клип)" : "Trim Clip (Обрезать клип)";
    commitAudioDrag(document.id, label, drag.before);
  };

  const beginAutomationDrag = (event: React.PointerEvent, track: AudioTrack, pointId: string, laneRect: DOMRect) => {
    event.stopPropagation();
    (event.target as Element).setPointerCapture(event.pointerId);
    const before = cloneAudioState(kernel.documents.get<AudioDocumentState>(document.id)!.state);
    dragPointRef.current = { trackId: track.id, pointId, before, laneLeft: laneRect.left, laneTop: laneRect.top };
  };

  const onAutomationDragMove = (event: React.PointerEvent) => {
    const drag = dragPointRef.current;
    if (!drag) return;
    const time = Math.max(0, Math.round((event.clientX - drag.laneLeft) / pxPerSample));
    const value = Math.max(0, Math.min(AUTOMATION_MAX_VOLUME, (1 - (event.clientY - drag.laneTop) / TRACK_HEIGHT) * AUTOMATION_MAX_VOLUME));
    kernel.documents.update<AudioDocumentState>(document.id, (state) => {
      const track = state.tracks.find((item) => item.id === drag.trackId);
      if (!track) return;
      track.volumeAutomation = setAutomationPoint(removeAutomationPoint(track.volumeAutomation, drag.pointId), time, value, drag.pointId);
    });
  };

  const onAutomationDragEnd = () => {
    const drag = dragPointRef.current;
    if (!drag) return;
    dragPointRef.current = null;
    commitAudioDrag(document.id, "Volume Automation (Автоматизация громкости)", drag.before);
  };

  const onLaneClick = (track: AudioTrack, event: React.MouseEvent<HTMLDivElement>) => {
    if (!automationMode) { setSelection(document.id, null, []); return; }
    const rect = event.currentTarget.getBoundingClientRect();
    const time = Math.max(0, Math.round((event.clientX - rect.left) / pxPerSample));
    const value = Math.max(0, Math.min(AUTOMATION_MAX_VOLUME, (1 - (event.clientY - rect.top) / TRACK_HEIGHT) * AUTOMATION_MAX_VOLUME));
    setTrackVolumeAutomationPoint(document.id, track.id, crypto.randomUUID(), time, value);
  };

  const onClipClick = (track: AudioTrack, clip: AudioClip, event: React.MouseEvent) => {
    if (automationMode) {
      // A clip covers nearly the whole lane height, so a click meant for the automation lane
      // underneath it lands on the clip element instead — routed here rather than only ever
      // reachable through the sliver of bare lane a clip doesn't cover.
      const lane = event.currentTarget.closest(".audio-track-lane");
      const rect = (lane ?? event.currentTarget).getBoundingClientRect();
      const time = Math.max(0, Math.round((event.clientX - rect.left) / pxPerSample));
      const value = Math.max(0, Math.min(AUTOMATION_MAX_VOLUME, (1 - (event.clientY - rect.top) / TRACK_HEIGHT) * AUTOMATION_MAX_VOLUME));
      setTrackVolumeAutomationPoint(document.id, track.id, crypto.randomUUID(), time, value);
      return;
    }
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

  /**
   * `punchMode` on: the stopped recording re-records `[recordStartSampleRef, playheadSample)` of
   * whichever clip on the current selection's track fully contains that span —
   * `punchInRecording` (docs/master-plan.md §9.2's "advanced recording") splits/replaces just
   * that range (or, spanning a clip's entire own window, adds it as a new take rather than a
   * fresh clip — see that function's own doc comment). Falls back to a plain new clip if nothing
   * covers the punched range, so a recording is never silently lost because Punch didn't apply.
   */
  const toggleRecording = async () => {
    if (recorder) {
      const wav = await recorder.stop();
      setRecorder(null);
      if (!wav) return;
      const punchTrackId = state.selection?.trackId;
      if (punchMode && punchTrackId) {
        const decoded = decodeWav(wav);
        const assetId = await kernel.assets.importAsset(wav, { kind: "audio", mime: "audio/wav", name: `Take (Дубль) ${new Date().toLocaleTimeString()}` });
        const applied = await punchInRecording(document.id, punchTrackId, recordStartSampleRef.current, playheadSample, assetId, decoded.channelData[0]?.length ?? 0, decoded.sampleRate);
        if (applied) return;
        kernel.documents.addAssetRef(document.id, assetId as AssetId);
        await addClipFromAsset(document.id, assetId, `Take (Дубль) ${new Date().toLocaleTimeString()}`, decoded.channelData[0]?.length ?? 0, decoded.sampleRate, undefined, recordStartSampleRef.current);
        return;
      }
      await addWavAsNewClip(wav, `Recording (Запись) ${new Date().toLocaleTimeString()}`, playheadSample);
      return;
    }
    recordStartSampleRef.current = playheadSample;
    try { setRecorder(await startMicrophoneRecording()); }
    catch { /* permission denied or no microphone — nothing to record */ }
  };

  const exportMixdown = async () => {
    const current = kernel.documents.get<AudioDocumentState>(document.id)!.state;
    // Through the same Web Audio graph playback uses (renderAudioOffline, audioPlayback.ts) —
    // not the pure `mixdownAudioDocument` env-audio also has, which cannot run a track's EQ/
    // compressor/reverb/delay inserts at all (no DOM to reach OfflineAudioContext from). Export
    // sounding different from what the transport just played was exactly that gap.
    const rendered = await renderAudioOffline(current, async (assetId) => {
      try { return await kernel.assets.read(assetId as AssetId); } catch { return null; }
    });
    const { encodeWav } = await import("@vravio/env-audio");
    const channels = Array.from({ length: rendered.numberOfChannels }, (_, index) => rendered.getChannelData(index));
    const bytes = encodeWav(channels, rendered.sampleRate, 16);
    const blob = new Blob([bytes.buffer as ArrayBuffer], { type: "audio/wav" });
    const name = `${document.name.replace(/\.[^.]+$/, "").trim() || "mixdown"}.wav`;
    await kernel.platform.fs.saveFile({ name, mime: "audio/wav", data: blob });
  };

  const timelineWidthPx = Math.max(400, Math.round((durationSamples / sampleRate) * pixelsPerSecond) + 100);
  const selectedClip = state.selection ? state.tracks.find((track) => track.id === state.selection!.trackId)?.clips.find((clip) => state.selection!.clipIds.includes(clip.id)) : undefined;
  const clipCount = state.tracks.reduce((count, track) => count + track.clips.length, 0);

  // Everything audio contributes to running a plugin: which clip it is about.
  // Reading that clip's audible window and writing the result back are
  // `environments/audio/plugins/surface.ts`, through the same `replaceClipAudio`
  // a destructive effect uses — so a plugin is not a second way into a clip.
  usePluginRuns("audio", state, { documentId: document.id, trackId: state.selection?.trackId ?? "", clipId: selectedClip?.id ?? "" } satisfies AudioPluginDoor);

  return <div className="audio-workspace">
    <header className="media-workspace-switcher" aria-label={text(language, "Audio workspaces", "Рабочие среды аудио")}>
      {([
        ["edit", "Edit", "Монтаж"],
        ["record", "Record", "Запись"],
        ["mix", "Mix", "Микс"],
        ["master", "Master", "Мастеринг"],
      ] as const).map(([id, en, ru]) => <button key={id} className={workspaceMode === id ? "active" : ""} onClick={() => setWorkspaceMode(id)}>{text(language, en, ru)}</button>)}
      <span className="media-workspace-meta">{state.sampleRate.toLocaleString()} Hz · {state.tracks.length} {text(language, "tracks", "дорожек")}</span>
    </header>
    <div className="audio-transport">
      <div className="media-control-group" aria-label={text(language, "Transport", "Транспорт")}> 
        <button className="media-icon-button" onClick={togglePlay} title={text(language, "Play/Pause", "Играть/Пауза")} aria-label={text(language, "Play/Pause", "Играть/Пауза")}>{isPlaying ? "Ⅱ" : "▶"}</button>
        <button className="media-icon-button" onClick={stopToStart} title={text(language, "Stop", "Стоп")} aria-label={text(language, "Stop", "Стоп")}>■</button>
        <button className={recorder ? "media-icon-button active" : "media-icon-button"} onClick={() => void toggleRecording()} title={text(language, "Record from microphone", "Запись с микрофона")} aria-label={text(language, "Record from microphone", "Запись с микрофона")}>●</button>
        <button className={state.loopEnabled ? "media-icon-button active" : "media-icon-button"} onClick={() => setLoopEnabled(document.id, !state.loopEnabled)} title={text(language, "Loop: drag the lane under the ruler to set the range", "Цикл: перетащите дорожку под линейкой, чтобы задать границы")} aria-label={text(language, "Loop", "Цикл")}>⟲</button>
      </div>
      <span className="audio-time">{showBars ? formatBarBeat(sampleToBarBeat(state, playheadSample)) : formatTime(playheadSample / sampleRate)} / {formatTime(durationSamples / sampleRate)}</span>
      <div className="media-control-group audio-tempo-group" aria-label={text(language, "Tempo and time signature", "Темп и размер такта")}>
        <label className="audio-tempo-field" title={text(language, "Tempo (BPM)", "Темп (уд/мин)")}>
          <input type="number" min={1} max={999} value={state.bpm} onChange={(event) => setTempo(document.id, event.target.valueAsNumber)} />
          <span>{text(language, "BPM", "уд/мин")}</span>
        </label>
        <label className="audio-tempo-field" title={text(language, "Time signature", "Размер такта")}>
          <input type="number" min={1} max={32} value={state.timeSigNumerator} onChange={(event) => setTimeSignature(document.id, event.target.valueAsNumber, state.timeSigDenominator)} />
          <span>/</span>
          <input type="number" min={1} max={32} value={state.timeSigDenominator} onChange={(event) => setTimeSignature(document.id, state.timeSigNumerator, event.target.valueAsNumber)} />
        </label>
        <button className={showBars ? "active" : ""} onClick={() => setShowBars((value) => !value)} title={text(language, "Show ruler in bars and beats", "Показать линейку в тактах")}>{text(language, "Bars", "Такты")}</button>
        <button className={snapToGrid ? "active" : ""} onClick={() => setSnapToGrid((value) => !value)} title={text(language, "Snap clip edits to the beat grid", "Привязывать перемещение клипов к сетке долей")}>{text(language, "Snap", "Привязка")}</button>
      </div>
      {state.selection && <button data-role="trash" onClick={() => deleteSelectedClips(document.id, rippleMode)}>{text(language, "Delete Clip", "Удалить клип")}</button>}
    </div>
    <div className="media-edit-toolbar" aria-label={text(language, "Timeline tools", "Инструменты таймлайна")}>
      <div className="media-control-group">
        <button className={splitMode ? "active" : ""} onClick={() => setSplitMode((value) => !value)} title={text(language, "Split tool", "Инструмент разреза")}>{text(language, "Split", "Разрез")}</button>
        <button className={rippleMode ? "active" : ""} onClick={() => setRippleMode((value) => !value)} title={text(language, "Ripple: deleting or right-edge-trimming a clip shifts later clips to close/open the gap", "Сдвиг: удаление или обрезка правого края клипа сдвигает следующие клипы, закрывая или открывая пробел")}>{text(language, "Ripple", "Сдвиг")}</button>
        <button className={viewMode === "spectrogram" ? "active" : ""} onClick={() => setViewMode((mode) => mode === "waveform" ? "spectrogram" : "waveform")} title={text(language, "Toggle spectrogram view", "Переключить вид спектрограммы")}>{text(language, "Spectrum", "Спектр")}</button>
        <button className={automationMode ? "active" : ""} onClick={() => setAutomationMode((value) => !value)} title={text(language, "Volume automation: click a track lane to place a point, drag to move one", "Автоматизация громкости: клик по дорожке — новая точка, перетаскивание — сдвиг")}>{text(language, "Automation", "Автоматизация")}</button>
      </div>
      <div className="media-control-group media-zoom-group">
        <button className="media-icon-button" onClick={() => setPixelsPerSecond((value) => Math.max(10, value / 1.5))} title={text(language, "Zoom out", "Уменьшить")} aria-label={text(language, "Zoom out", "Уменьшить")}>−</button>
        <button className="media-icon-button" onClick={() => setPixelsPerSecond((value) => Math.min(2000, value * 1.5))} title={text(language, "Zoom in", "Увеличить")} aria-label={text(language, "Zoom in", "Увеличить")}>+</button>
      </div>
      <div className="media-project-actions">
        <button onClick={() => addAudioTrack(document.id)}>{text(language, "+ Track", "+ Дорожка")}</button>
        <button onClick={() => fileInputRef.current?.click()}>{text(language, "Import…", "Импорт…")}</button>
        <input ref={fileInputRef} type="file" accept="audio/*" multiple hidden onChange={(event) => { void importFiles(event.target.files); event.target.value = ""; }} />
        <button className={punchMode ? "active" : ""} onClick={() => setPunchMode((value) => !value)} title={text(language, "Punch in: recording replaces only the selected clip's span between where recording started and the playhead, as a new take", "Punch-in: запись заменяет только участок выбранного клипа между началом записи и плейхедом, как новый дубль")}>{text(language, "Punch", "Punch")}</button>
        <button onClick={() => void exportMixdown()}>{text(language, "Export WAV…", "Экспорт WAV…")}</button>
      </div>
    </div>

    {workspaceMode === "record" && <section className="audio-workspace-strip" aria-label={text(language, "Recording", "Запись")}>
      <strong>{text(language, "Recording", "Запись")}</strong>
      <span>{recorder ? text(language, "Recording from the system microphone", "Идёт запись с системного микрофона") : text(language, "Choose a track, then use the record button in the transport", "Выберите дорожку и нажмите кнопку записи в транспорте")}</span>
      <span>{punchMode ? text(language, "Punch-in is enabled", "Punch-in включён") : text(language, "Punch-in is off", "Punch-in выключен")}</span>
    </section>}

    {selectedClip && state.selection && <div className="audio-clip-inspector">
      {selectedClip.takes.length > 1 && <label><span>{text(language, "Take", "Дубль")}</span>
        <button onClick={() => cycleClipTake(document.id, state.selection!.trackId, selectedClip.id, -1)}>◀</button>
        <span>{selectedClip.activeTakeIndex + 1}/{selectedClip.takes.length}</span>
        <button onClick={() => cycleClipTake(document.id, state.selection!.trackId, selectedClip.id, 1)}>▶</button>
      </label>}
      <label><span>{text(language, "Gain", "Громкость")}</span><input type="range" min={0} max={2} step={0.01} value={selectedClip.gain} onChange={(event) => setClipGain(document.id, state.selection!.trackId, selectedClip.id, event.target.valueAsNumber)} /></label>
      <label><span>{text(language, "Fade In", "Фейд-ин")}</span><input type="number" min={0} step={0.05} value={+(selectedClip.fadeInSamples / sampleRate).toFixed(2)} onChange={(event) => setClipFade(document.id, state.selection!.trackId, selectedClip.id, "in", Math.max(0, event.target.valueAsNumber) * sampleRate)} />s</label>
      <label><span>{text(language, "Fade Out", "Фейд-аут")}</span><input type="number" min={0} step={0.05} value={+(selectedClip.fadeOutSamples / sampleRate).toFixed(2)} onChange={(event) => setClipFade(document.id, state.selection!.trackId, selectedClip.id, "out", Math.max(0, event.target.valueAsNumber) * sampleRate)} />s</label>
      <span className="audio-transport-sep" />
      <label><span>{text(language, "Effect", "Эффект")}</span>
        <select value={effectId} onChange={(event) => { const id = event.target.value as AudioEffectId; setEffectId(id); setEffectParams(audioEffectDefaults(id)); }}>
          {audioEffectCatalog.map((definition) => <option key={definition.id} value={definition.id}>{definition.name}</option>)}
        </select>
      </label>
      {audioEffectCatalog.find((definition) => definition.id === effectId)?.parameters
        .filter((parameter) => parameter.id !== "startSample" && parameter.id !== "endSample")
        .map((parameter) => <label key={parameter.id}><span>{parameter.name}</span>
          <input type="range" min={parameter.min} max={parameter.max} step={parameter.step} value={effectParams[parameter.id] ?? parameter.value}
            onChange={(event) => setEffectParams((current) => ({ ...current, [parameter.id]: event.target.valueAsNumber }))} />
        </label>)}
      <button disabled={applyingEffect} onClick={() => {
        setApplyingEffect(true);
        void applyEffectToClip(document.id, state.selection!.trackId, selectedClip.id, effectId, effectParams).finally(() => setApplyingEffect(false));
      }}>{applyingEffect ? text(language, "Applying…", "Применяется…") : text(language, "Apply", "Применить")}</button>
    </div>}

    {openFxTrackId && (() => {
      const track = state.tracks.find((item) => item.id === openFxTrackId);
      if (!track) return null;
      const realtimeEffects = audioEffectCatalog.filter((definition) => !definition.portable);
      return <div className="audio-clip-inspector audio-track-fx-panel">
        {track.effects.length === 0 && <span>{text(language, "No effects on this track yet", "На этой дорожке пока нет эффектов")}</span>}
        {track.effects.map((effect) => {
          const definition = audioEffectCatalog.find((item) => item.id === effect.effectId)!;
          return <div key={effect.id} className="audio-track-fx-insert">
            <label className="audio-fx-toggle"><input type="checkbox" checked={effect.enabled} onChange={(event) => setTrackEffectEnabled(document.id, track.id, effect.id, event.target.checked)} /><b>{definition.name}</b></label>
            {definition.parameters.map((parameter) => {
              const automatable = AUTOMATABLE_EFFECT_PARAMS[effect.effectId]?.includes(parameter.id) ?? false;
              const automationKey = `${effect.id}:${parameter.id}`;
              const points = track.effectAutomation[automationKey] ?? [];
              const isAutomating = automatingParam?.effectId === effect.id && automatingParam?.paramId === parameter.id;
              const currentValue = effect.params[parameter.id] ?? parameter.value;
              return <div key={parameter.id} className="audio-fx-param">
                <label><span>{parameter.name}</span>
                  <input type="range" min={parameter.min} max={parameter.max} step={parameter.step} value={currentValue}
                    onChange={(event) => setTrackEffectParam(document.id, track.id, effect.id, parameter.id, event.target.valueAsNumber)} />
                  {automatable && <button className={isAutomating ? "active" : ""} onClick={() => setAutomatingParam(isAutomating ? null : { effectId: effect.id, paramId: parameter.id })} title={text(language, "Automate this parameter", "Автоматизировать параметр")}>~{points.length > 0 ? ` ${points.length}` : ""}</button>}
                </label>
                {isAutomating && <div className="audio-fx-automation-lane"
                  onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    const time = Math.max(0, Math.round(((event.clientX - rect.left) / rect.width) * durationSamples));
                    setEffectParamAutomationPoint(document.id, track.id, effect.id, parameter.id, crypto.randomUUID(), time, currentValue);
                  }}>
                  {points.map((point) => <span key={point.id} className="audio-fx-automation-point" style={{ left: `${(point.time / durationSamples) * 100}%` }}
                    onClick={(event) => event.stopPropagation()}
                    onDoubleClick={(event) => { event.stopPropagation(); removeEffectParamAutomationPoint(document.id, track.id, effect.id, parameter.id, point.id); }}
                    title={`${text(language, "t", "t")}=${formatTime(point.time / sampleRate)} ${text(language, "value", "значение")}=${point.value.toFixed(2)}`} />)}
                  {points.length > 0 && <button className="audio-fx-automation-clear" onClick={(event) => { event.stopPropagation(); clearEffectParamAutomation(document.id, track.id, effect.id, parameter.id); }}>{text(language, "Clear", "Очистить")}</button>}
                </div>}
              </div>;
            })}
            <button data-role="trash" onClick={() => removeTrackEffect(document.id, track.id, effect.id)}>{text(language, "Remove", "Удалить")}</button>
          </div>;
        })}
        <span className="audio-transport-sep" />
        <label><span>{text(language, "Add effect", "Добавить эффект")}</span>
          <select value={newTrackEffectId} onChange={(event) => setNewTrackEffectId(event.target.value as AudioEffectId)}>
            {realtimeEffects.map((definition) => <option key={definition.id} value={definition.id}>{definition.name}</option>)}
          </select>
        </label>
        <button onClick={() => addTrackEffect(document.id, track.id, newTrackEffectId)}>{text(language, "Add", "Добавить")}</button>
      </div>;
    })()}

    <div className="audio-body">
      <div className="audio-track-headers">
        <div className="audio-ruler-spacer" />
        {state.tracks.map((track) => <div key={track.id} className="audio-track-header" style={{ height: TRACK_HEIGHT }}>
          <input className="audio-track-name" value={track.name} onChange={(event) => void changeAudioDocument(document.id, "Rename Track (Переименовать дорожку)", (draft) => { const found = draft.tracks.find((item) => item.id === track.id); if (!found) return false; found.name = event.target.value; return true; })} />
          <div className="audio-track-controls">
            <button className={track.muted ? "active" : ""} onClick={() => setTrackMuted(document.id, track.id, !track.muted)} title={text(language, "Mute", "Заглушить")}>M</button>
            <button className={track.soloed ? "active" : ""} onClick={() => setTrackSoloed(document.id, track.id, !track.soloed)} title={text(language, "Solo", "Соло")}>S</button>
            <button className={openFxTrackId === track.id ? "active" : ""} onClick={() => setOpenFxTrackId((current) => current === track.id ? null : track.id)} title={text(language, "Effects", "Эффекты")}>FX{track.effects.length > 0 ? ` ${track.effects.length}` : ""}</button>
            <button disabled={state.tracks.length <= 1} onClick={() => removeAudioTrack(document.id, track.id)} title={text(language, "Delete track", "Удалить дорожку")}>×</button>
          </div>
          <label className="audio-track-slider"><span>{text(language, "Vol", "Гр")}</span><input type="range" min={0} max={1.5} step={0.01} value={track.volume} onChange={(event) => setTrackVolume(document.id, track.id, event.target.valueAsNumber)} /></label>
          <label className="audio-track-slider"><span>{text(language, "Pan", "Пан")}</span><input type="range" min={-1} max={1} step={0.01} value={track.pan} onChange={(event) => setTrackPan(document.id, track.id, event.target.valueAsNumber)} /></label>
          {automationMode && track.volumeAutomation.length > 0 && <button onClick={() => clearTrackVolumeAutomation(document.id, track.id)}>{text(language, "Clear automation", "Очистить автоматизацию")}</button>}
        </div>)}
      </div>

      <div className="audio-timeline-scroll">
        <div className="audio-ruler" style={{ width: timelineWidthPx }} onClick={onRulerClick}>
          {showBars
            ? Array.from({ length: Math.ceil(durationSamples / barSamples) + 1 }, (_, bar) => <span key={bar} className="audio-ruler-tick" style={{ left: bar * barSamples * pxPerSample }}>{bar + 1}</span>)
            : Array.from({ length: Math.ceil(timelineWidthPx / pixelsPerSecond) + 1 }, (_, second) => <span key={second} className="audio-ruler-tick" style={{ left: second * pixelsPerSecond }}>{formatTime(second)}</span>)}
          <div className="audio-playhead" style={{ left: playheadSample * pxPerSample }} />
        </div>
        <div className="audio-marker-lane" style={{ width: timelineWidthPx }} onDoubleClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); addMarker(document.id, Math.max(0, Math.round((event.clientX - rect.left) / pxPerSample))); }} title={text(language, "Double-click to add a marker", "Двойной клик — добавить маркер")}>
          {state.markers.map((marker) => <div key={marker.id} className="audio-marker-flag" style={{ left: marker.sampleTime * pxPerSample }}
            onPointerDown={(event) => { event.stopPropagation(); markerDragRef.current = { markerId: marker.id, before: cloneAudioState(state) }; event.currentTarget.setPointerCapture(event.pointerId); }}
            onPointerMove={(event) => { const drag = markerDragRef.current; if (!drag || drag.markerId !== marker.id) return; const rect = event.currentTarget.parentElement!.getBoundingClientRect(); moveMarker(document.id, marker.id, (event.clientX - rect.left) / pxPerSample); }}
            onPointerUp={() => { const drag = markerDragRef.current; if (!drag) return; markerDragRef.current = null; commitAudioDrag(document.id, "Move Marker (Переместить маркер)", drag.before); }}
            onDoubleClick={(event) => { event.stopPropagation(); const next = window.prompt(text(language, "Marker name", "Имя маркера"), marker.name); if (next !== null && next.trim()) renameMarker(document.id, marker.id, next.trim()); }}
            title={`${marker.name} — ${formatTime(marker.sampleTime / sampleRate)}`}>
            <span>{marker.name}</span>
            <button className="audio-marker-delete" onClick={(event) => { event.stopPropagation(); removeMarker(document.id, marker.id); }} title={text(language, "Delete marker", "Удалить маркер")}>×</button>
          </div>)}
        </div>
        <div className={`audio-loop-lane${state.loopEnabled ? " active" : ""}`} style={{ width: timelineWidthPx }}
          onPointerDown={(event) => beginLoopDrag(event, "create")} onPointerMove={onLoopDragMove} onPointerUp={onLoopDragEnd}
          title={text(language, "Drag to set the loop range", "Перетащите, чтобы задать границы цикла")}>
          {state.loopEnd > state.loopStart && <div className="audio-loop-region" style={{ left: state.loopStart * pxPerSample, width: (state.loopEnd - state.loopStart) * pxPerSample }}>
            <div className="audio-loop-handle audio-loop-handle-left" onPointerDown={(event) => beginLoopDrag(event, "left")} />
            <div className="audio-loop-handle audio-loop-handle-right" onPointerDown={(event) => beginLoopDrag(event, "right")} />
          </div>}
        </div>
        <div className="audio-tracks" style={{ width: timelineWidthPx }}
          onPointerMove={(event) => { onDragMove(event); onAutomationDragMove(event); }}
          onPointerUp={() => { onDragEnd(); onAutomationDragEnd(); }}>
          <div className="audio-playhead audio-playhead-body" style={{ left: playheadSample * pxPerSample }} />
          {state.tracks.map((track) => <div key={track.id} className={`audio-track-lane${automationMode ? " automation-mode" : ""}`} style={{ height: TRACK_HEIGHT }} onClick={(event) => onLaneClick(track, event)}>
            {track.clips.map((clip) => {
              const selected = state.selection?.trackId === track.id && state.selection.clipIds.includes(clip.id);
              const left = clip.startSample * pxPerSample, width = Math.max(4, clip.durationSamples * pxPerSample);
              return <div key={clip.id} className={`audio-clip${selected ? " selected" : ""}`} style={{ left, width, height: TRACK_HEIGHT - 6 }}
                onPointerDown={(event) => beginDrag(event, "move", track, clip)}
                onClick={(event) => onClipClick(track, clip, event)}>
                <div className="audio-clip-trim audio-clip-trim-left" style={{ width: TRIM_HANDLE_PX }} onPointerDown={(event) => beginDrag(event, "trim-left", track, clip)} />
                <span className="audio-clip-name">{clip.name}</span>
                {viewMode === "spectrogram"
                  ? <SpectrogramCanvas assetId={clip.assetId} offsetSamples={clip.offsetSamples} durationSamples={clip.durationSamples} sourceSampleRate={clip.sourceSampleRate} widthPx={width} />
                  : <WaveformCanvas assetId={clip.assetId} offsetSamples={clip.offsetSamples} durationSamples={clip.durationSamples} sourceSampleRate={clip.sourceSampleRate} widthPx={width} color={selected ? "#ffffff" : "#0068ff"} />}
                <div className="audio-clip-trim audio-clip-trim-right" style={{ width: TRIM_HANDLE_PX }} onPointerDown={(event) => beginDrag(event, "trim-right", track, clip)} />
              </div>;
            })}
            {track.volumeAutomation.length > 0 && <svg className="audio-automation-overlay" width={timelineWidthPx} height={TRACK_HEIGHT}>
              <polyline
                points={track.volumeAutomation.map((point) => `${point.time * pxPerSample},${TRACK_HEIGHT * (1 - point.value / AUTOMATION_MAX_VOLUME)}`).join(" ")}
                fill="none" stroke="#ffe066" strokeWidth={1.5} />
              {track.volumeAutomation.map((point) => <circle key={point.id} className="audio-automation-point"
                cx={point.time * pxPerSample} cy={TRACK_HEIGHT * (1 - point.value / AUTOMATION_MAX_VOLUME)} r={4}
                onPointerDown={(event) => beginAutomationDrag(event, track, point.id, (event.currentTarget.closest(".audio-track-lane") as HTMLElement).getBoundingClientRect())}
                onDoubleClick={(event) => { event.stopPropagation(); removeTrackVolumeAutomationPoint(document.id, track.id, point.id); }} />)}
            </svg>}
          </div>)}
        </div>
      </div>
    </div>

    {workspaceMode === "mix" && <section className="audio-bottom-panel audio-mixer" aria-label={text(language, "Mixer", "Микшер")}>
      <header><strong>{text(language, "Mixer", "Микшер")}</strong><span>{text(language, "Track controls are live", "Регуляторы дорожек работают в реальном времени")}</span></header>
      <div className="audio-mixer-strips">
        {state.tracks.map((track) => <section className="audio-mixer-strip" key={track.id}>
          <strong title={track.name}>{track.name}</strong>
          <div className="audio-mixer-buttons">
            <button className={track.muted ? "active" : ""} onClick={() => setTrackMuted(document.id, track.id, !track.muted)} title={text(language, "Mute", "Заглушить")}>M</button>
            <button className={track.soloed ? "active" : ""} onClick={() => setTrackSoloed(document.id, track.id, !track.soloed)} title={text(language, "Solo", "Соло")}>S</button>
          </div>
          <label><span>{text(language, "Gain", "Громкость")}</span><input aria-label={`${track.name}: ${text(language, "gain", "громкость")}`} type="range" min={0} max={1.5} step={0.01} value={track.volume} onChange={(event) => setTrackVolume(document.id, track.id, event.target.valueAsNumber)} /></label>
          <label><span>{text(language, "Pan", "Панорама")}</span><input aria-label={`${track.name}: ${text(language, "pan", "панорама")}`} type="range" min={-1} max={1} step={0.01} value={track.pan} onChange={(event) => setTrackPan(document.id, track.id, event.target.valueAsNumber)} /></label>
        </section>)}
      </div>
    </section>}

    {workspaceMode === "master" && <section className="audio-bottom-panel audio-analysis" aria-label={text(language, "Project summary", "Сводка проекта")}>
      <header><strong>{text(language, "Project summary", "Сводка проекта")}</strong><span>{text(language, "Analysis meters require the next audio-engine stage", "Полные измерители появятся вместе со следующим этапом аудиодвижка")}</span></header>
      <dl>
        <div><dt>{text(language, "Format", "Формат")}</dt><dd>{state.sampleRate.toLocaleString()} Hz · WAV</dd></div>
        <div><dt>{text(language, "Duration", "Длительность")}</dt><dd>{formatTime(durationSamples / sampleRate)}</dd></div>
        <div><dt>{text(language, "Tracks", "Дорожки")}</dt><dd>{state.tracks.length}</dd></div>
        <div><dt>{text(language, "Clips", "Клипы")}</dt><dd>{clipCount}</dd></div>
      </dl>
    </section>}
  </div>;
}
