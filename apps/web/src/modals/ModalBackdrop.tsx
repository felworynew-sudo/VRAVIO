import { useEffect, useState, useSyncExternalStore, type HTMLAttributes } from "react";
import { createPortal } from "react-dom";

/**
 * Above every piece of app chrome — Dockview's floating groups (999, and 9999 for its drag
 * overlay), the main menu (1000), the contextual bar, performance overlay and panel menus.
 * A window waiting for the user must never be underneath something else.
 */
const MODAL_BASE_Z = 10_000;

/** Monotonic, so a modal opened later always stacks above one opened earlier. */
let openOrder = 0;

/**
 * How many modal dialogs are mounted right now — the one answer to "is the user inside a dialog?".
 *
 * Asked by everything that must stand down while one is: the app's global shortcuts (a tool switch
 * or an undo must not fire underneath an open filter), and chrome such as the contextual bar that
 * has no business on top of Camera Raw or Liquify. Counted at mount rather than read off the DOM so
 * the answer is exact and subscribable.
 */
let presentModals = 0;
const presenceListeners = new Set<() => void>();
const notifyPresence = () => { for (const listener of [...presenceListeners]) listener(); };

/** Registers the calling dialog as modal for as long as it is mounted. */
export function useModalPresence(): void {
  useEffect(() => {
    presentModals += 1;
    notifyPresence();
    return () => { presentModals -= 1; notifyPresence(); };
  }, []);
}

export const isModalOpen = (): boolean => presentModals > 0;

export function useIsModalOpen(): boolean {
  return useSyncExternalStore(
    (listener) => { presenceListeners.add(listener); return () => { presenceListeners.delete(listener); }; },
    isModalOpen,
    isModalOpen,
  );
}

/**
 * True while at least one modal dialog is open — the Contextual Task Bar steps aside over Camera
 * Raw and Liquify with it (owner, master-plan §58.2). The same count as `useIsModalOpen`: one
 * source, which also covers the filter and adjustment dialogs that have no backdrop.
 */
export const useAnyModalOpen = useIsModalOpen;

/**
 * The backdrop every modal dialog sits on, and the one place that decides where modals stack.
 *
 * Found live: dialogs waiting for an answer — a confirmation, an error, the model-download
 * consent — were hidden behind other windows. Two separate causes, both fixed here rather than
 * per dialog. The confirmation family's backdrop was `position:absolute; z-index:9`, under every
 * ordinary dialog (10) and all floating panels; and each dialog rendered wherever its component
 * lived — some inside a Dockview panel, whose own stacking context caps any `z-index` a child
 * asks for, so no number could have lifted it.
 *
 * The donors' answer is the same everywhere: the browser's native `<dialog>.showModal()` puts
 * the dialog in the top layer, and Radix, MUI and Headless UI portal every modal out of its
 * component tree and stack by opening order. This does the portal and the order. The target is
 * `.app`, not `document.body`: the theme's CSS variables are declared on `.app`, and an element
 * outside it silently renders without them (CLAUDE.md §4, the loading screen).
 */
export function ModalBackdrop({ className, style, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  const [order] = useState(() => ++openOrder);
  useModalPresence();
  const target = typeof document === "undefined" ? null : document.querySelector(".app") ?? document.body;
  const backdrop = <div {...rest} className={className ? `dialog-backdrop ${className}` : "dialog-backdrop"} style={{ ...style, zIndex: MODAL_BASE_Z + order }}>{children}</div>;
  return target ? createPortal(backdrop, target) : backdrop;
}
