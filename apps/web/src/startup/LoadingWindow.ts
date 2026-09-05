import { resolveLabel } from "../i18n";
import type { StageOutcome } from "./run";
import { startupStages } from "./stages";
import type { Language } from "../store";

/**
 * The loading screen, written against the DOM rather than in React.
 *
 * It has to be on screen *before* React exists — the whole point is to cover
 * the time when the session, the asset store and the fonts are still being
 * read, which is before there is an application to render it. Mounting React
 * to show a spinner and then unmounting it to show the application would make
 * the loading screen part of the thing it is meant to be waiting for.
 *
 * Plain strings and `textContent`, never `innerHTML`: a stage's detail can
 * contain an error message from anywhere, and an error message is not markup.
 */
export function createLoadingWindow(root: HTMLElement, language: Language, theme: string) {
  root.textContent = "";

  // Wrapped in `.app` with the theme on it, because that is where the palette
  // lives: every `--surface`, `--border` and `--text` in `styles.css` is
  // declared on `.app`, not on `:root`. Without this the loading screen is
  // outside the theme entirely and every `var()` in its own rules resolves to
  // nothing — which is exactly how it first rendered: correct text, no card,
  // no border, no background.
  const themed = document.createElement("div");
  themed.className = "app";
  themed.dataset.theme = theme;

  const screen = document.createElement("div");
  screen.className = "startup";

  const title = document.createElement("strong");
  title.textContent = "VRAVIO";
  screen.appendChild(title);

  const list = document.createElement("div");
  list.className = "startup-stages";
  screen.appendChild(list);

  // Every stage is drawn from the start, greyed, so the screen says how much
  // is left rather than growing a line at a time and never saying when it ends.
  const rows = new Map<string, { row: HTMLElement; detail: HTMLElement }>();
  for (const stage of startupStages) {
    const row = document.createElement("div");
    row.className = "startup-stage";
    row.dataset.status = "pending";

    const name = document.createElement("span");
    name.textContent = resolveLabel(stage.label, language);
    const detail = document.createElement("small");

    row.append(name, detail);
    list.appendChild(row);
    rows.set(stage.id, { row, detail });
  }

  themed.appendChild(screen);
  root.appendChild(themed);

  return {
    update(outcomes: readonly StageOutcome[]): void {
      for (const outcome of outcomes) {
        const entry = rows.get(outcome.id);
        if (!entry) continue;
        entry.row.dataset.status = outcome.status;
        entry.detail.textContent = `${outcome.detail} · ${outcome.ms}ms`;
      }
      // Whichever stage is running now, so the screen never looks stalled.
      const next = startupStages.find((stage) => !outcomes.some((outcome) => outcome.id === stage.id));
      if (next) rows.get(next.id)!.row.dataset.status = "running";
    },
    dispose(): void { themed.remove(); },
  };
}
