import { useState } from "react";
import { cloneRasterState, layerDocumentPixels, setLayerPixels, type RasterDocumentState, type RasterLayer } from "@vravio/env-raster";
import { kernel } from "./kernel";
import { beginBusy } from "./busy";
import { confirmModal, errorModal } from "./modals/runtime";
import { neuralFilterById, neuralFilters } from "./ml/neural-filters/registry";
import type { NeuralFilterDefinition } from "./ml/neural-filters/types";
import { text as t } from "./i18n";
import type { Language } from "./store";
import { ModalBackdrop } from "./modals/ModalBackdrop";

/**
 * Filter → Neural Filters (docs/master-plan.md §52.9) — a shared home for neural filters, styled
 * on the owner's own Photoshop screenshot: a category list on the left (each entry showing its
 * own download size until cached), a live before/after preview in the middle, that filter's own
 * settings on the right (none yet — the one filter here so far, Remove Background, has none),
 * and Cancel/Apply.
 *
 * "Output: Current Layer" is the only target this pass offers — `ml/neural-filters/types.ts`'s
 * own doc comment on `NeuralFilterDefinition.run` explains why every filter hosted here has to be
 * same-size-in-same-size-out to fit that contract, and why Real-ESRGAN's own standalone dialog and
 * the Object Selection tool (different output shapes entirely) are not entries in this list.
 *
 * Explicit model loading is unconditional here (a browser tab, not the desktop build) — Tauri
 * shipping models already bundled, so this dialog never has to ask, is real, separate desktop-
 * packaging work docs/master-plan.md §52.9 names but this session does not touch.
 */

type Preview = { readonly pixels: Uint8ClampedArray; readonly filterId: string };

