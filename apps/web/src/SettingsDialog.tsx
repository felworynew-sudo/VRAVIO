import { useEffect, useMemo, useState } from "react";
import { shortcutFromEvent } from "@vravio/kernel";
import { text } from "./i18n";
import { useShellStore, type Language, type RendererPreference, type Theme } from "./store";
import { kernel } from "./kernel";
import { isShortcutOverridden, rebindCommandShortcut, resetCommandShortcut } from "./shortcuts";

type SettingsPage = "interface" | "performance" | "convenience" | "guides" | "shortcuts";

const languages: readonly { value: Language; label: string }[] = [
  { value: "ru", label: "Русский" }, { value: "en", label: "English" }, { value: "uk", label: "Українська" },
  { value: "es", label: "Español" }, { value: "de", label: "Deutsch" }, { value: "ja", label: "日本語" }, { value: "zh", label: "中文" },
];

export function SettingsDialog() {
  const store = useShellStore();
  const [page, setPage] = useState<SettingsPage>("interface");
  const [query, setQuery] = useState("");
  const language = store.language;
  const pages = useMemo(() => ([
    ["interface", text(language, "Interface", "Интерфейс")], ["performance", text(language, "Performance", "Производительность")],
    ["convenience", text(language, "Convenience", "Удобство")], ["guides", text(language, "Guides & Grid", "Направляющие и сетка")],
    ["shortcuts", text(language, "Keyboard shortcuts", "Горячие клавиши")],
  ] as const).filter(([, label]) => label.toLocaleLowerCase().includes(query.toLocaleLowerCase())), [language, query]);
  if (!store.settingsOpen) return null;

  return <div className="dialog-backdrop" onMouseDown={() => store.setSettingsOpen(false)}>
    <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title" onMouseDown={(event) => event.stopPropagation()}>
      <header><div><small>VRAVIO</small><h2 id="settings-title">{text(language, "Settings", "Настройки")}</h2></div><button onClick={() => store.setSettingsOpen(false)} aria-label={text(language, "Close", "Закрыть")}>×</button></header>
      <div className="settings-layout">
        <aside><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={text(language, "Search settings…", "Поиск настроек…")} />{pages.map(([id, label]) => <button className={page === id ? "active" : ""} key={id} onClick={() => setPage(id)}>{label}</button>)}</aside>
        <div className="settings-content">
          {page === "interface" && <>
            <SettingsHeading title={text(language, "Interface", "Интерфейс")} description={text(language, "Language, theme and semantic interface colors.", "Язык, тема и смысловые цвета интерфейса.")} />
            <SettingRow title={text(language, "Language", "Язык")} description={text(language, "Unsupported translations temporarily fall back to English.", "Непереведённые строки временно отображаются на английском.")}><select value={language} onChange={(event) => store.setLanguage(event.target.value as Language)}>{languages.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}</select></SettingRow>
            <SettingRow title={text(language, "Color theme", "Цветовая тема")} description={text(language, "Applied immediately and saved locally.", "Применяется сразу и сохраняется локально.")}><select value={store.theme} onChange={(event) => store.setTheme(event.target.value as Theme)}><option value="dark">{text(language, "Dark", "Тёмная")}</option><option value="light">{text(language, "Light", "Светлая")}</option><option value="contrast">{text(language, "High contrast", "Контрастная")}</option></select></SettingRow>
            <div className="settings-color-grid">
              <ColorSetting label={text(language, "Focus", "Фокус")} value={store.preferences.focusColor} onChange={(focusColor) => store.updatePreferences({ focusColor })} />
              <ColorSetting label={text(language, "Canvas surround", "Фон вокруг холста")} value={store.preferences.canvasSurround} onChange={(canvasSurround) => store.updatePreferences({ canvasSurround })} />
              <ColorSetting label={text(language, "Raster", "Растр")} value={store.preferences.rasterColor} onChange={(rasterColor) => store.updatePreferences({ rasterColor })} />
              <ColorSetting label={text(language, "Vector", "Вектор")} value={store.preferences.vectorColor} onChange={(vectorColor) => store.updatePreferences({ vectorColor })} />
              <ColorSetting label={text(language, "Audio", "Аудио")} value={store.preferences.audioColor} onChange={(audioColor) => store.updatePreferences({ audioColor })} />
              <ColorSetting label={text(language, "Video", "Видео")} value={store.preferences.videoColor} onChange={(videoColor) => store.updatePreferences({ videoColor })} />
            </div><button className="settings-reset" onClick={store.resetAppearance}>{text(language, "Reset appearance colors", "Сбросить цвета оформления")}</button>
          </>}
          {page === "performance" && <>
            <SettingsHeading title={text(language, "Performance", "Производительность")} description={text(language, "Rendering backend and resource budgets. Changes are consumed by shared platform services.", "Графический движок и лимиты ресурсов. Эти параметры используются общими платформенными сервисами.")} />
            <SettingRow title={text(language, "Renderer", "Рендерер")} description="WebGPU → WebGL2 → Canvas2D"><select value={store.preferences.renderer} onChange={(event) => store.updatePreferences({ renderer: event.target.value as RendererPreference })}><option value="auto">Auto</option><option value="webgpu">WebGPU</option><option value="webgl2">WebGL2</option><option value="canvas2d">Canvas2D</option></select></SettingRow>
            <SettingRow title={text(language, "Memory budget", "Лимит памяти")} description={text(language, "Budget for derived caches, not unsaved user data.", "Лимит производных кэшей, но не несохранённых данных.")}><NumberInput value={store.preferences.memoryBudgetMb} min={256} max={32768} suffix="MB" onChange={(memoryBudgetMb) => store.updatePreferences({ memoryBudgetMb })} /></SettingRow>
            <SettingRow title={text(language, "Worker threads", "Рабочие потоки")} description={text(language, "Filters, decoding, peaks and AI run outside the UI thread.", "Фильтры, декодирование, пики и AI выполняются вне UI-потока.")}><NumberInput value={store.preferences.workerCount} min={1} max={32} onChange={(workerCount) => store.updatePreferences({ workerCount })} /></SettingRow>
            <ToggleRow title={text(language, "Performance overlay", "Монитор производительности")} checked={store.preferences.showPerformanceOverlay} onChange={(showPerformanceOverlay) => store.updatePreferences({ showPerformanceOverlay })} />
          </>}
          {page === "convenience" && <>
            <SettingsHeading title={text(language, "Convenience", "Удобство")} description={text(language, "Interaction behavior shared by all workspaces.", "Поведение взаимодействия, общее для всех рабочих сред.")} />
            <ToggleRow title={text(language, "Drag zoom", "Масштабирование перетаскиванием")} checked={store.preferences.dragZoom} onChange={(dragZoom) => store.updatePreferences({ dragZoom })} />
            <ToggleRow title={text(language, "Tooltips", "Всплывающие подсказки")} checked={store.preferences.showTooltips} onChange={(showTooltips) => store.updatePreferences({ showTooltips })} />
            <ToggleRow title={text(language, "Contextual task bar", "Контекстная панель действий")} checked={store.preferences.contextualBar} onChange={(contextualBar) => store.updatePreferences({ contextualBar })} />
          </>}
          {page === "guides" && <>
            <SettingsHeading title={text(language, "Guides & Grid", "Направляющие и сетка")} description={text(language, "Snapping and visual guide defaults.", "Параметры привязки и отображения направляющих.")} />
            <ToggleRow title={text(language, "Show rulers", "Показывать линейки")} checked={store.preferences.showRulers} onChange={(showRulers) => store.updatePreferences({ showRulers })} />
            <ToggleRow title={text(language, "Show guides", "Показывать направляющие")} checked={store.preferences.showGuides} onChange={(showGuides) => store.updatePreferences({ showGuides })} />
            <ToggleRow title={text(language, "Snap to guides", "Привязка к направляющим")} checked={store.preferences.snapToGuides} onChange={(snapToGuides) => store.updatePreferences({ snapToGuides })} />
            <ToggleRow title={text(language, "Smart guides", "Быстрые направляющие")} checked={store.preferences.smartGuides} onChange={(smartGuides) => store.updatePreferences({ smartGuides })} />
            <SettingRow title={text(language, "Guide color", "Цвет направляющих")}><input type="color" value={store.preferences.guideColor} onChange={(event) => store.updatePreferences({ guideColor: event.target.value })} /></SettingRow>
          </>}
          {page === "shortcuts" && <ShortcutsPage language={language} />}
        </div>
      </div>
      <footer>{text(language, "Settings are saved in this browser.", "Настройки сохраняются в этом браузере.")}</footer>
    </section>
  </div>;
}

