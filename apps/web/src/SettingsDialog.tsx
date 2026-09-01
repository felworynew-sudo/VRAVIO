import { useMemo, useState } from "react";
import { text } from "./i18n";
import { useShellStore, type Language, type RendererPreference, type Theme } from "./store";

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
          {page === "shortcuts" && <>
            <SettingsHeading title={text(language, "Keyboard shortcuts", "Горячие клавиши")} description={text(language, "The keymap registry will make every binding editable without hard-coding tools.", "Реестр клавиш позволит изменять каждое сочетание без жёсткой привязки к инструментам.")} />
            <div className="shortcut-list">{[["Command palette", "Ctrl K"], ["Undo / Redo", "Ctrl Z / Ctrl Shift Z"], ["Save", "Ctrl S"], ["Close document", "Ctrl W"], ["Select all / Deselect", "Ctrl A / Ctrl Shift A"], ["Invert selection", "Ctrl Shift I"]].map(([label, key]) => <div key={label}><span>{label}</span><kbd>{key}</kbd></div>)}</div>
          </>}
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
