import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { resolveLabel, text } from "./i18n";
import { useShellStore, type Language } from "./store";
import { contextualAnchor, resolveContextualBar, type ContextualBarContext } from "./contextual-bar/states";

/**
 * Photoshop's Contextual Task Bar (docs/master-plan.md §11): a floating bar of
 * next-most-likely actions that changes with what the document has selected.
 *
 * What it shows is data — `contextual-bar/states.ts`, one row per state, each
 * action a catalogue command. This file only places the bar and handles
 * Photoshop's own bar chrome: the grip to drag it by, and the "…" menu with
 * Hide bar / Pin bar position / Reset bar position.
 *
 * Placement, as in Photoshop: while unpinned the bar follows what it acts on —
 * centred under the selection (or the active layer), flipped above it when
 * there is no room below, clamped inside the canvas area. Dragging it, or
 * "Pin bar position", fixes it where it is (remembered across sessions);
 * "Reset bar position" lets it follow again.
 *
 * The bar lives outside the zoomable stage (it is mounted beside the dock, not
 * inside `.raster-stage`), so nothing about it scales with zoom — the anchor
 * is measured from the canvas element's on-screen rectangle instead, which
 * already includes zoom and pan. A rotated view has no axis-aligned
 * rectangle to follow; there the bar falls back to its default spot (bottom
 * centre of the canvas area) rather than guess.
 */

interface Point { x: number; y: number }

const GAP = 12, MARGIN = 8;

const canvasArea = (): HTMLElement | null => document.querySelector<HTMLElement>(".viewport-chrome-canvas");

