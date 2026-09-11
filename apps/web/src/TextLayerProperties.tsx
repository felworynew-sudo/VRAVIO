import { useState, type ReactNode } from "react";
import { setLayerPixels, type RasterDocumentState, type RasterLayer, type RasterTextData } from "@vravio/env-raster";
import { kernel } from "./kernel";
import { mergeableEdit } from "./history-helpers";
import { identityTextTransform, multiplyTextTransform, renderTextLayerPixels, textBoundsTransform } from "./textRender";
import type { Language } from "./store";

/**
 * The Properties panel's Type Properties section — Photoshop's own Character/Paragraph panel
 * layout, rebuilt against `RasterTextData` (docs/master-plan.md's text-properties redesign).
 *
 * Every field here is real, not cosmetic: it reads a `RasterTextData` field the renderer
 * (`textRender.ts`) actually consumes, and writing it re-rasterises through the same
 * `renderTextLayerPixels` every other text commit path uses. Two families Photoshop's own panel
 * has are deliberately absent rather than faked, because nothing in a browser's Canvas 2D API can
 * back them honestly:
 *  - True OpenType feature toggles (discretionary ligatures, contextual alternates, stylistic
 *    sets, ordinals, fractions, figure style/position) — Canvas 2D's `font` has no
 *    `font-feature-settings` equivalent, and nothing here reads a font's GSUB table.
 *  - East Asian Kinsoku Shori/Mojikumi line-breaking rules — these are linguistic rule tables,
 *    not a rendering technique; there is no dictionary or rule data in this project to drive them.
 * `direction` (this section's own "Ближневосточные функции") is real — Canvas 2D's own
 * `context.direction` — and `kerning`/`smallCaps` are real too, via `fontKerning`/
 * `fontVariantCaps`, the same two real Canvas 2D context extensions `textRender.ts` sets.
 */

function updateText(documentId: string, layerId: string, patch: Partial<RasterTextData>, label: string): void {
  let before: RasterTextData | null = null;
  kernel.documents.update<RasterDocumentState>(documentId, (state) => {
    const current = state.layers.find((item) => item.id === layerId);
    if (!current?.text) return;
    before = current.text;
    current.text = { ...current.text, ...patch };
    setLayerPixels(current, renderTextLayerPixels(current.text, state.width, state.height), state.width, state.height);
  });
  if (!before) return;
  const beforeSnapshot = before as RasterTextData;
  const write = (value: RasterTextData) => kernel.documents.update<RasterDocumentState>(documentId, (state) => {
    const current = state.layers.find((item) => item.id === layerId);
    if (!current) return;
    current.text = value;
    setLayerPixels(current, renderTextLayerPixels(current.text, state.width, state.height), state.width, state.height);
  });
  const afterSnapshot: RasterTextData = { ...beforeSnapshot, ...patch };
  const history = kernel.historyByDocument.get(documentId);
  if (history) void history.record(mergeableEdit(label, () => write(beforeSnapshot), () => write(afterSnapshot)), true);
}

function Section({ title, defaultOpen = true, children }: { title: string; defaultOpen?: boolean; children: ReactNode }) {
  return <details className="text-props-section" open={defaultOpen}>
    <summary>{title}</summary>
    <div className="text-props-section-body">{children}</div>
  </details>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="text-props-field"><span>{label}</span>{children}</label>;
}

function IconToggle({ active, onClick, title, children }: { active: boolean; onClick: () => void; title: string; children: ReactNode }) {
  return <button type="button" className={`text-props-icon-toggle${active ? " active" : ""}`} onClick={onClick} title={title} aria-pressed={active}>{children}</button>;
}

