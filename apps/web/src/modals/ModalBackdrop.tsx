import { useState, type HTMLAttributes } from "react";
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
  const target = typeof document === "undefined" ? null : document.querySelector(".app") ?? document.body;
  const backdrop = <div {...rest} className={className ? `dialog-backdrop ${className}` : "dialog-backdrop"} style={{ ...style, zIndex: MODAL_BASE_Z + order }}>{children}</div>;
  return target ? createPortal(backdrop, target) : backdrop;
}
