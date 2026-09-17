import { useEffect } from "react";

/**
 * Settings → General's own "Tooltips" toggle (`store.preferences.showTooltips`) declared an
 * option nothing read — turning it off changed nothing, the exact "declared option nothing
 * reads" class of bug `environments/vector/tools/types.ts`'s own `snapping` doc comment already
 * names as a lesson from `smartGuides`/`snapToGuides`. Native `title=` tooltips are the app's own
 * tooltip mechanism throughout (used in dozens of components), and the browser gives no CSS or
 * per-element API to suppress them — so rather than touching every call site (or building a
 * second, custom tooltip system to replace a working native one), this is the "single door" fix:
 * one capture-phase listener pair that strips `title` right before the browser would start its
 * hover timer and restores it on `mouseout`, so every existing `title=` attribute in the app
 * keeps working normally the instant the preference is back on, with zero cost when it is.
 */
export function useTooltipSuppression(enabled: boolean): void {
  useEffect(() => {
    if (enabled) return;
    const suppress = (event: Event): void => {
      const element = event.target as HTMLElement;
      if (element?.hasAttribute?.("title")) {
        element.dataset.suppressedTitle = element.getAttribute("title") ?? "";
        element.removeAttribute("title");
      }
    };
    const restore = (event: Event): void => {
      const element = event.target as HTMLElement;
      if (element?.dataset?.suppressedTitle !== undefined) {
        element.setAttribute("title", element.dataset.suppressedTitle);
        delete element.dataset.suppressedTitle;
      }
    };
    document.addEventListener("mouseover", suppress, true);
    document.addEventListener("mouseout", restore, true);
    return () => {
      document.removeEventListener("mouseover", suppress, true);
      document.removeEventListener("mouseout", restore, true);
    };
  }, [enabled]);
}
