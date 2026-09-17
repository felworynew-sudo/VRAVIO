import { useState } from "react";
import { useShellStore } from "../../store";
import { text } from "../../i18n";
import type { ModalDefinition } from "../types";
import { ModalBackdrop } from "../ModalBackdrop";

export interface SelectModifyAnswer {
  readonly amount: number;
  /** Photoshop's "Apply effect at canvas bounds"; only asked when `askCanvasBounds`. */
  readonly applyAtCanvasBounds: boolean;
}

interface SelectModifyProps {
  readonly title: { readonly en: string; readonly ru: string };
  readonly label: { readonly en: string; readonly ru: string };
  readonly amount: number;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly askCanvasBounds: boolean;
  readonly applyAtCanvasBounds: boolean;
  readonly onResolve: (answer: SelectModifyAnswer | null) => void;
}

/**
 * Select ▸ Modify's one-number dialogs — Feather, Expand, Contract, Smooth.
 *
 * Photoshop asks each of them the same way: one amount in pixels and, for the
 * operations that can pull a selection away from the canvas edge, "Apply
 * effect at canvas bounds". One dialog with those two fields, not four copies
 * of it. The checkbox is only shown where the operation actually reads it
 * (CLAUDE.md §3).
 */
function SelectModify({ title, label, amount, min, max, step, askCanvasBounds, applyAtCanvasBounds, onResolve, close }: SelectModifyProps & { close: () => void }) {
  const language = useShellStore((state) => state.language);
  const [value, setValue] = useState(amount);
  const [atBounds, setAtBounds] = useState(applyAtCanvasBounds);
  const valid = Number.isFinite(value) && value >= min && value <= max;
  const cancel = () => { onResolve(null); close(); };
  const accept = () => {
    if (!valid) return;
    onResolve({ amount: value, applyAtCanvasBounds: askCanvasBounds && atBounds });
    close();
  };

  return <ModalBackdrop className="rasterize-confirm-backdrop" onMouseDown={cancel}>
    <section
      className="rasterize-confirm select-modify-dialog"
      role="dialog"
      aria-modal="true"
      aria-label={text(language, title.en, title.ru)}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape") cancel();
        if (event.key === "Enter") accept();
      }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <strong>{text(language, title.en, title.ru)}</strong>
      <label className="select-modify-field">{text(language, label.en, label.ru)}
        <input type="number" autoFocus min={min} max={max} step={step} value={Number.isFinite(value) ? value : ""}
          onChange={(event) => setValue(event.target.valueAsNumber)} onFocus={(event) => event.target.select()} />
        <span>{text(language, "px", "пикс.")}</span>
      </label>
      {askCanvasBounds && <label className="confirm-suppress">
        <input type="checkbox" checked={atBounds} onChange={(event) => setAtBounds(event.target.checked)} />
        {text(language, "Apply effect at canvas bounds", "Применить эффект у границ холста")}
      </label>}
      <footer>
        <button onClick={cancel}>{text(language, "Cancel", "Отмена")}</button>
        <button className="primary" disabled={!valid} onClick={accept}>OK</button>
      </footer>
    </section>
  </ModalBackdrop>;
}

export default { id: "select-modify", component: SelectModify } satisfies ModalDefinition<SelectModifyProps> as ModalDefinition<never>;
