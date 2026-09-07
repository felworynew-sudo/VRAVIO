import { useEffect } from "react";

/**
 * The shared "click anywhere else closes this" door for every custom
 * dropdown/flyout/menu in the app — none of them had one until this was
 * written (docs/master-plan.md §8.3), and a second one turned up (the
 * adjustment-layer list in `DockLayout.tsx`'s `LayersPanel`) after the first
 * fix only covered the top File/Edit/… menus and the toolbar's tool-group
 * flyouts. One hook, called once per dropdown with its own `active`/`onClose`,
 * rather than a new hand-rolled `pointerdown` listener at each call site —
 * the next dropdown that needs this gets it by calling the hook, not by
 * someone remembering the pattern.
 *
 * `pointerdown`, not `click`: fires before the toggle button's own `onClick`
 * would, and `event.target.closest(selector)` still matches that button
 * (it lives inside the dropdown's own wrapper element) and anything inside
 * the open dropdown's content, so their existing `onClick` handlers — which
 * already toggle or act-then-close — run exactly as before. Only listens
 * while `active` is true, so an idle dropdown costs nothing.
 */
export function useCloseOnOutsideClick(active: boolean, selector: string, onClose: () => void): void {
  useEffect(() => {
    if (!active) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(selector)) return;
      onClose();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [active, selector, onClose]);
}
