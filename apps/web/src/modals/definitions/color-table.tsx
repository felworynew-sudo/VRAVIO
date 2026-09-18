import { useState } from "react";
import { useShellStore } from "../../store";
import { text } from "../../i18n";
import type { ModalDefinition } from "../types";
import { ModalBackdrop } from "../ModalBackdrop";

interface ColorTableProps {
  readonly colors: readonly string[];
  readonly onResolve: (colors: readonly string[] | null) => void;
}

/**
 * Image ▸ Mode ▸ Color Table: the indexed document's own palette, and a way to change an entry.
 *
 * Editing a swatch here is a real edit — the document's pixels are re-snapped onto the changed
 * table by the command that opened this — which is what the entry does in Photoshop too.
 */
function ColorTableDialog({ colors, onResolve, close }: ColorTableProps & { close: () => void }) {
  const language = useShellStore((state) => state.language);
  const [entries, setEntries] = useState<string[]>([...colors]);
  const cancel = () => { onResolve(null); close(); };

  return <ModalBackdrop className="rasterize-confirm-backdrop" onMouseDown={cancel}>
    <section className="rasterize-confirm color-table-dialog" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
      <h2>{text(language, "Color Table", "Таблица цветов")}</h2>
      <p>{text(language, `${entries.length} colours. Click a swatch to change it; the image is re-mapped onto the table.`, `${entries.length} цветов. Нажмите на образец, чтобы изменить его — изображение будет пересопоставлено с таблицей.`)}</p>
      <div className="color-table-grid">
        {entries.map((color, index) => <input
          key={index}
          type="color"
          value={color}
          aria-label={`${index}: ${color}`}
          onChange={(event) => setEntries((current) => current.map((entry, position) => position === index ? event.target.value : entry))}
        />)}
      </div>
      <footer>
        <button onClick={cancel}>{text(language, "Cancel", "Отмена")}</button>
        <button className="primary" onClick={() => { onResolve(entries); close(); }}>{text(language, "OK", "ОК")}</button>
      </footer>
    </section>
  </ModalBackdrop>;
}

export default { id: "color-table", component: ColorTableDialog } satisfies ModalDefinition<ColorTableProps> as ModalDefinition<never>;
