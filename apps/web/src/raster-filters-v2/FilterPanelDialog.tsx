import { useEffect, useRef, useState } from "react";
import { text } from "../i18n";
import type { Language } from "../store";
import type { FilterPanelDefinition } from "./types";
import { useModalPresence } from "../modals/ModalBackdrop";
import { filterRunsAtDepth } from "@vravio/env-raster";

/**
 * The compact standalone filter dialog docs/master-plan.md §51 found in the
 * owner's reference screenshots: title bar, the filter's own parameter rows,
 * and a fixed Confirm/Reset/Preview column — previewing live on the real
 * canvas via `onPreview`, not inside its own preview pane. This is not a new
 * invention: it is `AdjustmentDialog.tsx` (Levels/Curves/Hue-Saturation
 * already work exactly this way) with a filter definition in place of an
 * adjustment one — same draggable header, same `.adjustment-dialog` shell,
 * same live/cancel/apply contract. `FilterGalleryDialog` (list + big preview
 * canvas + sliders) is Photoshop's own different, secondary "Filter
 * Gallery" surface and is untouched by this — the two are not one dialog
 * wearing two skins, they are genuinely different Photoshop surfaces.
 */
export function FilterPanelDialog({ definition, initialSettings, language, documentDepth = 8, onPreview, onCancel, onApply }: {
  definition: FilterPanelDefinition;
  initialSettings: Record<string, number>;
  language: Language;
  /** The active layer's bits per channel, so the dialog can say when this filter will not use them. */
  documentDepth?: number;
  onPreview(settings: Record<string, number> | null): void;
  onCancel(): void;
  onApply(settings: Record<string, number>): void;
}) {
  useModalPresence();
  const [settings, setSettings] = useState(initialSettings);
  const [preview, setPreview] = useState(true);
  const dialog = useRef<HTMLElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  useEffect(() => { onPreview(preview ? settings : null); return () => onPreview(null); }, [settings, preview, onPreview]);
  useEffect(() => { const key = (event: KeyboardEvent) => { if (event.key === "Escape") onCancel(); if (event.key === "Enter" && !(event.target instanceof HTMLInputElement)) onApply(settings); }; window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key); }, [onApply, onCancel, settings]);
  const move = (event: React.PointerEvent) => { if (!drag.current || !dialog.current) return; dialog.current.style.left = `${drag.current.left + event.clientX - drag.current.x}px`; dialog.current.style.top = `${drag.current.top + event.clientY - drag.current.y}px`; };
  const reset = () => setSettings(definition.defaults);
  return <div className="modeless-layer">
    <section ref={dialog} className="adjustment-dialog filter-panel-dialog" role="dialog" aria-modal="true" onPointerMove={move} onPointerUp={() => { drag.current = null; }}>
      <header onPointerDown={(event) => { const box = dialog.current?.getBoundingClientRect(); if (box && dialog.current) { dialog.current.style.transform = "none"; dialog.current.style.left = `${box.left}px`; dialog.current.style.top = `${box.top}px`; drag.current = { x: event.clientX, y: event.clientY, left: box.left, top: box.top }; event.currentTarget.setPointerCapture(event.pointerId); } }}>
        <strong>{language === "ru" ? definition.name.ru : definition.name.en}</strong>
        <button onClick={onCancel}>×</button>
      </header>
      <div className="adjustment-dialog-body">
        <div className="adjustment-editor filter-panel-editor"><definition.Editor settings={settings} language={language} onChange={setSettings}/></div>
        <aside>
          <button className="primary" onClick={() => onApply(settings)}>{text(language, "Confirm", "Подтвердить")}</button>
          <button onClick={reset}>{text(language, "Reset", "Сбросить")}</button>
          <label><input type="checkbox" checked={preview} onChange={(event) => setPreview(event.target.checked)}/>{text(language, "Preview", "Просмотр")}</label>
          {/* Said out loud rather than left to be assumed (master-plan §59.2b): in a 16- or 32-bit
              document, a filter without a depth-aware implementation computes on an 8-bit view and
              the result is written back deep. The picture is right; the precision is not kept. */}
          {documentDepth > 8 && !filterRunsAtDepth(definition.id) && <p className="filter-panel-note">{text(language, `Computed at 8 bits; this document is ${documentDepth}-bit.`, `Считается в 8 битах; документ — ${documentDepth}-битный.`)}</p>}
        </aside>
      </div>
    </section>
  </div>;
}
