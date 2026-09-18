import { useState } from "react";
import { useShellStore } from "../../store";
import { text } from "../../i18n";
import type { ModalDefinition } from "../types";
import { ModalBackdrop } from "../ModalBackdrop";

interface IndexedColorProps {
  readonly colors: number;
  readonly onResolve: (answer: { colors: number; dither: boolean } | null) => void;
}

/**
 * Photoshop's Indexed Color dialog, cut to the two settings this editor's conversion actually
 * honours (docs/master-plan.md §59.3): how many colours the table holds, and whether the error is
 * diffused. Photoshop's other fields — forced colours, matte, a choice of palette source — are not
 * shown, because offering a control the conversion ignores is the thing CLAUDE.md §3 forbids.
 */
function IndexedColorDialog({ colors, onResolve, close }: IndexedColorProps & { close: () => void }) {
  const language = useShellStore((state) => state.language);
  const [count, setCount] = useState(Math.max(2, Math.min(256, colors || 256)));
  const [dither, setDither] = useState(true);
  const cancel = () => { onResolve(null); close(); };

  return <ModalBackdrop className="rasterize-confirm-backdrop" onMouseDown={cancel}>
    <section className="rasterize-confirm color-space-dialog" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
      <h2>{text(language, "Indexed Color", "Индексированные цвета")}</h2>
      <p>{text(language, "The image is reduced to one colour table. Colours outside it are replaced by the nearest entry.", "Изображение сводится к одной таблице цветов. Цвета вне её заменяются ближайшими.")}</p>
      <label className="color-space-choice">
        <span>{text(language, "Colors", "Цветов")}</span>
        <input type="number" min={2} max={256} value={count} onChange={(event) => setCount(Math.max(2, Math.min(256, Math.round(event.target.valueAsNumber || 2))))} />
      </label>
      <label className="color-space-choice">
        <span>{text(language, "Dither", "Дизеринг")}</span>
        <input type="checkbox" checked={dither} onChange={(event) => setDither(event.target.checked)} />
      </label>
      <footer>
        <button onClick={cancel}>{text(language, "Cancel", "Отмена")}</button>
        <button className="primary" onClick={() => { onResolve({ colors: count, dither }); close(); }}>{text(language, "OK", "ОК")}</button>
      </footer>
    </section>
  </ModalBackdrop>;
}

export default { id: "indexed-color", component: IndexedColorDialog } satisfies ModalDefinition<IndexedColorProps> as ModalDefinition<never>;
