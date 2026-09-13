import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

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
  const menuRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<{ left: number; top: number } | null>(null);
  const open = (event: { preventDefault(): void; stopPropagation(): void; clientX: number; clientY: number }, items: ContextMenuItem[]) => {
    event.preventDefault();
    event.stopPropagation();
    if (items.length) { setPlacement(null); setMenu({ x: event.clientX, y: event.clientY, items }); }
  };
  const close = () => { setMenu(null); setPlacement(null); };
  useLayoutEffect(() => {
    if (!menu || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect(), margin = 8;
    setPlacement({
      left: Math.max(margin, Math.min(menu.x, window.innerWidth - rect.width - margin)),
      top: Math.max(margin, Math.min(menu.y, window.innerHeight - rect.height - margin)),
    });
  }, [menu]);
  // Dockview uses transformed/overflowing containers for collapsed icon docks.
  // A fixed element below one of those can still be clipped by that ancestor,
  // so every context menu belongs at the document root, not in its panel tree.
  const node = menu ? createPortal(<div className="context-menu-backdrop" onMouseDown={close} onContextMenu={(event) => { event.preventDefault(); close(); }}>
    <div ref={menuRef} className="context-menu" style={{ left: placement?.left ?? menu.x, top: placement?.top ?? menu.y }} onMouseDown={(event) => event.stopPropagation()}>
      {menu.items.map((item, index) => <button key={index} disabled={item.disabled} className={[item.danger ? "danger" : "", item.separatorBefore ? "separator-before" : ""].filter(Boolean).join(" ")} onClick={() => { item.onSelect(); close(); }}>{item.label}</button>)}
    </div>
  </div>, document.body) : null;
  return { open, close, node, isOpen: menu !== null };
}