// Compact, neutral line icons — drawn for this panel rather than traced from any donor's own
// icon set (docs/master-plan.md's redesign notes name the reason: no licensed copy of Photoshop's
// own glyphs to trace from, and recreating them pixel-for-pixel from a screenshot risks exactly
// the copy this project otherwise avoids). 16x16, stroke-based, matching the toolbar's own line
// weight by eye rather than a borrowed one.
const svg = (paths: ReactNode) => <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths}</svg>;
const IconAllCaps = () => svg(<><path d="M2 12 5 4l3 8M2.8 9.5h4.4"/><path d="M9.5 6.5c0-1 .9-1.5 1.8-1.5s1.7.6 1.7 1.5c0 1.8-3.5 1.6-3.5 3.5 0 1 .8 1.5 1.7 1.5s1.8-.5 1.8-1.5"/></>);
const IconSmallCaps = () => svg(<><path d="M2 12 4.5 5l2.5 7M2.6 9.8h3.8"/><path d="M9.5 8c0-.7.7-1.1 1.4-1.1s1.3.5 1.3 1.1c0 1.3-2.7 1.2-2.7 2.6 0 .7.6 1.1 1.3 1.1s1.4-.4 1.4-1.1"/></>);
const IconSuperscript = () => svg(<><path d="M2 12 4.7 9M2 9l2.7 3"/><path d="M9 5.2c0-.7.6-1 1.2-1s1.2.4 1.2 1c0 1.2-2.4 1.1-2.4 2.3 0 0 0 .1 2.4.1"/></>);
const IconSubscript = () => svg(<><path d="M2 9l2.7 3M2 12l2.7-3"/><path d="M9 12.8c0-.7.6-1 1.2-1s1.2.4 1.2 1c0 1.2-2.4 1.1-2.4 2.3 0 0 0 .1 2.4.1"/></>);
const IconStrikethrough = () => svg(<><path d="M2 8h12"/><path d="M5 5c0-1 1-1.8 2.6-1.8S10 4 10 5M6 11c0 1 1 1.8 2.6 1.8S11 12 11 11"/></>);
const IconBulletList = () => svg(<><circle cx="3" cy="4" r="1"/><circle cx="3" cy="8" r="1"/><circle cx="3" cy="12" r="1"/><path d="M6.5 4h7M6.5 8h7M6.5 12h7"/></>);
const IconNumberList = () => svg(<><path d="M2.2 3.5h1.3v3M2 6.5h1.8M2 12.5h2M2 10.7c0-.7.6-1.1 1.2-1.1s1.1.4 1.1 1c0 .8-2.3 1-2.3 2.4"/><path d="M6.5 4h7M6.5 8h7M6.5 12h7"/></>);
const IconDynamicNone = () => svg(<path d="M2 4h12M2 8h12M2 12h8"/>);
const IconDynamicCircle = () => svg(<circle cx="8" cy="8" r="5.5"/>);
const IconDynamicArch = () => svg(<path d="M2.5 11a6 6 0 0 1 11 0"/>);
const IconDynamicBow = () => svg(<path d="M2.5 5a6 6 0 0 1 11 0"/>);
const IconFlipH = () => svg(<><path d="M8 2v12"/><path d="M4 5 2 8l2 3M12 5l2 3-2 3"/></>);
const IconFlipV = () => svg(<><path d="M2 8h12"/><path d="M5 4 8 2l3 2M5 12l3 2 3-2"/></>);
const IconLock = () => svg(<><rect x="4" y="7.2" width="8" height="6" rx="1"/><path d="M5.5 7.2V5a2.5 2.5 0 0 1 5 0v2.2"/></>);
const IconUnlock = () => svg(<><rect x="4" y="7.2" width="8" height="6" rx="1"/><path d="M5.5 7.2V5a2.5 2.5 0 0 1 4.6-1.4"/></>);
const IconAlign = (kind: "left" | "center" | "right" | "justify") => svg(
  kind === "left" ? <><path d="M2 4h12M2 8h8M2 12h10"/></> :
  kind === "center" ? <><path d="M2 4h12M4 8h8M3 12h10"/></> :
  kind === "right" ? <><path d="M2 4h12M6 8h8M4 12h10"/></> :
  <><path d="M2 4h12M2 8h12M2 12h12"/></>,
);
const IconDirection = (rtl: boolean) => svg(rtl ? <><path d="M13 4H5M5 4l2.5-2M5 4l2.5 2"/><path d="M2 8h12M2 12h12"/></> : <><path d="M3 4h8M11 4l-2.5-2M11 4l-2.5 2"/><path d="M2 8h12M2 12h12"/></>);

const kindLabel = (language: Language): string => language === "ru" ? "Текстовый слой" : "Text layer";
const t = (language: Language, en: string, ru: string) => language === "ru" ? ru : en;

