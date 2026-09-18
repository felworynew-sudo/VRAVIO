import { useState } from "react";
import { rasterColorSpaces, type RasterColorSpace } from "@vravio/env-raster";
import { useShellStore } from "../../store";
import { text } from "../../i18n";
import type { ModalDefinition } from "../types";
import { ModalBackdrop } from "../ModalBackdrop";

interface ColorSpaceProps {
  /** What the document is tagged as now. */
  readonly current: RasterColorSpace;
  /** "convert" repaints the pixels into the new space; "assign" only changes what they mean. */
  readonly mode: "assign" | "convert";
  readonly onResolve: (space: RasterColorSpace | null) => void;
}

/**
 * Photoshop's own pair, Edit ▸ Assign Profile and Edit ▸ Convert to Profile, asked in one dialog
 * that says which of the two it is doing (docs/master-plan.md §59).
 *
 * The difference is the whole point and is stated in the dialog rather than assumed known:
 * assigning changes what the existing numbers *mean* (the picture on screen changes, the file's
 * bytes do not); converting rewrites the numbers so the colour stays the same in the new space.
 */
function ColorSpaceDialog({ current, mode, onResolve, close }: ColorSpaceProps & { close: () => void }) {
  const language = useShellStore((state) => state.language);
  const [space, setSpace] = useState<RasterColorSpace>(current);
  const cancel = () => { onResolve(null); close(); };
  const apply = () => { onResolve(space); close(); };

  return <ModalBackdrop className="rasterize-confirm-backdrop" onMouseDown={cancel}>
    <section className="rasterize-confirm color-space-dialog" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
      <h2>{mode === "convert" ? text(language, "Convert to Profile", "Преобразовать в профиль") : text(language, "Assign Profile", "Назначить профиль")}</h2>
      <p>
        {mode === "convert"
          ? text(language, "The pixels are rewritten so the colours stay as they look now.", "Пиксели пересчитываются так, чтобы цвета остались такими же на вид.")
          : text(language, "The pixels stay exactly as they are; only what their numbers mean changes.", "Пиксели остаются прежними, меняется только то, что означают их числа.")}
      </p>
      <label className="color-space-choice">
        <span>{text(language, "Profile", "Профиль")}</span>
        <select value={space} onChange={(event) => setSpace(event.target.value as RasterColorSpace)}>
          {rasterColorSpaces.map((entry) => <option key={entry.id} value={entry.id}>{language === "ru" ? entry.label.ru : entry.label.en}</option>)}
        </select>
      </label>
      <footer>
        <button onClick={cancel}>{text(language, "Cancel", "Отмена")}</button>
        <button className="primary" disabled={space === current && mode === "assign"} onClick={apply}>{text(language, "OK", "ОК")}</button>
      </footer>
    </section>
  </ModalBackdrop>;
}

export default { id: "color-space", component: ColorSpaceDialog } satisfies ModalDefinition<ColorSpaceProps> as ModalDefinition<never>;
