import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AssetId, VravioDocument } from "@vravio/kernel";
import { decodeWav, encodeWav, isAudioDocumentState, mixdownAudioDocument } from "@vravio/env-audio";
import { kernel } from "./kernel";
import { text } from "./i18n";
import { useShellStore } from "./store";

const AUDIO_MASS_PATH = `${import.meta.env.BASE_URL}audiomass/index.html?multitrack=1`;

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

  useEffect(() => {
    let cancelled = false;
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
    {loadError && <div className="audiomass-notice" role="status">{text(language, "The prior session could not be transferred automatically. Open its source file in AudioMass.", "Прошлую сессию не удалось передать автоматически. Откройте исходный файл в AudioMass.")}<small>{loadError}</small></div>}
    <iframe ref={frameRef} src={AUDIO_MASS_PATH} title="AudioMass" onLoad={() => { deliverSource(); syncChrome(); }} />
  </section>;
}