export function TextLayerProperties({ documentId, document, layer, language }: { documentId: string; document: RasterDocumentState; layer: RasterLayer; language: Language }) {
  const text = layer.text;
  const [linkAspect, setLinkAspect] = useState(false);
  if (!text) return null;
  const update = (patch: Partial<RasterTextData>, label: string) => updateText(documentId, layer.id, patch, label);
  const bounds = text.visualBounds && text.visualBounds.width > 0 ? text.visualBounds : { x: text.x, y: text.y, width: 1, height: text.fontSize };

  const applyResize = (nextWidth: number, nextHeight: number) => {
    const width = Math.max(1, nextWidth), height = Math.max(1, nextHeight);
    const transform = multiplyTextTransform(
      textBoundsTransform(bounds, { x: bounds.x, y: bounds.y, width, height }, 0),
      text.transform ?? identityTextTransform(),
    );
    update({ transform }, t(language, "Type Size (Размер текста)", "Размер текста"));
  };
  const applyMove = (nextX: number, nextY: number) => {
    const transform = multiplyTextTransform(
      textBoundsTransform(bounds, { ...bounds, x: nextX, y: nextY }, 0),
      text.transform ?? identityTextTransform(),
    );
    update({ transform }, t(language, "Type Position (Положение текста)", "Положение текста"));
  };
  const flip = (axis: "x" | "y") => {
    const centerX = bounds.x + bounds.width / 2, centerY = bounds.y + bounds.height / 2;
    const mirror = axis === "x"
      ? { a: -1, b: 0, c: 0, d: 1, e: 2 * centerX, f: 0 }
      : { a: 1, b: 0, c: 0, d: -1, e: 0, f: 2 * centerY };
    update({ transform: multiplyTextTransform(mirror, text.transform ?? identityTextTransform()) }, t(language, "Flip Type (Отразить текст)", "Отразить текст"));
  };

  return <div className="dock-panel-body property-stack text-properties">
    <header className="text-props-header"><span className="text-props-header-icon">T</span><strong>{kindLabel(language)}</strong></header>

    <Section title={t(language, "Perspective", "Перспектива")}>
      <div className="text-props-perspective">
        <button type="button" className={`text-props-icon-toggle${linkAspect ? " active" : ""}`} title={t(language, "Link width and height", "Связать ширину и высоту")} onClick={() => setLinkAspect((value) => !value)}>{linkAspect ? <IconLock/> : <IconUnlock/>}</button>
        <Field label="Ш"><input type="number" min={1} value={Math.round(bounds.width)} onChange={(event) => {
          const width = event.target.valueAsNumber; if (!Number.isFinite(width)) return;
          applyResize(width, linkAspect ? bounds.height * (width / Math.max(1, bounds.width)) : bounds.height);
        }}/></Field>
        <Field label="X"><input type="number" value={Math.round(bounds.x)} onChange={(event) => Number.isFinite(event.target.valueAsNumber) && applyMove(event.target.valueAsNumber, bounds.y)}/></Field>
        <Field label="В"><input type="number" min={1} value={Math.round(bounds.height)} onChange={(event) => {
          const height = event.target.valueAsNumber; if (!Number.isFinite(height)) return;
          applyResize(linkAspect ? bounds.width * (height / Math.max(1, bounds.height)) : bounds.width, height);
        }}/></Field>
        <Field label="Y"><input type="number" value={Math.round(bounds.y)} onChange={(event) => Number.isFinite(event.target.valueAsNumber) && applyMove(bounds.x, event.target.valueAsNumber)}/></Field>
        <div className="text-props-flip-row">
          <IconToggle active={false} onClick={() => flip("x")} title={t(language, "Flip horizontal", "Отразить по горизонтали")}><IconFlipH/></IconToggle>
          <IconToggle active={false} onClick={() => flip("y")} title={t(language, "Flip vertical", "Отразить по вертикали")}><IconFlipV/></IconToggle>
        </div>
      </div>
    </Section>

    <Section title={t(language, "Character", "Символ")}>
      <Field label={t(language, "Font", "Шрифт")}><input value={text.fontFamily} onChange={(event) => update({ fontFamily: event.target.value }, t(language, "Font", "Шрифт"))}/></Field>
      <div className="text-props-row">
        <div className="text-style-toggles">
          <button className={text.bold ? "active" : ""} onClick={() => update({ bold: !text.bold }, t(language, "Bold", "Полужирный"))} title={t(language, "Bold", "Полужирный")}><b>B</b></button>
          <button className={text.italic ? "active" : ""} onClick={() => update({ italic: !text.italic }, t(language, "Italic", "Курсив"))} title={t(language, "Italic", "Курсив")}><i>I</i></button>
        </div>
      </div>
      <div className="text-props-row">
        <Field label={t(language, "Size", "Кегль")}><input type="number" min={1} max={1000} value={text.fontSize} onChange={(event) => Number.isFinite(event.target.valueAsNumber) && update({ fontSize: Math.max(1, event.target.valueAsNumber) }, t(language, "Size", "Кегль"))}/></Field>
        <Field label={t(language, "Leading", "Интерлиньяж")}><input type="number" min={0.5} max={5} step={0.05} value={text.lineHeight} onChange={(event) => Number.isFinite(event.target.valueAsNumber) && update({ lineHeight: event.target.valueAsNumber }, t(language, "Leading", "Интерлиньяж"))}/></Field>
      </div>
      <div className="text-props-row">
        <Field label={t(language, "Kerning", "Кернинг")}>
          <select value={text.kerning ?? "auto"} onChange={(event) => update({ kerning: event.target.value as "auto" | "normal" | "none" }, t(language, "Kerning", "Кернинг"))}>
            <option value="auto">{t(language, "Auto", "Авто")}</option>
            <option value="normal">{t(language, "Metric", "Метрический")}</option>
            <option value="none">{t(language, "None", "Нет")}</option>
          </select>
        </Field>
        <Field label={t(language, "Tracking", "Трекинг")}><input type="number" min={-50} max={200} value={text.letterSpacing} onChange={(event) => Number.isFinite(event.target.valueAsNumber) && update({ letterSpacing: event.target.valueAsNumber }, t(language, "Tracking", "Трекинг"))}/></Field>
      </div>
      <div className="text-props-row">
        <Field label={t(language, "Vert. scale", "Масштаб В")}><input type="number" min={10} max={500} value={text.verticalScale ?? 100} onChange={(event) => Number.isFinite(event.target.valueAsNumber) && update({ verticalScale: event.target.valueAsNumber }, t(language, "Vertical Scale", "Масштаб по вертикали"))}/></Field>
        <Field label={t(language, "Horiz. scale", "Масштаб Г")}><input type="number" min={10} max={500} value={text.horizontalScale ?? 100} onChange={(event) => Number.isFinite(event.target.valueAsNumber) && update({ horizontalScale: event.target.valueAsNumber }, t(language, "Horizontal Scale", "Масштаб по горизонтали"))}/></Field>
      </div>
      <div className="text-props-row">
        <Field label={t(language, "Baseline shift", "Смещ. базовой линии")}><input type="number" value={text.baselineShift ?? 0} onChange={(event) => Number.isFinite(event.target.valueAsNumber) && update({ baselineShift: event.target.valueAsNumber }, t(language, "Baseline Shift", "Смещение базовой линии"))}/></Field>
        <Field label={t(language, "Color", "Цвет")}><input type="color" value={text.color} onChange={(event) => update({ color: event.target.value }, t(language, "Color", "Цвет"))}/></Field>
      </div>
    </Section>

    <Section title={t(language, "Text tool options", "Параметры инструмента «Текст»")}>
      <div className="text-props-icon-grid">
        <IconToggle active={Boolean(text.allCaps)} onClick={() => update({ allCaps: !text.allCaps }, t(language, "All Caps", "Все прописные"))} title={t(language, "All caps", "Все прописные")}><IconAllCaps/></IconToggle>
        <IconToggle active={Boolean(text.smallCaps)} onClick={() => update({ smallCaps: !text.smallCaps }, t(language, "Small Caps", "Капитель"))} title={t(language, "Small caps", "Капитель")}><IconSmallCaps/></IconToggle>
        <IconToggle active={Boolean(text.superscript)} onClick={() => update({ superscript: !text.superscript, subscript: false }, t(language, "Superscript", "Надстрочные"))} title={t(language, "Superscript", "Надстрочные")}><IconSuperscript/></IconToggle>
        <IconToggle active={Boolean(text.subscript)} onClick={() => update({ subscript: !text.subscript, superscript: false }, t(language, "Subscript", "Подстрочные"))} title={t(language, "Subscript", "Подстрочные")}><IconSubscript/></IconToggle>
        <IconToggle active={Boolean(text.underline)} onClick={() => update({ underline: !text.underline }, t(language, "Underline", "Подчёркивание"))} title={t(language, "Underline", "Подчёркивание")}><u>U</u></IconToggle>
        <IconToggle active={Boolean(text.strikethrough)} onClick={() => update({ strikethrough: !text.strikethrough }, t(language, "Strikethrough", "Зачёркивание"))} title={t(language, "Strikethrough", "Зачёркивание")}><IconStrikethrough/></IconToggle>
      </div>
    </Section>

    <Section title={t(language, "Paragraph", "Абзац")}>
      <div className="text-props-icon-grid">
        <IconToggle active={(text.justify ?? "none") === "none" && text.align === "left"} onClick={() => update({ align: "left", justify: "none" }, t(language, "Align Left", "Выровнять по левому краю"))} title={t(language, "Align left", "По левому краю")}>{IconAlign("left")}</IconToggle>
        <IconToggle active={(text.justify ?? "none") === "none" && text.align === "center"} onClick={() => update({ align: "center", justify: "none" }, t(language, "Align Center", "Выровнять по центру"))} title={t(language, "Align center", "По центру")}>{IconAlign("center")}</IconToggle>
        <IconToggle active={(text.justify ?? "none") === "none" && text.align === "right"} onClick={() => update({ align: "right", justify: "none" }, t(language, "Align Right", "Выровнять по правому краю"))} title={t(language, "Align right", "По правому краю")}>{IconAlign("right")}</IconToggle>
        <IconToggle active={text.justify === "left"} onClick={() => update({ justify: "left" }, t(language, "Justify Last Left", "Выключка последней строки влево"))} title={t(language, "Justify, last line left", "Выключка, последняя строка влево")}>{IconAlign("justify")}</IconToggle>
        <IconToggle active={text.justify === "center"} onClick={() => update({ justify: "center" }, t(language, "Justify Last Center", "Выключка последней строки по центру"))} title={t(language, "Justify, last line center", "Выключка, последняя строка по центру")}>{IconAlign("justify")}</IconToggle>
        <IconToggle active={text.justify === "right"} onClick={() => update({ justify: "right" }, t(language, "Justify Last Right", "Выключка последней строки вправо"))} title={t(language, "Justify, last line right", "Выключка, последняя строка вправо")}>{IconAlign("justify")}</IconToggle>
        <IconToggle active={text.justify === "full"} onClick={() => update({ justify: "full" }, t(language, "Justify All", "Полное выравнивание"))} title={t(language, "Justify all lines", "Полное выравнивание")}>{IconAlign("justify")}</IconToggle>
      </div>
      <div className="text-props-row">
        <Field label={t(language, "Indent before", "Отступ слева")}><input type="number" min={0} value={text.indentBefore ?? 0} onChange={(event) => Number.isFinite(event.target.valueAsNumber) && update({ indentBefore: Math.max(0, event.target.valueAsNumber) }, t(language, "Indent Before", "Отступ слева"))}/></Field>
        <Field label={t(language, "Indent after", "Отступ справа")}><input type="number" min={0} value={text.indentAfter ?? 0} onChange={(event) => Number.isFinite(event.target.valueAsNumber) && update({ indentAfter: Math.max(0, event.target.valueAsNumber) }, t(language, "Indent After", "Отступ справа"))}/></Field>
      </div>
      <div className="text-props-row">
        <Field label={t(language, "First line", "Первая строка")}><input type="number" value={text.firstLineIndent ?? 0} onChange={(event) => Number.isFinite(event.target.valueAsNumber) && update({ firstLineIndent: event.target.valueAsNumber }, t(language, "First Line Indent", "Отступ первой строки"))}/></Field>
        <Field label={t(language, "Space before", "Интервал до")}><input type="number" min={0} value={text.spaceBefore ?? 0} onChange={(event) => Number.isFinite(event.target.valueAsNumber) && update({ spaceBefore: Math.max(0, event.target.valueAsNumber) }, t(language, "Space Before Paragraph", "Интервал перед абзацем"))}/></Field>
      </div>
      <div className="text-props-row">
        <Field label={t(language, "Space after", "Интервал после")}><input type="number" min={0} value={text.spaceAfter ?? 0} onChange={(event) => Number.isFinite(event.target.valueAsNumber) && update({ spaceAfter: Math.max(0, event.target.valueAsNumber) }, t(language, "Space After Paragraph", "Интервал после абзаца"))}/></Field>
      </div>
      <label className="export-check"><input type="checkbox" checked={Boolean(text.hyphenate)} onChange={(event) => update({ hyphenate: event.target.checked }, t(language, "Hyphenation", "Переносы"))}/>{t(language, "Hyphenation", "Переносы")}</label>
    </Section>

    <Section title={t(language, "Dynamic text", "Динамический текст")} defaultOpen={false}>
      <div className="text-props-icon-grid">
        <IconToggle active={text.mode !== "dynamic"} onClick={() => update({ mode: text.boxWidth ? "area" : "point" }, t(language, "Text Shape", "Форма текста"))} title={t(language, "Block", "Блок")}><IconDynamicNone/></IconToggle>
        <IconToggle active={text.mode === "dynamic" && text.dynamicPreset === "circle"} onClick={() => update({ mode: "dynamic", dynamicPreset: "circle" }, t(language, "Text Shape", "Форма текста"))} title={t(language, "Circle", "Круг")}><IconDynamicCircle/></IconToggle>
        <IconToggle active={text.mode === "dynamic" && text.dynamicPreset === "arch"} onClick={() => update({ mode: "dynamic", dynamicPreset: "arch" }, t(language, "Text Shape", "Форма текста"))} title={t(language, "Arch up", "Дуга вверх")}><IconDynamicArch/></IconToggle>
        <IconToggle active={text.mode === "dynamic" && text.dynamicPreset === "bow"} onClick={() => update({ mode: "dynamic", dynamicPreset: "bow" }, t(language, "Text Shape", "Форма текста"))} title={t(language, "Arch down", "Дуга вниз")}><IconDynamicBow/></IconToggle>
      </div>
      {text.path && <label className="export-check"><input type="checkbox" checked={text.path.flip ?? false} onChange={(event) => update({ path: { ...text.path!, flip: event.target.checked } }, t(language, "Flip Path", "Перевернуть контур"))}/>{t(language, "Flip path", "Перевернуть контур")}</label>}
    </Section>

    <Section title={t(language, "Bulleted and numbered", "Маркированные и нумерованные")} defaultOpen={false}>
      <div className="text-props-icon-grid">
        <IconToggle active={text.listType === "bullet"} onClick={() => update({ listType: text.listType === "bullet" ? "none" : "bullet" }, t(language, "Bulleted List", "Маркированный список"))} title={t(language, "Bulleted list", "Маркированный список")}><IconBulletList/></IconToggle>
        <IconToggle active={text.listType === "number"} onClick={() => update({ listType: text.listType === "number" ? "none" : "number" }, t(language, "Numbered List", "Нумерованный список"))} title={t(language, "Numbered list", "Нумерованный список")}><IconNumberList/></IconToggle>
      </div>
    </Section>

    <Section title={t(language, "Middle Eastern", "Ближневосточные функции")} defaultOpen={false}>
      <div className="text-props-icon-grid">
        <IconToggle active={(text.direction ?? "ltr") === "ltr"} onClick={() => update({ direction: "ltr" }, t(language, "Paragraph Direction", "Направление абзаца"))} title={t(language, "Left to right", "Слева направо")}>{IconDirection(false)}</IconToggle>
        <IconToggle active={text.direction === "rtl"} onClick={() => update({ direction: "rtl" }, t(language, "Paragraph Direction", "Направление абзаца"))} title={t(language, "Right to left", "Справа налево")}>{IconDirection(true)}</IconToggle>
      </div>
    </Section>
  </div>;
}
