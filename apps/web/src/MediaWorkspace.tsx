import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin from "wavesurfer.js/dist/plugins/regions.esm.js";
import TimelinePlugin from "wavesurfer.js/dist/plugins/timeline.esm.js";
import coreURL from "@ffmpeg/core?url";
import wasmURL from "@ffmpeg/core/wasm?url";
import type { Language } from "./store";
import { text } from "./i18n";

interface MediaAsset { id: string; file: File; url: string; duration: number }
interface MediaClip { id: string; assetId: string; trimStart: number; trimEnd: number }

const uid = () => crypto.randomUUID();
const formatTime = (seconds: number): string => { const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0, minutes = Math.floor(safe / 60), rest = Math.floor(safe % 60); return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`; };
const clipDuration = (clip: MediaClip) => Math.max(0, clip.trimEnd - clip.trimStart);

async function readDuration(file: File, kind: "audio" | "video"): Promise<{ url: string; duration: number }> {
  const url = URL.createObjectURL(file), media = document.createElement(kind);
  media.preload = "metadata"; media.src = url;
  return await new Promise((resolve, reject) => { media.onloadedmetadata = () => resolve({ url, duration: Number.isFinite(media.duration) ? media.duration : 0 }); media.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`Cannot decode ${file.name}`)); }; });
}

export function MediaWorkspace({ kind, language }: { kind: "audio" | "video"; language: Language }) {
  const [assets, setAssets] = useState<MediaAsset[]>([]), [tracks, setTracks] = useState<MediaClip[][]>([[]]), [activeTrack, setActiveTrack] = useState(0), [selectedId, setSelectedId] = useState<string | null>(null), [currentTime, setCurrentTime] = useState(0), [playing, setPlaying] = useState(false), [exporting, setExporting] = useState(false), [message, setMessage] = useState("");
  const videoRef = useRef<HTMLVideoElement>(null), waveformHostRef = useRef<HTMLDivElement>(null), waveRef = useRef<WaveSurfer | null>(null), draggedClipRef = useRef<string | null>(null), assetUrlsRef = useRef<string[]>([]);
  const selected = useMemo(() => tracks.flat().find((clip) => clip.id === selectedId) ?? null, [tracks, selectedId]);
  const selectedAsset = selected ? assets.find((asset) => asset.id === selected.assetId) ?? null : null, selectedDuration = selected ? clipDuration(selected) : 0;
  const projectDuration = Math.max(.01, ...tracks.map((track) => track.reduce((sum, clip) => sum + clipDuration(clip), 0)));

  useEffect(() => () => { for (const url of assetUrlsRef.current) URL.revokeObjectURL(url); waveRef.current?.destroy(); }, []);
  useEffect(() => {
    waveRef.current?.destroy(); waveRef.current = null;
    if (kind !== "audio" || !selected || !selectedAsset || !waveformHostRef.current) return;
    const regions = RegionsPlugin.create(), wave = WaveSurfer.create({ container: waveformHostRef.current, url: selectedAsset.url, height: 170, waveColor: "#d28a00", progressColor: "#ffb600", cursorColor: "#ffffff", normalize: true, plugins: [TimelinePlugin.create(), regions] });
    waveRef.current = wave; wave.on("ready", () => { wave.setTime(selected.trimStart); regions.clearRegions(); regions.addRegion({ start: selected.trimStart, end: selected.trimEnd, color: "rgba(255,182,0,.12)", drag: false, resize: false }); });
    wave.on("timeupdate", (time) => { const local = Math.max(0, time - selected.trimStart); setCurrentTime(local); if (time >= selected.trimEnd) { wave.pause(); wave.setTime(selected.trimStart); setPlaying(false); } });
    wave.on("play", () => setPlaying(true)); wave.on("pause", () => setPlaying(false));
    return () => { wave.destroy(); if (waveRef.current === wave) waveRef.current = null; };
  }, [kind, selected?.id, selected?.trimStart, selected?.trimEnd, selectedAsset?.url]);

  const importFiles = async (files: FileList | File[]) => {
    const accepted = [...files].filter((file) => file.type.startsWith(`${kind}/`)); if (!accepted.length) return;
    try {
      const loaded = await Promise.all(accepted.map(async (file) => { const metadata = await readDuration(file, kind), asset = { id: uid(), file, ...metadata }; assetUrlsRef.current.push(asset.url); return asset; }));
      setAssets((current) => [...current, ...loaded]);
      const clips = loaded.map((asset) => ({ id: uid(), assetId: asset.id, trimStart: 0, trimEnd: asset.duration }));
      setTracks((current) => current.map((track, index) => index === activeTrack ? [...track, ...clips] : track)); setSelectedId(clips[0]?.id ?? null); setMessage("");
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };
  const updateSelected = (patch: Partial<MediaClip>) => setTracks((current) => current.map((track) => track.map((clip) => clip.id === selectedId ? { ...clip, ...patch } : clip)));
  const removeSelected = () => { setTracks((current) => current.map((track) => track.filter((clip) => clip.id !== selectedId))); setSelectedId(null); setCurrentTime(0); };
  const splitSelected = () => { if (!selected || currentTime <= .01 || currentTime >= selectedDuration - .01) return; const splitAt = selected.trimStart + currentTime; setTracks((current) => current.map((track) => track.flatMap((clip) => clip.id === selected.id ? [{ ...clip, id: uid(), trimEnd: splitAt }, { ...clip, id: uid(), trimStart: splitAt }] : [clip]))); setSelectedId(null); setCurrentTime(0); };
  const seek = (value: number) => { setCurrentTime(value); if (selected) { waveRef.current?.setTime(selected.trimStart + value); if (videoRef.current) videoRef.current.currentTime = selected.trimStart + value; } };
  const togglePlay = async () => { if (!selected) return; if (kind === "audio") await waveRef.current?.playPause(); else if (videoRef.current) { if (videoRef.current.paused) { if (videoRef.current.currentTime < selected.trimStart || videoRef.current.currentTime >= selected.trimEnd) videoRef.current.currentTime = selected.trimStart; await videoRef.current.play(); } else videoRef.current.pause(); } };
  const reorder = (targetId: string, trackIndex: number) => { const sourceId = draggedClipRef.current; if (!sourceId || sourceId === targetId) return; setTracks((current) => { const source = current.flat().find((clip) => clip.id === sourceId); if (!source) return current; const next = current.map((track) => track.filter((clip) => clip.id !== sourceId)); const target = next[trackIndex]!, index = Math.max(0, target.findIndex((clip) => clip.id === targetId)); target.splice(index, 0, source); return next; }); };
  const exportSelected = async () => {
    if (!selected || !selectedAsset || exporting) return; setExporting(true); setMessage(text(language, "Loading FFmpeg engine…", "Загрузка движка FFmpeg…"));
    try { const [{ FFmpeg }, { fetchFile }] = await Promise.all([import("@ffmpeg/ffmpeg"), import("@ffmpeg/util")]), ffmpeg = new FFmpeg(); await ffmpeg.load({ coreURL, wasmURL }); const extension = selectedAsset.file.name.split(".").pop() || (kind === "video" ? "mp4" : "wav"), input = `input.${extension}`, output = `vravio-cut.${extension}`; await ffmpeg.writeFile(input, await fetchFile(selectedAsset.file)); await ffmpeg.exec(["-ss", String(selected.trimStart), "-to", String(selected.trimEnd), "-i", input, "-c", "copy", output]); const data = await ffmpeg.readFile(output); const blob = new Blob([data instanceof Uint8Array ? data.slice().buffer : new TextEncoder().encode(data).buffer], { type: selectedAsset.file.type || "application/octet-stream" }), url = URL.createObjectURL(blob), anchor = document.createElement("a"); anchor.href = url; anchor.download = output; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 0); ffmpeg.terminate(); setMessage(text(language, "Export complete", "Экспорт завершён")); } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); } finally { setExporting(false); }
  };

  return <div className="media-editor" data-kind={kind} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { if (event.dataTransfer.files.length) void importFiles(event.dataTransfer.files); }}>
    <header className="media-editor-toolbar">
      <strong>{kind === "video" ? text(language, "Video Editor", "Видеоредактор") : text(language, "Audio Editor", "Аудиоредактор")}</strong>
      <label className="media-import">＋ {text(language, "Import", "Импорт")}<input hidden multiple type="file" accept={`${kind}/*`} onChange={(event) => { if (event.target.files) void importFiles(event.target.files); event.currentTarget.value = ""; }}/></label>
      <button onClick={() => setTracks((current) => [...current, []])}>＋ {text(language, "Track", "Дорожка")}</button>
      <button disabled={!selected} onClick={splitSelected}>✂ {text(language, "Split", "Разрезать")}</button>
      <button disabled={!selected} onClick={removeSelected}>⌫</button>
      <button disabled={!selected || exporting} onClick={() => void exportSelected()}>{exporting ? "…" : "⇩"} {text(language, "Export clip", "Экспорт клипа")}</button>
      <span>{message}</span>
    </header>
    <div className="media-editor-main">
      <aside className="media-bin"><strong>Media (Медиа)</strong>{assets.map((asset) => <button key={asset.id} onDoubleClick={() => { const clip = { id: uid(), assetId: asset.id, trimStart: 0, trimEnd: asset.duration }; setTracks((current) => current.map((track, index) => index === activeTrack ? [...track, clip] : track)); setSelectedId(clip.id); }}>{asset.file.name}<small>{formatTime(asset.duration)}</small></button>)}</aside>
      <main>{selectedAsset ? kind === "video" ? <video ref={videoRef} src={selectedAsset.url} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onLoadedMetadata={(event) => { if (selected) event.currentTarget.currentTime = selected.trimStart; }} onTimeUpdate={(event) => { if (!selected) return; if (event.currentTarget.currentTime >= selected.trimEnd) { event.currentTarget.pause(); event.currentTarget.currentTime = selected.trimStart; } setCurrentTime(Math.max(0, event.currentTarget.currentTime - selected.trimStart)); }}/> : <div ref={waveformHostRef} className="waveform-host"/> : <div className="media-empty">{text(language, "Drop media here or use Import", "Перетащите медиа сюда или нажмите «Импорт»")}</div>}<div className="transport"><button disabled={!selected} onClick={() => seek(0)}>■</button><button disabled={!selected} onClick={() => void togglePlay()}>{playing ? "Ⅱ" : "▶"}</button><span>{formatTime(currentTime)} / {formatTime(selectedDuration)}</span></div></main>
      <aside className="clip-inspector"><strong>Clip (Клип)</strong>{selected && <><label>In (Начало)<input type="number" min="0" max={selected.trimEnd} step=".01" value={selected.trimStart} onChange={(event) => updateSelected({ trimStart: Math.min(selected.trimEnd - .01, event.target.valueAsNumber) })}/></label><label>Out (Конец)<input type="number" min={selected.trimStart} max={selectedAsset?.duration} step=".01" value={selected.trimEnd} onChange={(event) => updateSelected({ trimEnd: Math.max(selected.trimStart + .01, event.target.valueAsNumber) })}/></label></>}</aside>
    </div>
    <section className="nle-timeline"><div className="timeline-ruler"><span>00:00</span><input type="range" min="0" max={Math.max(.01, selectedDuration)} step=".01" value={currentTime} onChange={(event) => seek(event.target.valueAsNumber)}/><span>{formatTime(projectDuration)}</span></div>{tracks.map((track, trackIndex) => <div className={activeTrack === trackIndex ? "nle-track active" : "nle-track"} key={trackIndex} onClick={() => setActiveTrack(trackIndex)}><b>{kind === "video" ? "V" : "A"}{trackIndex + 1}</b><div>{track.map((clip) => { const asset = assets.find((item) => item.id === clip.assetId); return <button draggable className={clip.id === selectedId ? "selected" : ""} key={clip.id} style={{ "--clip-width": `${Math.max(5, clipDuration(clip) / projectDuration * 100)}%` } as CSSProperties} onDragStart={() => { draggedClipRef.current = clip.id; }} onDragOver={(event) => event.preventDefault()} onDrop={() => reorder(clip.id, trackIndex)} onClick={(event) => { event.stopPropagation(); setActiveTrack(trackIndex); setSelectedId(clip.id); setCurrentTime(0); }}>{asset?.file.name}<small>{formatTime(clipDuration(clip))}</small></button>; })}</div></div>)}</section>
  </div>;
}
