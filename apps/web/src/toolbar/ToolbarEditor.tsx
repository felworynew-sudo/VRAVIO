import { useState } from "react";
import type { EnvironmentKind } from "@vravio/kernel";
import { text } from "../i18n";
import { resolveLabel } from "../i18n";
import { toolById } from "../tools";
import { useShellStore } from "../store";
import { defaultLayout, hasCustomToolbarLayout, persistToolbarLayout, readToolbarLayout, resetToolbarLayout, type ToolbarLayout } from "./layout";

/**
 * Photoshop's "Edit Toolbar…", reached by the `(…)` button at the foot of the
 * palette.
 *
 * Two columns: the palette as it will look, and the tools kept out of it.
 * Dragging a tool onto another tool groups them — that is what a group *is*
 * here, tools sharing one slot — and dragging it between two groups gives it a
 * slot of its own. Dragging into the right column hides it.
 *
 * Pointer events rather than HTML5 drag-and-drop, matching the layer panel's
 * own row dragging: the native API cannot show a drop indicator that follows
 * the pointer without a drag image fighting it, and this palette needs to show
 * the difference between "into this group" and "between these groups".
 */

/** Where a drop would land: into a group, between two groups, or hidden. */
type DropTarget = { kind: "into"; group: number } | { kind: "between"; index: number } | { kind: "hidden" } | null;

const withoutTool = (layout: ToolbarLayout, id: string): ToolbarLayout => ({
  groups: layout.groups.map((group) => group.filter((tool) => tool !== id)).filter((group) => group.length > 0),
  hidden: layout.hidden.filter((tool) => tool !== id),
});

/** Applies a drop, given the tool being moved and where it landed. */
export function applyDrop(layout: ToolbarLayout, id: string, target: DropTarget): ToolbarLayout {
  if (!target) return layout;
  if (target.kind === "hidden") {
    const without = withoutTool(layout, id);
    return { groups: without.groups, hidden: [...without.hidden, id] };
  }

  if (target.kind === "into") {
    // The destination is identified by a tool already in it, not by its index:
    // taking the dragged tool out can empty an earlier group and shift every
    // index after it, so an index captured before the move points somewhere
    // else after it.
    const marker = layout.groups[target.group]?.find((tool) => tool !== id);
    // Nothing to join — the slot held only the tool being dragged.
    if (marker === undefined) return layout;
    const without = withoutTool(layout, id);
    return { groups: without.groups.map((group) => (group.includes(marker) ? [...group, id] : group)), hidden: without.hidden };
  }

  // Same shift, stated for a gap rather than a slot: the gap the user aimed at
  // moves up by one only if the group that collapsed was above it. Shifting
  // whenever *any* group collapsed sent a tool dragged upward one slot too far.
  const from = layout.groups.findIndex((group) => group.includes(id));
  const collapses = from >= 0 && layout.groups[from]!.length === 1;
  const without = withoutTool(layout, id);
  const at = Math.max(0, Math.min(target.index - (collapses && from < target.index ? 1 : 0), without.groups.length));
  return { groups: [...without.groups.slice(0, at), [id], ...without.groups.slice(at)], hidden: without.hidden };
}

export function ToolbarEditor({ kind, close }: { kind: EnvironmentKind; close: () => void }) {
  const language = useShellStore((state) => state.language);
  const [layout, setLayout] = useState<ToolbarLayout>(() => readToolbarLayout(kind));
  const [dragging, setDragging] = useState<string | null>(null);
  const [target, setTarget] = useState<DropTarget>(null);

  const name = (id: string) => {
    const tool = toolById(id);
    return tool ? resolveLabel(tool.label, language) : id;
  };

  const drop = () => {
    if (dragging) setLayout((current) => applyDrop(current, dragging, target));
    setDragging(null);
    setTarget(null);
  };

  const save = () => { persistToolbarLayout(kind, layout); close(); };
  const reset = () => { resetToolbarLayout(kind); setLayout(defaultLayout(kind)); };

  // Deliberately no `setPointerCapture`: capturing routes every later pointer
  // event to the button being dragged, so the drop zones' `onPointerEnter`
  // would never fire and the drag would have nowhere to land. Release is caught
  // on the dialog and on the backdrop instead, which between them cover
  // everywhere the pointer can be when the button comes up.
  const slot = (id: string) => <button
    key={id}
    className={`toolbar-editor-tool${dragging === id ? " dragging" : ""}`}
    onPointerDown={() => setDragging(id)}
    onPointerCancel={() => { setDragging(null); setTarget(null); }}
  >
    <span aria-hidden="true">⠿</span>{name(id)}<kbd>{toolById(id)?.shortcut}</kbd>
  </button>;

  return <div className="dialog-backdrop" onMouseDown={close} onPointerUp={drop}>
    <section className="toolbar-editor" role="dialog" aria-modal="true" aria-label={text(language, "Customise toolbar", "Настроить панель инструментов")} onMouseDown={(event) => event.stopPropagation()} onPointerUp={drop}>
      <header>
        <h2>{text(language, "Customise Toolbar", "Настроить панель инструментов")}</h2>
        <button onClick={close} aria-label={text(language, "Close", "Закрыть")}>×</button>
      </header>
      <p className="toolbar-editor-hint">{text(
        language,
        "Drag a tool onto another to share one slot with it, between slots to give it its own, or into Extra tools to keep it out of the palette.",
        "Перетащите инструмент на другой, чтобы они делили одну ячейку, между ячейками — чтобы дать ему свою, или в «Скрытые», чтобы убрать его с панели.",
      )}</p>

      <div className="toolbar-editor-columns">
        <div className="toolbar-editor-column">
          <h3>{text(language, "Toolbar", "Панель")}</h3>
          <div className="toolbar-editor-list">
            {layout.groups.map((group, index) => <div key={group.join("|")}>
              <div
                className={`toolbar-editor-gap${target?.kind === "between" && target.index === index ? " active" : ""}`}
                onPointerEnter={() => dragging && setTarget({ kind: "between", index })}
              />
              <div
                className={`toolbar-editor-group${target?.kind === "into" && target.group === index ? " active" : ""}`}
                onPointerEnter={() => dragging && setTarget({ kind: "into", group: index })}
              >
                {group.map(slot)}
              </div>
            </div>)}
            <div
              className={`toolbar-editor-gap${target?.kind === "between" && target.index === layout.groups.length ? " active" : ""}`}
              onPointerEnter={() => dragging && setTarget({ kind: "between", index: layout.groups.length })}
            />
          </div>
        </div>

        <div className="toolbar-editor-column">
          <h3>{text(language, "Extra tools", "Скрытые")}</h3>
          <div
            className={`toolbar-editor-list toolbar-editor-hidden${target?.kind === "hidden" ? " active" : ""}`}
            onPointerEnter={() => dragging && setTarget({ kind: "hidden" })}
          >
            {layout.hidden.length ? layout.hidden.map(slot) : <p className="toolbar-editor-empty">{text(language, "Every tool is in the palette.", "Все инструменты на панели.")}</p>}
          </div>
        </div>
      </div>

      <footer>
        <button onClick={reset} disabled={!hasCustomToolbarLayout(kind)}>{text(language, "Reset to default", "Сбросить по умолчанию")}</button>
        <span className="toolbar-editor-spacer" />
        <button onClick={close}>{text(language, "Cancel", "Отмена")}</button>
        <button className="primary" onClick={save}>{text(language, "Done", "Готово")}</button>
      </footer>
    </section>
  </div>;
}
