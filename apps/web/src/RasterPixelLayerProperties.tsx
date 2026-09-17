import { useState } from "react";
import type { RasterDocumentState, RasterLayer } from "@vravio/env-raster";
import { kernel } from "./kernel";
import type { Language } from "./store";

/**
 * The Properties panel's Quick Actions for a plain pixel layer — Remove
 * Background and Select Subject. docs/master-plan.md §12/§14 names this exact
 * panel location for the pair ("не повторять Photoshop-путь через Discover, а
 * держать Remove Background/Select Subject прямо в Properties → Quick
 * Actions").
 *
 * The buttons call the `layer.removeBackground` / `select.subject` commands;
 * the segmentation itself lives in `segment-quick-actions.ts`, shared with the
 * Contextual Task Bar (master-plan §11), which offers the same pair.
 *
 * Perspective and Align & Distribute, the other two sections in the
 * owner's Photoshop screenshot for this same panel, are not here yet:
 * Perspective for a pixel layer means actually resampling and moving pixel
 * content (unlike the text layer's panel, which had a non-destructive
 * transform matrix to reuse). Deferred rather than rushed.
 */

const t = (language: Language, en: string, ru: string) => language === "ru" ? ru : en;

/** Kept importable from here, where its test has always found it. */
export { documentMaskFromLayerMask } from "./segment-quick-actions";

export function RasterPixelLayerProperties({ documentId, language }: { documentId: string; document: RasterDocumentState; layer: RasterLayer; language: Language }) {
  const [running, setRunning] = useState<"remove" | "select" | null>(null);

  const runQuickAction = async (kind: "remove" | "select") => {
    if (running) return;
    setRunning(kind);
    try {
      await kernel.commands.execute(kind === "remove" ? "layer.removeBackground" : "select.subject", { activeDocumentId: documentId });
    } finally {
      setRunning(null);
    }
  };

  return <div className="dock-panel-body property-stack text-properties">
    <header className="text-props-header"><span className="text-props-header-icon">□</span><strong>{t(language, "Pixel layer", "Пиксельный слой")}</strong></header>
    <details className="text-props-section" open>
      <summary>{t(language, "Quick Actions", "Быстрые действия")}</summary>
      <div className="text-props-section-body">
        <button type="button" className="panel-action" disabled={running !== null} onClick={() => void runQuickAction("remove")}>
          {running === "remove" ? t(language, "Removing background…", "Удаление фона…") : t(language, "Remove Background", "Удалить фон")}
        </button>
        <button type="button" className="panel-action" disabled={running !== null} onClick={() => void runQuickAction("select")}>
          {running === "select" ? t(language, "Selecting subject…", "Выделение объекта…") : t(language, "Select Subject", "Выделить объект")}
        </button>
      </div>
    </details>
  </div>;
}
