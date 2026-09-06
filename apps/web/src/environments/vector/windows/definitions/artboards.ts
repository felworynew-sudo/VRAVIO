/**
 * Stage 15 of docs/vector-plan.md. Same reasoning `symbols.ts` already
 * gives for a hand-drawn inline `data:` icon rather than a file under
 * `icons/`: a single page rectangle reads as "a page/board" as a mask,
 * regardless of theme.
 */
const icon = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect x="1.5" y="2" width="13" height="12" rx="1"/></svg>')}`;

export default { id: "artboards", component: "artboards", order: 22, title: { en: "Artboards", ru: "Монтажные области" }, icon, defaultVisible: false } as const;
