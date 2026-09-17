import type { RasterDocumentState, RasterLayer } from "@vravio/env-raster";
import { isRasterDocumentState } from "@vravio/env-raster";
import { IconAlign, updateText } from "../TextLayerProperties";
import { text as bilingual } from "../i18n";
import { useShellStore } from "../store";
import type { ContextualBarContext } from "./states";

/**
 * The bar's type controls: font, size, alignment — Photoshop shows exactly these
 * next to a text layer (master-plan §11.1, "быстрый доступ к font/style/size/
 * align/spacing прямо в панели").
 *
 * Every control writes through `updateText`, the Properties panel's own path:
 * one patch of `RasterTextData`, one re-rasterise through `renderTextLayerPixels`,
 * one mergeable history step. There is no second implementation here, and no
 * field the panel does not already offer — the rest of Photoshop's type strip
 * (style, leading, tracking) stays in Properties, where it fits.
 */
export function TextControls({ context }: { context: ContextualBarContext }) {
  const language = useShellStore((store) => store.language);
  const state = isRasterDocumentState(context.state) ? context.state as RasterDocumentState : null;
  const layer: RasterLayer | undefined = state?.layers.find((item) => item.id === state.activeLayerId);
  const data = layer?.text;
  if (!state || !layer || !data) return null;
  const t = (en: string, ru: string) => bilingual(language, en, ru);
  const update = (patch: Parameters<typeof updateText>[2], label: string) => updateText(context.documentId, layer.id, patch, label);
  const aligned = (value: "left" | "center" | "right") => (data.justify ?? "none") === "none" && data.align === value;

  return <>
    <input
      className="contextual-bar-field contextual-bar-font"
      value={data.fontFamily}
      title={t("Font", "Шрифт")} aria-label={t("Font", "Шрифт")}
      onChange={(event) => update({ fontFamily: event.target.value }, t("Font (Шрифт)", "Шрифт"))}
    />
    <input
      className="contextual-bar-field contextual-bar-size"
      type="number" min={1} max={1000} value={Math.round(data.fontSize)}
      title={t("Size", "Кегль")} aria-label={t("Size", "Кегль")}
      onChange={(event) => { const size = event.target.valueAsNumber; if (Number.isFinite(size)) update({ fontSize: Math.max(1, size) }, t("Size (Кегль)", "Кегль")); }}
    />
    {(["left", "center", "right"] as const).map((value) => <button
      key={value}
      type="button"
      className={`contextual-bar-icon-button${aligned(value) ? " active" : ""}`}
      data-action={`text.align.${value}`}
      aria-pressed={aligned(value)}
      title={value === "left" ? t("Align left", "По левому краю") : value === "center" ? t("Align center", "По центру") : t("Align right", "По правому краю")}
      onClick={() => update({ align: value, justify: "none" }, value === "left" ? t("Align Left (Выровнять по левому краю)", "Выровнять по левому краю") : value === "center" ? t("Align Center (Выровнять по центру)", "Выровнять по центру") : t("Align Right (Выровнять по правому краю)", "Выровнять по правому краю"))}
    >{IconAlign(value)}</button>)}
  </>;
}
