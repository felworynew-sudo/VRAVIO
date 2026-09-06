/**
 * Docs/vector-plan.md section 8's "Плашечные цвета и палитры документа" —
 * a document-level swatch list, separate from `ColorPickerDialog.tsx`'s own
 * `localStorage`-backed recent-colours list (per-browser, not saved with
 * the document). Same hand-drawn inline `data:` icon convention `artboards.ts`
 * and `symbols.ts` already use rather than a file under `icons/`: a small
 * grid of colour swatches reads as "a palette" as a mask, regardless of theme.
 */
const icon = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="4" cy="4" r="2.5"/><circle cx="12" cy="4" r="2.5"/><circle cx="4" cy="12" r="2.5"/><circle cx="12" cy="12" r="2.5"/></svg>')}`;

export default { id: "palette", component: "palette", order: 42, title: { en: "Palette", ru: "Палитра" }, icon, defaultVisible: false } as const;
