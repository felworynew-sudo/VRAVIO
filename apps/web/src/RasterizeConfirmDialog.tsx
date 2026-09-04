import { localized } from "./i18n";
import type { Language } from "./store";

/**
 * "This tool needs pixels" — offered when a pixel-destructive tool (paint,
 * clone, retouch…) is used against a text or adjustment layer, which has no
 * pixel buffer of its own to write into yet. Split out of `RasterWorkspace.tsx`
 * purely to bring its own line count down (docs/migration-plan.md §8); the
 * decision of *when* to show this (a tool's `requiresRasterized` flag, or the
 * pre-catalogue `RASTER_ONLY_TOOLS` set) stays in the host, since it depends
 * on which tool is active and what layer it is about to touch.
 */
export function RasterizeConfirmDialog({ layerName, language, onCancel, onConfirm }: {
  layerName: string;
  language: Language;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return <div className="dialog-backdrop rasterize-confirm-backdrop" onMouseDown={onCancel}>
    <section className="rasterize-confirm" role="alertdialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
      <strong>{localized("This tool needs pixels (Этому инструменту нужны пиксели)", language)}</strong>
      <p>{localized(`"${layerName}" is a text layer and has no pixels to edit yet. Rasterize it into a normal pixel layer first? (Слой «${layerName}» — текстовый, у него ещё нет пикселей для редактирования. Растрировать его в обычный слой с пикселями?)`, language)}</p>
      <footer>
        <button onClick={onCancel}>{localized("Cancel (Отмена)", language)}</button>
        <button className="primary" onClick={onConfirm}>{localized("Rasterize Layer (Растрировать слой)", language)}</button>
      </footer>
    </section>
  </div>;
}
