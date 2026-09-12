import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AssetId, VravioDocument } from "@vravio/kernel";
import { decodeWav, encodeWav, isAudioDocumentState, mixdownAudioDocument } from "@vravio/env-audio";
import { kernel } from "./kernel";
import { text } from "./i18n";
import { useShellStore } from "./store";
import { decodeAudioFileToWav } from "./audioImport";
import { replaceWithExportedAudio } from "./audio-commands";

const AUDIO_MASS_PATH = `${import.meta.env.BASE_URL}audiomass/index.html?multitrack=1&skipintro=1`;

/**
 * AudioMass is deliberately kept in its own document (an iframe), rather than
 * being reimplemented as React controls in the VRAVIO tree.  That preserves
 * its tested Web Audio graph, keyboard model and effect dialogs while the
 * surrounding shell keeps document tabs, colour preferences and file routing.
 *
 * Old VRAVIO audio documents are converted once at this boundary.  A one-clip
 * document is byte-identical; an older multi-track session is mixed to WAV so
 * it can still be opened instead of becoming inaccessible after the swap.
 */
export function AudioMassWorkspace({ document }: { document: VravioDocument }) {
  const language = useShellStore((state) => state.language);
  const theme = useShellStore((state) => state.theme);
  const preferences = useShellStore((state) => state.preferences);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [source, setSource] = useState<File | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const state = isAudioDocumentState(document.state) ? document.state : null;
  const requestId = useMemo(() => `audio-${document.id}`, [document.id]);
  // Set right before `replaceWithExportedAudio` writes the new document revision this same
  // component is about to observe below — without it, the source-rebuild effect would notice
  // the new asset and `deliverSource` would push it straight back into AudioMass as an
  // `open-file`, wiping the very editing session (undo history, unsaved selection) the user
  // just exported from. The document itself is still updated; only the round-trip reload is
  // skipped, once, for the revision this component's own write produced.
  const skipNextReloadRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    if (skipNextReloadRef.current) { skipNextReloadRef.current = false; return; }
    if (!state) { setSource(null); return; }
    const clips = state.tracks.flatMap((track) => track.clips);
    if (clips.length === 0) { setSource(null); return; }

    void (async () => {
      try {
        const assetIds = [...new Set(clips.map((clip) => clip.assetId))];
        const decoded = new Map<string, ReturnType<typeof decodeWav>>();
        await Promise.all(assetIds.map(async (assetId) => {
          const bytes = await kernel.assets.read(assetId as AssetId);
          if (!bytes) throw new Error(`Audio asset ${assetId} is unavailable`);
          decoded.set(assetId, decodeWav(bytes));
        }));
        const bytes = clips.length === 1
          ? await kernel.assets.read(clips[0]!.assetId as AssetId)
          : encodeWav(mixdownAudioDocument(state, (assetId) => decoded.get(assetId)), state.sampleRate, state.bitDepth);
        if (!bytes) throw new Error("Audio source is unavailable");
        const name = clips.length === 1
          ? (kernel.assets.get(clips[0]!.assetId as AssetId)?.name ?? document.name)
          : `${document.name.replace(/\.[^.]+$/, "") || "Audio mix"}.wav`;
        const payload = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        if (!cancelled) setSource(new File([payload], name, { type: "audio/wav" }));
      } catch (error) {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => { cancelled = true; };
  }, [document.id, document.name, state]);

  // The only channel back out of the iframe: vravio-bridge.js intercepts AudioMass's own
  // download-triggering click() (export to WAV/MP3/FLAC/OGG, from whichever of AudioMass's own
  // three call sites drove it) and relays the bytes here instead of just letting them leave as
  // a browser download. Re-decoding through the browser's own audio stack keeps the asset in
  // VRAVIO's single internal format (WAV) regardless of which format AudioMass exported, the
  // same path a dropped MP3/FLAC file already goes through on import (`audioImport.ts`).
  useEffect(() => {
    const handleExport = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.source !== frameRef.current?.contentWindow) return;
      const data = event.data as { type?: string; filename?: string; mime?: string; buffer?: ArrayBuffer } | null;
      if (!data || data.type !== "vravio:audiomass:export" || !data.buffer) return;
      void (async () => {
        const file = new File([data.buffer!], data.filename ?? "export.wav", { type: data.mime ?? "audio/wav" });
        const wav = await decodeAudioFileToWav(file);
        if (!wav) return;
        const decoded = decodeWav(wav);
        const assetId = await kernel.assets.importAsset(wav, { kind: "audio", mime: "audio/wav", name: file.name });
        skipNextReloadRef.current = true;
        await replaceWithExportedAudio(document.id, assetId, file.name, decoded.channelData[0]?.length ?? 0, decoded.sampleRate);
      })();
    };
    window.addEventListener("message", handleExport);
    return () => window.removeEventListener("message", handleExport);
  }, [document.id]);

  const deliverSource = useCallback(() => {
    const target = frameRef.current?.contentWindow;
    if (!target || !source) return;
    target.postMessage({ type: "vravio:audiomass:open-file", requestId, file: source }, window.location.origin);
  }, [requestId, source]);

  useEffect(() => { deliverSource(); }, [deliverSource]);

  // AudioMass is isolated by an iframe, therefore CSS variables do not cross
  // the document boundary. Send the resolved VRAVIO palette and language over
  // the same explicit bridge used for source files rather than duplicating a
  // second theme system in the vendor application.
  const syncChrome = useCallback(() => {
    const target = frameRef.current?.contentWindow;
    const host = window.document.querySelector<HTMLElement>(".app");
    if (!target || !host) return;
    const css = getComputedStyle(host);
    target.postMessage({
      type: "vravio:audiomass:chrome",
      language,
      theme,
      palette: {
        background: css.getPropertyValue("--bg").trim(),
        surface: css.getPropertyValue("--surface").trim(),
        raisedSurface: css.getPropertyValue("--surface2").trim(),
        hoverSurface: css.getPropertyValue("--surface3").trim(),
        border: css.getPropertyValue("--border").trim(),
        text: css.getPropertyValue("--text").trim(),
        muted: css.getPropertyValue("--muted").trim(),
        accent: css.getPropertyValue("--audio").trim(),
      },
    }, window.location.origin);
  }, [language, preferences, theme]);

  useEffect(() => {
    const invoke = (event: Event) => {
      const detail = (event as CustomEvent<{ menu: string; item: string }>).detail;
      const target = frameRef.current?.contentWindow;
      if (detail && target) target.postMessage({ type: "vravio:audiomass:command", ...detail }, window.location.origin);
    };
    window.addEventListener("vravio-audiomass-command", invoke);
    return () => window.removeEventListener("vravio-audiomass-command", invoke);
  }, []);

  useEffect(() => { syncChrome(); }, [syncChrome]);

  return <section className="audiomass-workspace" aria-label={text(language, "Audio editor", "Аудиоредактор")}>
    {loadError && <div className="audiomass-notice" role="status">{text(language, "The prior session could not be transferred automatically. Open its source file in the audio editor.", "Прошлую сессию не удалось передать автоматически. Откройте исходный файл в аудиоредакторе.")}<small>{loadError}</small></div>}
    <iframe ref={frameRef} src={AUDIO_MASS_PATH} title={text(language, "VRAVIO audio editor", "Аудиоредактор VRAVIO")} onLoad={() => { deliverSource(); syncChrome(); }} />
  </section>;
}
