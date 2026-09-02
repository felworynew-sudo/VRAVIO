import { useEffect, useRef, useState } from "react";
import type { RasterAdjustment } from "@vravio/env-raster";
import { text } from "../i18n";
import type { Language } from "../store";
import type { RasterAdjustmentDefinition } from "./types";

export function AdjustmentDialog({ definition, initialValue, language, histogram, onPreview, onCancel, onApply }: { definition: RasterAdjustmentDefinition; initialValue: RasterAdjustment; language: Language; histogram?: readonly number[]; onPreview(value: RasterAdjustment | null): void; onCancel(): void; onApply(value: RasterAdjustment): void }) {
  const [value, setValue] = useState(initialValue);
  const [preview, setPreview] = useState(true);
  const dialog = useRef<HTMLElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  useEffect(() => { onPreview(preview ? value : null); return () => onPreview(null); }, [value, preview, onPreview]);
  useEffect(() => { const key = (event: KeyboardEvent) => { if (event.key === "Escape") onCancel(); if (event.key === "Enter" && !(event.target instanceof HTMLInputElement)) onApply(value); }; window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key); }, [onApply, onCancel, value]);
  const move = (event: React.PointerEvent) => { if (!drag.current || !dialog.current) return; dialog.current.style.left = `${drag.current.left + event.clientX - drag.current.x}px`; dialog.current.style.top = `${drag.current.top + event.clientY - drag.current.y}px`; };
  return <div className="modeless-layer"><section ref={dialog} className="adjustment-dialog" role="dialog" aria-modal="true" onPointerMove={move} onPointerUp={() => { drag.current = null; }}><header onPointerDown={(event) => { const box = dialog.current?.getBoundingClientRect(); if (box && dialog.current) { dialog.current.style.transform = "none"; dialog.current.style.left = `${box.left}px`; dialog.current.style.top = `${box.top}px`; drag.current = { x: event.clientX, y: event.clientY, left: box.left, top: box.top }; event.currentTarget.setPointerCapture(event.pointerId); } }}><img src={definition.icon} alt=""/><strong>{language === "ru" ? definition.name.ru : definition.name.en}</strong><button onClick={onCancel}>×</button></header><div className="adjustment-dialog-body"><div className="adjustment-editor"><definition.Editor value={value} language={language} histogram={histogram} onChange={setValue}/></div><aside><button className="primary" onClick={() => onApply(value)}>OK</button><button onClick={onCancel}>{text(language, "Cancel", "Отмена")}</button><label><input type="checkbox" checked={preview} onChange={(event) => setPreview(event.target.checked)}/>{text(language, "Preview", "Просмотр")}</label></aside></div></section></div>;
}
