import { useEffect, useState, type CSSProperties } from "react";
import type { EnvironmentKind } from "@vravio/kernel";
import type { Language } from "./store";
import { applyWorkspacePreset, deleteWorkspacePreset, renameWorkspacePreset, resetWorkspacePreset, saveWorkspacePreset, selectedWorkspacePreset, workspacePresetsFor } from "./workspace-presets";
import { useCloseOnOutsideClick } from "./useCloseOnOutsideClick";

export function WorkspaceSwitcher({ kind, language }: { kind: EnvironmentKind; language: Language }) {
  const presets = workspacePresetsFor(kind), [open, setOpen] = useState(false), [selected, setSelected] = useState(() => selectedWorkspacePreset(kind)), [dialogMode, setDialogMode] = useState<"save" | "rename" | null>(null), [name, setName] = useState("");
  useEffect(() => { setSelected(selectedWorkspacePreset(kind)); setOpen(false); }, [kind]);
  useCloseOnOutsideClick(open, ".workspace-switcher", () => setOpen(false));
  if (!presets.length) return null;
  const active = presets.find((preset) => preset.id === selected) ?? presets[0]!;
  const label = (preset: typeof active) => language === "ru" ? preset.label.ru : preset.label.en;
  const submitName = () => {
    if (dialogMode === "rename") renameWorkspacePreset(kind, active.id, name);
    else { const created = saveWorkspacePreset(kind, name); if (created) setSelected(created.id); }
    setName(""); setDialogMode(null);
  };
  return <div className="workspace-switcher">
    <button className="workspace-switcher-trigger" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-label={label(active)} title={label(active)}><i style={{ "--icon-mask": `url("${import.meta.env.BASE_URL}РАБОЧЕЕ-ПРОСТРАНСТВО.svg")` } as CSSProperties}/><span>{label(active)}</span><b style={{ "--icon-mask": `url("${import.meta.env.BASE_URL}СТРЕЛКА-ВНИЗ.svg")` } as CSSProperties}/></button>
    {open && <div className="workspace-switcher-menu" role="menu">{presets.map((preset) => <button key={preset.id} role="menuitemradio" aria-checked={preset.id === active.id} onClick={() => { applyWorkspacePreset(kind, preset.id); setSelected(preset.id); setOpen(false); }}><span>{label(preset)}</span>{preset.id === active.id && <i aria-label={language === "ru" ? "Выбрано" : "Selected"} style={{ "--icon-mask": `url("${import.meta.env.BASE_URL}ГАЛОЧКА.svg")` } as CSSProperties}/>}</button>)}<div className="workspace-switcher-separator"/><button className="workspace-reset" role="menuitem" onClick={() => { setName(""); setDialogMode("save"); setOpen(false); }}>{language === "ru" ? "Сохранить рабочую среду…" : "Save Workspace…"}</button>{active.custom && <><button className="workspace-reset" role="menuitem" onClick={() => { setName(label(active)); setDialogMode("rename"); setOpen(false); }}>{language === "ru" ? `Переименовать «${label(active)}»…` : `Rename ${label(active)}…`}</button><button className="workspace-reset" role="menuitem" onClick={() => { deleteWorkspacePreset(kind, active.id); setSelected("essentials"); setOpen(false); }}>{language === "ru" ? `Удалить «${label(active)}»` : `Delete ${label(active)}`}</button></>}<button className="workspace-reset" role="menuitem" onClick={() => { resetWorkspacePreset(kind); setOpen(false); }}>{language === "ru" ? `Сбросить «${label(active)}»` : `Reset ${label(active)}`}</button></div>}
    {dialogMode && <div className="workspace-name-backdrop" role="presentation"><form className="workspace-name-dialog" onSubmit={(event) => { event.preventDefault(); submitName(); }}><strong>{dialogMode === "rename" ? (language === "ru" ? "Переименовать рабочую среду" : "Rename Workspace") : (language === "ru" ? "Сохранить рабочую среду" : "Save Workspace")}</strong><input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder={language === "ru" ? "Название" : "Name"}/><footer><button type="button" onClick={() => setDialogMode(null)}>{language === "ru" ? "Отмена" : "Cancel"}</button><button type="submit" disabled={!name.trim()}>{dialogMode === "rename" ? (language === "ru" ? "Переименовать" : "Rename") : (language === "ru" ? "Сохранить" : "Save")}</button></footer></form></div>}
  </div>;
}
