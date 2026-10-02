import { useState } from "react";
import type { RasterBlendMode, RasterLayer } from "@vravio/env-raster";
import { useShellStore } from "../../store";
import { text } from "../../i18n";
import { BLEND_MODES, blendModeById, neutralColorName } from "../../raster-blend-modes";
import type { ModalDefinition } from "../types";
import { ModalBackdrop } from "../ModalBackdrop";

type ColorLabel = NonNullable<RasterLayer["colorLabel"]>;

export interface NewLayerAnswer {
  readonly name: string;
  readonly blendMode: RasterBlendMode;
  readonly opacity: number;
  readonly colorLabel: ColorLabel;
  readonly clipping: boolean;
  /** A hex colour to pre-fill the layer with, or null to leave it empty. */
  readonly fill: string | null;
}

interface NewLayerProps {
  readonly defaultName: string;
  /** False for the bottom-most layer, where there is nothing below to clip to. */
  readonly canClip: boolean;
  readonly onResolve: (answer: NewLayerAnswer | null) => void;
}

const COLOR_LABELS: readonly { id: ColorLabel; en: string; ru: string }[] = [
  { id: "none", en: "None", ru: "Нет" },
  { id: "red", en: "Red", ru: "Красный" },
  { id: "orange", en: "Orange", ru: "Оранжевый" },
  { id: "yellow", en: "Yellow", ru: "Жёлтый" },
  { id: "green", en: "Green", ru: "Зелёный" },
  { id: "blue", en: "Blue", ru: "Синий" },
  { id: "violet", en: "Violet", ru: "Фиолетовый" },
  { id: "grey", en: "Gray", ru: "Серый" },
];

/**
 * Layer ▸ New ▸ Layer… (Shift+Ctrl+N), as Photoshop's dialog: Name, the
 * clipping-mask checkbox, the colour label, Mode with Opacity beside it, and
 * the neutral-colour fill.
 *
 * Every field here already existed on `RasterLayer` (`blendMode`, `opacity`,
 * `colorLabel`, `clipping`) — the dialog only stops them from being
 * something to set afterwards in the Layers panel, which is the whole reason
 * Photoshop's dialog exists. Nothing is offered that the document cannot
 * carry (CLAUDE.md §3).
 *
 * The neutral fill is the field with real work behind it: a layer filled with
 * its mode's neutral colour is invisible until painted on, which is how
 * dodge-and-burn and high-pass sharpening layers are made. Which colour is
 * neutral for which mode is declared once in `raster-blend-modes.ts` and
 * verified against this project's own compositor in `new-layer.test.ts`;
 * for the modes that have none the checkbox is disabled and says so, rather
 * than being hidden — Photoshop greys it out too, and a control that
 * vanishes is harder to understand than one that explains itself.
 *
 * Alt+Shift+Ctrl+N skips this dialog entirely (`layer.newNoDialog`), the
 * same as in Photoshop.
 */
function NewLayer({ defaultName, canClip, onResolve, close }: NewLayerProps & { close: () => void }) {
  const language = useShellStore((state) => state.language);
  const [name, setName] = useState(defaultName);
  const [blendMode, setBlendMode] = useState<RasterBlendMode>("normal");
  const [opacity, setOpacity] = useState(100);
  const [colorLabel, setColorLabel] = useState<ColorLabel>("none");
  const [clipping, setClipping] = useState(false);
  const [fillNeutral, setFillNeutral] = useState(false);

  const mode = blendModeById.get(blendMode)!;
  const neutral = mode.neutral;
  const neutralName = neutralColorName(neutral);
  const cancel = () => { onResolve(null); close(); };
  const accept = () => {
    onResolve({
      name: name.trim() || defaultName,
      blendMode, opacity: Math.max(0, Math.min(1, opacity / 100)),
      colorLabel, clipping: clipping && canClip,
      // A mode with no neutral colour cannot fill, however the checkbox was
      // left when the mode changed under it.
      fill: fillNeutral && neutral ? neutral : null,
    });
    close();
  };

  return <ModalBackdrop className="rasterize-confirm-backdrop" onMouseDown={cancel}>
    <section className="rasterize-confirm size-dialog new-layer-dialog" role="dialog" aria-modal="true" tabIndex={-1} ref={(node) => node?.focus()}
      onKeyDown={(event) => { if (event.key === "Escape") cancel(); if (event.key === "Enter") accept(); }}
      onMouseDown={(event) => event.stopPropagation()}>
      <strong>{text(language, "New Layer", "Новый слой")}</strong>
      <label className="size-dialog-row">{text(language, "Name", "Имя")}
        <input className="new-layer-name" type="text" value={name} autoFocus onChange={(event) => setName(event.target.value)}/>
      </label>
      <label className="size-dialog-row size-dialog-check new-layer-clip">
        <input type="checkbox" checked={clipping && canClip} disabled={!canClip} onChange={(event) => setClipping(event.target.checked)}/>
        {text(language, "Use Previous Layer to Create Clipping Mask", "Использовать предыдущий слой для создания обтравочной маски")}
      </label>
      <label className="size-dialog-row">{text(language, "Color", "Цвет")}
        <select value={colorLabel} onChange={(event) => setColorLabel(event.target.value as ColorLabel)}>
          {COLOR_LABELS.map((entry) => <option key={entry.id} value={entry.id}>{text(language, entry.en, entry.ru)}</option>)}
        </select>
      </label>
      <div className="size-dialog-row new-layer-mode">
        <label>{text(language, "Mode", "Режим")}
          <select value={blendMode} onChange={(event) => setBlendMode(event.target.value as RasterBlendMode)}>
            {BLEND_MODES.map((entry) => <option key={entry.id} value={entry.id}>{text(language, entry.en, entry.ru)}</option>)}
          </select>
        </label>
        <label>{text(language, "Opacity", "Непрозрачность")}
          <input type="number" min="0" max="100" value={opacity} onChange={(event) => { const value = event.target.valueAsNumber; if (Number.isFinite(value)) setOpacity(Math.max(0, Math.min(100, value))); }}/>
          <i>%</i>
        </label>
      </div>
      <label className="size-dialog-row size-dialog-check new-layer-neutral">
        <input type="checkbox" checked={fillNeutral && Boolean(neutral)} disabled={!neutral} onChange={(event) => setFillNeutral(event.target.checked)}/>
        {text(language,
          `Fill with ${mode.en}-neutral color (${neutralName.en})`,
          `Выполнить заливку нейтральным цветом режима «${mode.ru}» (${neutralName.ru})`)}
      </label>
      <footer>
        <button onClick={cancel}>{text(language, "Cancel", "Отмена")}</button>
        <button className="primary" onClick={accept}>OK</button>
      </footer>
    </section>
  </ModalBackdrop>;
}

export default { id: "new-layer", component: NewLayer } satisfies ModalDefinition<NewLayerProps> as ModalDefinition<never>;
