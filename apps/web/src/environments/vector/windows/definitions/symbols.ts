/**
 * Stage 13 of docs/vector-plan.md. `icon` is a hand-drawn inline `data:`
 * SVG rather than a `/…svg` path — every existing panel icon is one of the
 * uncommitted, Illustrator-exported files under `icons/` (the project's
 * `publicDir`), which this session's own convention treats as off-limits to
 * add to or touch. Two overlapping squares — a solid "definition" behind a
 * fainter "instance" — reads the same as a mask regardless of theme, the
 * same way the file-based icons already do (`PanelTab` uses it purely as a
 * `--panel-mask`, never for its own colour).
 */
const icon = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect x="1" y="1" width="9" height="9" rx="1.5"/><rect x="6" y="6" width="9" height="9" rx="1.5" fill-opacity=".55"/></svg>')}`;

export default { id: "symbols", component: "symbols", order: 25, title: { en: "Symbols", ru: "Символы" }, icon, defaultVisible: false } as const;
