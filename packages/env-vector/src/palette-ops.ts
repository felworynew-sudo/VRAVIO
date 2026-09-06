import type { Color } from "@vravio/kernel";
import type { PaletteColor, VectorDocumentState } from "./types";

/**
 * Document-level colour swatches — docs/vector-plan.md section 8's
 * "Плашечные цвета и палитры документа" (a stage 6 addition), see
 * `PaletteColor`'s own doc comment in `types.ts` for what this is and
 * isn't (not `ColorPickerDialog.tsx`'s `localStorage`-backed recent-colour
 * list, which is per-browser, not part of the document).
 */

let counter = 0;
function nextPaletteId(): string {
  counter += 1;
  return `palette-${counter}`;
}

/** Raises the palette id counter past whatever a just-restored document
 * already contains — the same id-collision problem `document.ts`'s own
 * `reseedShapeIdCounters` fixes for shapes/artboards, fixed here the same
 * way rather than left to reappear a third time under a different name. */
export function reseedPaletteIdCounter(state: VectorDocumentState): void {
  let max = 0;
  for (const entry of state.palette) {
    const match = /-(\d+)$/.exec(entry.id);
    if (!match) continue;
    const value = Number(match[1]);
    if (value > max) max = value;
  }
  counter = Math.max(counter, max);
}

/** Adds a new swatch, named plainly ("Color 1", "Color 2", ...) unless the
 * caller supplies a real name — a document can accumulate palette entries
 * quietly (e.g. one added per fill colour a user picks), and forcing a
 * name prompt on every one would be exactly the kind of friction a palette
 * is supposed to remove. */
export function addPaletteColor(document: VectorDocumentState, color: Color, name?: string): PaletteColor {
  const entry: PaletteColor = { id: nextPaletteId(), name: name ?? `Color (Цвет) ${document.palette.length + 1}`, color };
  document.palette = [...document.palette, entry];
  return entry;
}

export function removePaletteColor(document: VectorDocumentState, id: string): void {
  document.palette = document.palette.filter((entry) => entry.id !== id);
}

export function renamePaletteColor(document: VectorDocumentState, id: string, name: string): void {
  document.palette = document.palette.map((entry) => entry.id === id ? { ...entry, name } : entry);
}

export function updatePaletteColor(document: VectorDocumentState, id: string, color: Color): void {
  document.palette = document.palette.map((entry) => entry.id === id ? { ...entry, color } : entry);
}