export function NeuralFiltersDialog({ documentId, document, layer, language, onClose, initialFilterId }: { documentId: string; document: RasterDocumentState; layer: RasterLayer; language: Language; onClose(): void; initialFilterId?: string | undefined }) {
  const [selectedId, setSelectedId] = useState<string | undefined>(initialFilterId ?? neuralFilters[0]?.id);
  const [running, setRunning] = useState(false);
  const [showBefore, setShowBefore] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const selected = neuralFilterById(selectedId);
  const before = layerDocumentPixels(layer, document.width, document.height);

  const runSelected = async (filter: NeuralFilterDefinition) => {
    if (running) return;
    // Set before the consent await, not only once `beginBusy` starts below — a second click
    // landing while the consent prompt is still open (`running` was still false at that point)
    // started a second, concurrent model load racing the first, and onnxruntime-web answered with
    // "Session already started"/"Session mismatch" instead of either one actually running. Found
    // live by double-clicking through a stray overlay hiding the consent dialog. The whole
    // function now runs under one try/finally so every exit path — declining the download
    // included — clears it again.
    setRunning(true);
    let done: (() => void) | null = null;
    try {
      if (!(await filter.isCached())) {
        const megabytes = (filter.specs.reduce((sum, spec) => sum + spec.sizeBytes, 0) / (1024 * 1024)).toFixed(1);
        const licences = [...new Set(filter.specs.map((spec) => spec.licence))].join(", ");
        const ok = await confirmModal({
          title: t(language, "Download model?", "Скачать модель?"),
          message: t(
            language,
            `${filter.label.en} (~${megabytes} MB) will be downloaded from Hugging Face and cached in this browser — this happens once. Licence: ${licences}.`,
            `${filter.label.ru} (~${megabytes} МБ) будет загружена с Hugging Face и закэширована в этом браузере — один раз. Лицензия: ${licences}.`,
          ),
          confirmKey: `model:${filter.id}`,
        });
        if (!ok) return;
      }

      done = beginBusy(t(language, "Running filter", "Применение фильтра"));
      const outcome = await filter.run(before, document.width, document.height, {});
      if (!outcome.pixels) { if (outcome.error) errorModal({ title: t(language, "Filter failed", "Не удалось применить фильтр"), message: outcome.error }); return; }
      setPreview({ pixels: outcome.pixels, filterId: filter.id });
      setShowBefore(false);
    } catch (error) {
      errorModal({ title: t(language, "Filter failed", "Не удалось применить фильтр"), message: error instanceof Error ? error.message : String(error) });
    } finally {
      done?.();
      setRunning(false);
    }
  };

  const apply = async () => {
    if (!preview || preview.filterId !== selectedId) return;
    const beforeState = cloneRasterState(document);
    const afterState = cloneRasterState(document);
    const target = afterState.layers.find((item) => item.id === layer.id);
    if (!target) return;
    setLayerPixels(target, preview.pixels, afterState.width, afterState.height, null, { keepOutsideDocument: true });

    const history = kernel.historyByDocument.get(documentId);
    if (history) {
      const clone = (state: RasterDocumentState) => cloneRasterState(state);
      await history.execute({
        label: selected ? t(language, `Neural Filter: ${selected.label.en}`, `Нейрофильтр: ${selected.label.ru}`) : t(language, "Neural Filter", "Нейрофильтр"),
        redo: () => { kernel.documents.update<RasterDocumentState>(documentId, (current) => { Object.assign(current, clone(afterState)); }); },
        undo: () => { kernel.documents.update<RasterDocumentState>(documentId, (current) => { Object.assign(current, clone(beforeState)); }); },
      });
    }
    onClose();
  };

  const categories = [...new Map(neuralFilters.map((filter) => [filter.category.en, filter.category])).values()];

  return <ModalBackdrop className="neural-filters-backdrop" onMouseDown={onClose}>
    <section className="neural-filters-dialog" role="dialog" aria-modal="true" aria-label={t(language, "Neural Filters", "Нейрофильтры")} onMouseDown={(event) => event.stopPropagation()}>
      <header><strong>{t(language, "Neural Filters", "Нейрофильтры")}</strong><button onClick={onClose}>×</button></header>
      <div className="neural-filters-body">
        <aside className="neural-filters-list">
          {categories.map((category) => <details key={category.en} open>
            <summary>{t(language, category.en, category.ru ?? category.en)}</summary>
            {neuralFilters.filter((filter) => filter.category.en === category.en).map((filter) => (
              <NeuralFilterRow key={filter.id} filter={filter} selected={filter.id === selectedId} language={language} onSelect={() => setSelectedId(filter.id)} />
            ))}
          </details>)}
        </aside>
        <main className="neural-filters-preview">
          <canvas ref={(canvas) => {
            if (!canvas) return;
            canvas.width = document.width; canvas.height = document.height;
            const context = canvas.getContext("2d"); if (!context) return;
            const shown = showBefore || !preview || preview.filterId !== selectedId ? before : preview.pixels;
            context.putImageData(new ImageData(shown as Uint8ClampedArray<ArrayBuffer>, document.width, document.height), 0, 0);
          }} />
          {preview && preview.filterId === selectedId && (
            <label className="neural-filters-toggle"><input type="checkbox" checked={showBefore} onChange={(event) => setShowBefore(event.target.checked)} />{t(language, "Show original", "Показать исходник")}</label>
          )}
        </main>
        <aside className="neural-filters-settings">
          {selected && <>
            <div className="panel-hint">{t(language, selected.label.en, selected.label.ru ?? selected.label.en)}</div>
            {selected.note && <div className="panel-hint">{t(language, selected.note.en, selected.note.ru ?? selected.note.en)}</div>}
            <button type="button" className="primary" disabled={running} onClick={() => void runSelected(selected)}>
              {running ? t(language, "Running…", "Выполняется…") : t(language, "Preview", "Просмотр")}
            </button>
          </>}
          {!selected && <div className="panel-hint">{t(language, "No neural filters are registered.", "Нет зарегистрированных нейрофильтров.")}</div>}
        </aside>
      </div>
      <footer>
        <button onClick={onClose}>{t(language, "Cancel", "Отмена")}</button>
        <button className="primary" disabled={!preview || preview.filterId !== selectedId} onClick={() => void apply()}>{t(language, "OK", "ОК")}</button>
      </footer>
    </section>
  </ModalBackdrop>;
}

function NeuralFilterRow({ filter, selected, language, onSelect }: { filter: NeuralFilterDefinition; selected: boolean; language: Language; onSelect(): void }) {
  const [cached, setCached] = useState<boolean | null>(null);
  if (cached === null) void filter.isCached().then(setCached);
  const megabytes = (filter.specs.reduce((sum, spec) => sum + spec.sizeBytes, 0) / (1024 * 1024)).toFixed(1);
  return <button type="button" className={selected ? "neural-filter-row selected" : "neural-filter-row"} onClick={onSelect}>
    <span>{t(language, filter.label.en, filter.label.ru ?? filter.label.en)}</span>
    {cached === false && <span className="neural-filter-badge" title={t(language, `Downloads ~${megabytes} MB`, `Загрузит ~${megabytes} МБ`)}>☁ {megabytes}{t(language, " MB", " МБ")}</span>}
  </button>;
}
