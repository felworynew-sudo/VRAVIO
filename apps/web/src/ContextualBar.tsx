import { isRasterDocumentState } from "@vravio/env-raster";
import { isVectorDocumentState } from "@vravio/env-vector";
import { kernel } from "./kernel";
import { text } from "./i18n";
import type { Language } from "./store";
import { groupActiveVectorShapes, ungroupActiveVectorGroup } from "./vector-commands";

/**
 * Adobe's own "Contextual Task Bar" (master-plan §11) is a large, mostly AI-driven spec —
 * Generative Fill, Remove Background, prompt-to-edit — none of which VRAVIO has a backend for
 * yet. Building the whole thing here would be inventing UI for features that don't exist (see
 * CLAUDE.md section 3). This is the honest first slice: a floating bar that surfaces the
 * next-most-likely action for the states VRAVIO can already act on — a raster pixel selection,
 * or a multi-shape vector selection — using the exact same commands the menu and side panels
 * already call, not a parallel implementation of them. Raster and vector show different
 * content because their next-likely-actions genuinely differ, same as the rest of the app.
 */
export function ContextualBar({ documentId, state, language, visible }: {
  documentId: string;
  state: unknown;
  language: Language;
  visible: boolean;
}) {
  if (!visible) return null;

  if (isRasterDocumentState(state) && state.selection) {
    return <div className="contextual-bar" role="toolbar" aria-label={text(language, "Contextual actions", "Контекстные действия")}>
      <span>{text(language, "Selection", "Выделение")}</span>
      <button onClick={() => void kernel.commands.execute("select.invert", { activeDocumentId: documentId })}>{text(language, "Invert", "Инвертировать")}</button>
      <button onClick={() => void kernel.commands.execute("select.feather", { activeDocumentId: documentId })}>{text(language, "Feather…", "Растушевать…")}</button>
      <button onClick={() => void kernel.commands.execute("select.none", { activeDocumentId: documentId })}>{text(language, "Deselect", "Снять выделение")}</button>
    </div>;
  }

  if (isVectorDocumentState(state)) {
    const activeShape = state.shapes.find((shape) => shape.id === state.activeShapeId);
    const canGroup = state.selection.length >= 2;
    const canUngroup = activeShape?.kind === "group";
    if (!canGroup && !canUngroup) return null;
    return <div className="contextual-bar" role="toolbar" aria-label={text(language, "Contextual actions", "Контекстные действия")}>
      <span>{text(language, "Selection", "Выделение")}</span>
      {canGroup && <button onClick={() => groupActiveVectorShapes(documentId)}>{text(language, "Group", "Сгруппировать")}</button>}
      {canUngroup && <button onClick={() => ungroupActiveVectorGroup(documentId)}>{text(language, "Ungroup", "Разгруппировать")}</button>}
    </div>;
  }

  return null;
}