function SettingsHeading({ title, description }: { title: string; description: string }) { return <div className="settings-heading"><h3>{title}</h3><p>{description}</p></div>; }
function SettingRow({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) { return <label className="setting-row"><span><strong>{title}</strong>{description && <small>{description}</small>}</span>{children}</label>; }
function ToggleRow({ title, checked, onChange }: { title: string; checked: boolean; onChange(value: boolean): void }) { return <SettingRow title={title}><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /></SettingRow>; }
function ColorSetting({ label, value, onChange }: { label: string; value: string; onChange(value: string): void }) { return <label><span>{label}</span><input type="color" value={value} onChange={(event) => onChange(event.target.value)} /></label>; }
function NumberInput({ value, min, max, suffix, onChange }: { value: number; min: number; max: number; suffix?: string; onChange(value: number): void }) { return <span className="number-setting"><input type="number" value={value} min={min} max={max} onChange={(event) => onChange(Math.max(min, Math.min(max, event.target.valueAsNumber)))} />{suffix}</span>; }

/**
 * Every registered command, searchable and rebindable, grouped by category in
 * registration order. `kernel.commands.search` already matches on label/category/id, so
 * the search box here is exactly that. `kernel.keymap.subscribe` keeps the list live
 * across rebinds from elsewhere (a menu click, `resetCommandShortcut`, another tab of
 * this same dialog).
 */
function ShortcutsPage({ language }: { language: Language }) {
  const [query, setQuery] = useState("");
  const [capturingId, setCapturingId] = useState<string | null>(null);
  const [, bump] = useState(0);

  useEffect(() => {
    const subscription = kernel.keymap.subscribe(() => bump((value) => value + 1));
    return () => subscription.dispose();
  }, []);

  useEffect(() => {
    if (!capturingId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") { setCapturingId(null); return; }
      if (["Control", "Meta", "Alt", "Shift"].includes(event.key)) return;
      rebindCommandShortcut(capturingId, shortcutFromEvent(event));
      setCapturingId(null);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [capturingId]);

  const commands = kernel.commands.search(query);
  const categories: string[] = [];
  for (const command of commands) if (!categories.includes(command.category)) categories.push(command.category);

  return <>
    <SettingsHeading title={text(language, "Keyboard shortcuts", "Горячие клавиши")} description={text(language, "Every command, searchable and rebindable. Click a shortcut to change it, Escape to cancel.", "Каждая команда, с поиском и переназначением. Нажмите на сочетание, чтобы изменить его, Escape — отмена.")} />
    <input className="shortcuts-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={text(language, "Search commands…", "Поиск команд…")} />
    <div className="shortcut-groups">
      {categories.map((category) => <div className="shortcut-group" key={category}>
        <h4>{category}</h4>
        {commands.filter((command) => command.category === category).map((command) => {
          const binding = kernel.keymap.get(command.id);
          const overridden = isShortcutOverridden(command.id);
          const conflicts = binding ? kernel.keymap.conflicts(binding.shortcut, binding.scope).filter((entry) => entry.commandId !== command.id) : [];
          return <div className="shortcut-row" key={command.id}>
            <span>{command.label}</span>
            <div className="shortcut-row-controls">
              <button className={`shortcut-key${capturingId === command.id ? " capturing" : ""}`} onClick={() => setCapturingId(command.id)}>
                {capturingId === command.id ? text(language, "Press keys…", "Нажмите клавиши…") : binding ? <kbd>{binding.shortcut}</kbd> : <em>{text(language, "Unassigned", "Не назначено")}</em>}
              </button>
              {overridden && <button className="shortcut-reset" title={text(language, "Reset to default", "Сбросить по умолчанию")} onClick={() => resetCommandShortcut(command.id)}>↺</button>}
            </div>
            {conflicts.length > 0 && <small className="shortcut-conflict">{text(language, "Also used by", "Также используется в")}: {conflicts.map((entry) => kernel.commands.get(entry.commandId)?.label ?? entry.commandId).join(", ")}</small>}
          </div>;
        })}
      </div>)}
    </div>
  </>;
}
