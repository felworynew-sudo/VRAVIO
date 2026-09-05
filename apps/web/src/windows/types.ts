import type { Language } from "../store";

/**
 * A dockable panel, as its catalogue file declares it.
 *
 * Section 4.2 of docs/migration-plan.md: the shape already existed twice —
 * `raster-core-panels/types.ts` and `vector-core-panels/types.ts` were the
 * same interface, the same registry and the same runtime, copied, so a fix to
 * one silently left the other behind. One definition now, with the
 * environment coming from where the file sits rather than from which copy of
 * the code read it.
 */
export interface WindowDefinition {
  readonly id: string;
  readonly order: number;
  readonly title: { readonly en: string; readonly ru: string };
  readonly icon: string;
  readonly defaultVisible: boolean;
  /** Which component the dock renders for this panel. */
  readonly component: string;
  /**
   * Modal windows this panel can open, by id (stage 7's `modals/`). Declared
   * so a panel names what it opens instead of importing it; unread until the
   * modal registry exists, and empty everywhere until then.
   */
  readonly modals?: readonly string[];
  /** Commands offered by a right-click inside this panel, by id. */
  readonly contextMenu?: readonly string[];
}

export type WindowModule = { default: WindowDefinition };

export const windowTitle = (window: WindowDefinition, language: Language): string =>
  language === "ru" ? window.title.ru : window.title.en;