export function ContextualBar({ documentId, state, language, visible }: {
  documentId: string;
  state: unknown;
  language: Language;
  visible: boolean;
}) {
  const editingMaskLayerId = useShellStore((store) => store.editingMaskLayerIdByDocument[documentId] ?? null);
  const selectedLayerIds = useShellStore((store) => store.selectedLayerIdsByDocument[documentId]);
  const viewport = useShellStore((store) => store.viewports[documentId]);
  const pin = useShellStore((store) => store.preferences.contextualBarPin);
  const updatePreferences = useShellStore((store) => store.updatePreferences);

  const barRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<Point | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  /** Which dropdown action ("Modify selection ▾") has its list open. */
  const [openDropdown, setOpenDropdown] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ pointerId: number; offset: Point; area: DOMRect } | null>(null);
  const [layoutTick, setLayoutTick] = useState(0);

  const context: ContextualBarContext = { documentId, state, editingMaskLayerId, selectedLayerIds: selectedLayerIds ?? [] };
  const resolved = visible ? resolveContextualBar(context) : null;
  const anchor = resolved ? contextualAnchor(context) : null;
  const anchorKey = anchor ? `${anchor.x},${anchor.y},${anchor.width},${anchor.height}` : "";
  const stateId = resolved?.state.id ?? null;
  const actionKey = resolved?.actions.map((action) => action.id).join("|") ?? "";

  // The dock can resize the canvas column without anything in this component
  // changing; a window resize likewise. Either moves where the bar belongs.
  useEffect(() => {
    if (!stateId) return;
    const bump = () => setLayoutTick((tick) => tick + 1);
    const area = canvasArea();
    const observer = typeof ResizeObserver === "undefined" || !area ? null : new ResizeObserver(bump);
    if (area) observer?.observe(area);
    window.addEventListener("resize", bump);
    return () => { observer?.disconnect(); window.removeEventListener("resize", bump); };
  }, [stateId]);

  useLayoutEffect(() => {
    if (!stateId || drag) return;
    // The stage's transform is applied by the workspace's own render of the
    // same store change; measure on the next frame, once that has landed.
    const frame = requestAnimationFrame(() => {
      const bar = barRef.current, area = canvasArea()?.getBoundingClientRect();
      if (!bar || !area) return;
      const width = bar.offsetWidth, height = bar.offsetHeight;
      const clamp = (point: Point): Point => ({
        x: Math.min(Math.max(point.x, area.left + MARGIN), Math.max(area.left + MARGIN, area.right - width - MARGIN)),
        y: Math.min(Math.max(point.y, area.top + MARGIN), Math.max(area.top + MARGIN, area.bottom - height - MARGIN)),
      });
      if (pin) { setPosition(clamp({ x: area.left + pin.x, y: area.top + pin.y })); return; }
      const fallback = clamp({ x: area.left + (area.width - width) / 2, y: area.bottom - height - 20 });
      const canvas = document.querySelector<HTMLCanvasElement>(".viewport-chrome-canvas .raster-stage canvas");
      if (!anchor || !canvas || !canvas.width || (viewport?.rotation ?? 0) % 360 !== 0) { setPosition(fallback); return; }
      const rect = canvas.getBoundingClientRect();
      const scaleX = rect.width / canvas.width, scaleY = rect.height / canvas.height;
      const left = rect.left + anchor.x * scaleX, right = rect.left + (anchor.x + anchor.width) * scaleX;
      const top = rect.top + anchor.y * scaleY, bottom = rect.top + (anchor.y + anchor.height) * scaleY;
      const x = (left + right) / 2 - width / 2;
      const below = bottom + GAP, above = top - GAP - height;
      const y = below + height <= area.bottom - MARGIN ? below : above >= area.top + MARGIN ? above : area.bottom - height - 20;
      setPosition(clamp({ x, y }));
    });
    return () => cancelAnimationFrame(frame);
  }, [stateId, actionKey, anchorKey, pin, viewport?.zoom, viewport?.panX, viewport?.panY, viewport?.rotation, viewport?.mode, layoutTick, drag, language]);

  // A different state is a different set of buttons; an open menu belongs to the old one.
  useEffect(() => { setMenuOpen(false); setOpenDropdown(null); }, [stateId]);

  const beginDrag = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const bar = barRef.current, area = canvasArea()?.getBoundingClientRect();
    if (!bar || !area || event.button !== 0) return;
    const rect = bar.getBoundingClientRect();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ pointerId: event.pointerId, offset: { x: event.clientX - rect.left, y: event.clientY - rect.top }, area });
    setMenuOpen(false);
    event.preventDefault();
  }, []);

  const moveDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (!drag || event.pointerId !== drag.pointerId || !barRef.current) return;
    const { area, offset } = drag, width = barRef.current.offsetWidth, height = barRef.current.offsetHeight;
    setPosition({
      x: Math.min(Math.max(event.clientX - offset.x, area.left), area.right - width),
      y: Math.min(Math.max(event.clientY - offset.y, area.top), area.bottom - height),
    });
  };

  const endDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    setDrag(null);
    // Dropping the bar somewhere is a decision about where it lives, so it
    // pins there — otherwise the next selection change would snap it back.
    if (position) updatePreferences({ contextualBarPin: { x: Math.round(position.x - drag.area.left), y: Math.round(position.y - drag.area.top) } });
  };

  const pinHere = () => {
    const area = canvasArea()?.getBoundingClientRect();
    if (area && position) updatePreferences({ contextualBarPin: { x: Math.round(position.x - area.left), y: Math.round(position.y - area.top) } });
    setMenuOpen(false);
  };

  if (!resolved) return null;
  // Lists open away from the nearer screen edge.
  const upward = Boolean(position && position.y > window.innerHeight / 2);

  return <div
    ref={barRef}
    className="contextual-bar"
    role="toolbar"
    data-state={resolved.state.id}
    aria-label={text(language, "Contextual Task Bar", "Контекстная панель задач")}
    style={position ? { left: position.x, top: position.y } : { visibility: "hidden" }}
  >
    <span className="contextual-bar-grip" role="separator" aria-label={text(language, "Drag to move", "Перетащите, чтобы переместить")} title={text(language, "Drag to move", "Перетащите, чтобы переместить")} onPointerDown={beginDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} />
    <span className="contextual-bar-caption">{resolveLabel(resolved.state.label, language)}</span>
    {resolved.actions.map((action) => action.items
      ? <span key={action.id} className="contextual-bar-dropdown">
        <button type="button" data-action={action.id} aria-haspopup="menu" aria-expanded={openDropdown === action.id} onClick={() => { setMenuOpen(false); setOpenDropdown((open) => open === action.id ? null : action.id); }}>{resolveLabel(action.label, language)} ▾</button>
        {openDropdown === action.id && <div className="contextual-bar-menu contextual-bar-dropdown-menu" role="menu" data-open-upward={upward ? "" : undefined}>
          {action.items.map((item) => <button key={item.id} type="button" role="menuitem" data-action={item.id} onClick={() => { setOpenDropdown(null); item.run(); }}>{resolveLabel(item.label, language)}</button>)}
        </div>}
      </span>
      : <button key={action.id} type="button" data-action={action.id} onClick={action.run}>{resolveLabel(action.label, language)}</button>)}
    <span className="contextual-bar-more">
      <button type="button" className="contextual-bar-more-trigger" aria-haspopup="menu" aria-expanded={menuOpen} aria-label={text(language, "More options", "Дополнительно")} title={text(language, "More options", "Дополнительно")} onClick={() => { setOpenDropdown(null); setMenuOpen((open) => !open); }}>⋯</button>
      {menuOpen && <div className="contextual-bar-menu" role="menu" data-open-upward={upward ? "" : undefined}>
        <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); updatePreferences({ contextualBar: false }); }}>{text(language, "Hide bar", "Скрыть панель")}</button>
        {pin
          ? <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); updatePreferences({ contextualBarPin: null }); }}>{text(language, "Reset bar position", "Сбросить положение панели")}</button>
          : <button type="button" role="menuitem" onClick={pinHere}>{text(language, "Pin bar position", "Закрепить положение панели")}</button>}
      </div>}
    </span>
  </div>;
}
