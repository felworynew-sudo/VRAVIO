import type { ComponentType } from "react";

/**
 * A modal window, as its catalogue file declares it.
 *
 * Stage 7 of docs/migration-plan.md: "модальное окно вызывается по id —
 * ссылка, а не импорт". The point is not the registry for its own sake — it is
 * that the place which *decides* to ask something is usually not the place that
 * knows how to draw the asking. A tool deep inside the raster workspace should
 * be able to ask for a confirmation without importing a dialog component and
 * without the workspace growing another `useState` boolean and another branch
 * of JSX for it, which is how `App.tsx` came to hold eleven of them.
 */
export interface ModalDefinition<TProps = never> {
  readonly id: string;
  /**
   * Rendered while the modal is open. `close` dismisses it; a modal that
   * resolves to a value calls the callback its props carry and then `close`.
   */
  readonly component: ComponentType<TProps & { readonly close: () => void }>;
}

export type ModalModule = { default: ModalDefinition<never> };
