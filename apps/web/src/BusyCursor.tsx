import { useEffect, useRef } from "react";
import { useBusyStore } from "./busy";

/**
 * The spinner that follows the pointer while the application is working.
 *
 * Position is written straight to the element's transform rather than through
 * state: the pointer moves at the display's refresh rate, and re-rendering the
 * tree for each move would itself be part of the stall this is reporting.
 *
 * The label appears only once the work has outlasted a moment, so a fast
 * operation does not flash text on screen; the cursor changes immediately,
 * which is the part that answers "did my click register".
 */
export function BusyCursor(): React.ReactElement | null {
  const tasks = useBusyStore((state) => state.tasks);
  const holder = useRef<HTMLDivElement>(null);
  const label = tasks.at(-1)?.label ?? "";
  const busy = tasks.length > 0;

  useEffect(() => {
    const root = window.document.documentElement;
    if (busy) root.setAttribute("data-busy", "");
    else root.removeAttribute("data-busy");
    return () => root.removeAttribute("data-busy");
  }, [busy]);

  useEffect(() => {
    if (!busy) return;
    const element = holder.current;
    if (!element) return;
    const move = (event: PointerEvent) => {
      element.style.transform = `translate3d(${event.clientX}px, ${event.clientY}px, 0)`;
    };
    window.addEventListener("pointermove", move, { passive: true });
    return () => window.removeEventListener("pointermove", move);
  }, [busy]);

  useEffect(() => {
    if (!busy) return;
    const element = holder.current;
    if (!element) return;
    // Work that starts from a keyboard shortcut has no pointer event to place
    // the spinner, so it waits a moment and then shows the label centrally.
    const timer = setTimeout(() => element.setAttribute("data-slow", ""), 400);
    return () => { clearTimeout(timer); element.removeAttribute("data-slow"); };
  }, [busy, label]);

  if (!busy) return null;
  return (
    <div className="busy-cursor" ref={holder} aria-hidden="true">
      <span className="busy-cursor-spinner" />
      <span className="busy-cursor-label">{label}</span>
    </div>
  );
}

/** Announces the same state to a screen reader, which cannot see the spinner. */
export function BusyAnnouncement(): React.ReactElement {
  const label = useBusyStore((state) => state.tasks.at(-1)?.label ?? "");
  return <p className="visually-hidden" role="status" aria-live="polite">{label}</p>;
}
