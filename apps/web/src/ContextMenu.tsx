import { useState } from "react";

export interface ContextMenuItem {
  label: string;
  onSelect(): void;
  disabled?: boolean;
  danger?: boolean;
  /** A visual break before this item — Photoshop groups a context menu's actions this way. */
  separatorBefore?: boolean;
}

interface ContextMenuState { x: number; y: number; items: ContextMenuItem[] }

/**
 * A right-click menu anchored at the pointer, shared by every place VRAVIO needs one — a
 * layer row, the canvas while a tool is active, anywhere else. `open` is what a consumer's
 * own `onContextMenu` calls; `node` is rendered once, wherever is convenient in that
 * component's tree (it portals nothing, so anywhere with normal document flow works, since
 * the menu itself is `position: fixed`).
 */
export function useContextMenu() {
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const open = (event: { preventDefault(): void; stopPropagation(): void; clientX: number; clientY: number }, items: ContextMenuItem[]) => {
    event.preventDefault();
    event.stopPropagation();
    if (items.length) setMenu({ x: event.clientX, y: event.clientY, items });
  };
  const close = () => setMenu(null);
  const node = menu && <div className="context-menu-backdrop" onMouseDown={close} onContextMenu={(event) => { event.preventDefault(); close(); }}>
    <div className="context-menu" style={{ left: Math.min(menu.x, window.innerWidth - 240), top: Math.min(menu.y, window.innerHeight - menu.items.length * 30 - 16) }} onMouseDown={(event) => event.stopPropagation()}>
      {menu.items.map((item, index) => <button key={index} disabled={item.disabled} className={[item.danger ? "danger" : "", item.separatorBefore ? "separator-before" : ""].filter(Boolean).join(" ")} onClick={() => { item.onSelect(); close(); }}>{item.label}</button>)}
    </div>
  </div>;
  return { open, close, node, isOpen: menu !== null };
}
