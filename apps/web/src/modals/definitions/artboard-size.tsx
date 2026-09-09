import { useState } from "react";
import { useShellStore } from "../../store";
import { text } from "../../i18n";
import type { ModalDefinition } from "../types";

interface ArtboardSizeProps {
  readonly width: number;
  readonly height: number;
  readonly onResolve: (size: { width: number; height: number } | null) => void;
}

/** Sizes worth having one click away, the way every editor's new-artboard list
 * carries a few. Kept short deliberately: a long menu of presets is a browser
 * of its own, and the two fields below already cover everything else. */
const PRESETS: readonly { readonly label: string; readonly width: number; readonly height: number }[] = [
  { label: "1920 × 1080", width: 1920, height: 1080 },
  { label: "1080 × 1080", width: 1080, height: 1080 },
  { label: "1080 × 1920", width: 1080, height: 1920 },
  { label: "A4 — 2480 × 3508", width: 2480, height: 3508 },
];

/**
 * Asks how big a new artboard should be.
 *
 * The owner's request: clicking empty canvas with the Artboard tool should ask
 * for a size rather than doing nothing. Dragging out a rectangle is how a
 * layout is *found*; typing the numbers is how one is *specified*, and an
 * artboard is far more often a known size (1920×1080, A4) than a shape to be
 * eyeballed.
 *
 * Orientation is a swap button rather than a pair of radio buttons: portrait
 * and landscape are the same two numbers in the other order, and a control that
 * says so is smaller and harder to get wrong than one that stores a third piece
 * of state.
 */
function ArtboardSize({ width, height, onResolve, close }: ArtboardSizeProps & { close: () => void }) {
  const language = useShellStore((state) => state.language);
  const [size, setSize] = useState({ width, height });
  const cancel = () => { onResolve(null); close(); };
  const create = () => {
    onResolve({ width: Math.max(1, Math.round(size.width)), height: Math.max(1, Math.round(size.height)) });
    close();
  };

  return <div className="dialog-backdrop rasterize-confirm-backdrop" onMouseDown={cancel}>
    <section
      className="rasterize-confirm artboard-size-dialog"
      role="dialog"
      aria-modal="true"
      tabIndex={-1}
      ref={(node) => node?.focus()}
      onKeyDown={(event) => {
        if (event.key === "Escape") cancel();
        // Enter is "create" everywhere else in this app's dialogs, and a field
        // with two numbers in it is exactly where that shortcut is wanted.
        if (event.key === "Enter") create();
      }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <strong>{text(language, "New artboard", "Новая монтажная область")}</strong>
      <div className="artboard-size-fields">
        <label>{text(language, "Width", "Ширина")}
          <input type="number" min={1} autoFocus value={Math.round(size.width)}
            onChange={(event) => setSize((current) => ({ ...current, width: event.target.valueAsNumber || 0 }))}/>
        </label>
        <label>{text(language, "Height", "Высота")}
          <input type="number" min={1} value={Math.round(size.height)}
            onChange={(event) => setSize((current) => ({ ...current, height: event.target.valueAsNumber || 0 }))}/>
        </label>
        <button className="artboard-size-swap" title={text(language, "Swap width and height", "Поменять ширину и высоту местами")}
          onClick={() => setSize((current) => ({ width: current.height, height: current.width }))}>⇄</button>
      </div>
      <div className="artboard-size-presets">
        {PRESETS.map((preset) => (
          <button key={preset.label} onClick={() => setSize({ width: preset.width, height: preset.height })}>{preset.label}</button>
        ))}
      </div>
      <footer>
        <button onClick={cancel}>{text(language, "Cancel", "Отмена")}</button>
        <button className="primary" onClick={create}>{text(language, "Create", "Создать")}</button>
      </footer>
    </section>
  </div>;
}

export default { id: "artboard-size", component: ArtboardSize } satisfies ModalDefinition<ArtboardSizeProps> as ModalDefinition<never>;
