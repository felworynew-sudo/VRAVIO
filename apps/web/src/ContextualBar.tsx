import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { resolveLabel, text } from "./i18n";
import { useShellStore, type Language } from "./store";
import { useAnyModalOpen } from "./modals/ModalBackdrop";
import { useEditSession, useEditSessionFrameVersion } from "./contextual-bar/sessions";
import { contextualAnchor, resolveContextualBar, type ContextualBarContext, type ResolvedAction } from "./contextual-bar/states";

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
 * Look, after the owner tried the first version live (too long with a
 * selection, text should hide behind icons, it gets under the hand):
 * Photoshop's bar is a compact pill of icon buttons with tooltips and at
 * most one or two text buttons for the state's main action — so buttons are
 * icons from the project's own `icons/` set with the catalogue label as
 * tooltip and aria-label, only `primary` actions show text, there is no
 * state caption, and the width is capped.
 *
 * Out of the way of the work: the bar is placed *outside* the thing it acts
 * on (below it, else above, else beside it), never over it, and away from
 * where the pointer last was; while a gesture is in progress on the canvas
 * (a pointer pressed anywhere in the canvas area outside the bar — painting,
 * dragging a marquee, moving) it fades out and stops taking pointer events,
 * and comes back on release. It never starts a gesture of its own over the
 * canvas, so a drag that begins on the canvas is never intercepted.
 *
 * The bar lives outside the zoomable stage (it is mounted beside the dock, not
 * inside `.raster-stage`), so nothing about it scales with zoom — the anchor
 * is measured through the stage's own `getScreenCTM()` — the matrix the SVG
 * inside the stage already carries — so pan, zoom and a rotated view all come
 * out right, in raster and in vector alike.
 */

interface Point { x: number; y: number }

const GAP = 16, MARGIN = 8;
/** How far from the last pointer position the bar keeps its edges. */
const POINTER_CLEARANCE = 24;

interface Box { left: number; top: number; right: number; bottom: number }
const overlaps = (a: Box, b: Box): boolean => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

/** An icon from the project's `icons/` folder, drawn in the current text colour. */
const iconStyle = (file: string) => ({ "--icon-mask": `url("${import.meta.env.BASE_URL}${encodeURIComponent(file)}")` }) as CSSProperties;

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
  /** A pointer is pressed on the canvas: the user is working there. */
  const [gesture, setGesture] = useState(false);
  const lastPointer = useRef<Point | null>(null);

  // Nothing floats over a dialog waiting for the user (Camera Raw, Liquify…).
  const modalOpen = useAnyModalOpen();

  const session = useEditSession(documentId);
  const sessionFrameVersion = useEditSessionFrameVersion();
  const context: ContextualBarContext = { documentId, state, editingMaskLayerId, selectedLayerIds: selectedLayerIds ?? [], session };
  const resolved = visible && !modalOpen ? resolveContextualBar(context) : null;
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

  // Hide while a gesture runs on the canvas; remember where the pointer is, so
  // the next placement can keep clear of it. Capture phase, so a tool that
  // stops propagation still tells the bar.
  useEffect(() => {
    const inCanvas = (event: PointerEvent) => {
      const target = event.target as Element | null;
      return Boolean(target?.closest?.(".viewport-chrome-canvas")) && !target?.closest?.(".contextual-bar");
    };
    const down = (event: PointerEvent) => { if (inCanvas(event)) { lastPointer.current = { x: event.clientX, y: event.clientY }; setGesture(true); } };
    const move = (event: PointerEvent) => { if (inCanvas(event)) lastPointer.current = { x: event.clientX, y: event.clientY }; };
    const up = () => setGesture(false);
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
    };
  }, []);

  useLayoutEffect(() => {
    if (!stateId || drag || gesture) return;
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
      // The stage's own coordinate system, read off an SVG inside it: its
      // screen matrix carries the stage's CSS transform, view rotation included.
      const mapper = document.querySelector<SVGSVGElement>(".viewport-chrome-canvas .raster-stage svg.stage-metrics, .viewport-chrome-canvas .vector-stage > svg");
      const matrix = mapper?.getScreenCTM();
      if (!anchor || !mapper || !matrix) { setPosition(fallback); return; }
      const corner = (x: number, y: number): Point => {
        const svgPoint = mapper.createSVGPoint();
        svgPoint.x = x; svgPoint.y = y;
        const mapped = svgPoint.matrixTransform(matrix);
        return { x: mapped.x, y: mapped.y };
      };
      const mapped = [corner(anchor.x, anchor.y), corner(anchor.x + anchor.width, anchor.y), corner(anchor.x + anchor.width, anchor.y + anchor.height), corner(anchor.x, anchor.y + anchor.height)];
      // A rotated view turns the object's rectangle into a quad; the bar keeps
      // clear of the box around it.
      const left = Math.min(...mapped.map((point) => point.x)), right = Math.max(...mapped.map((point) => point.x));
      const top = Math.min(...mapped.map((point) => point.y)), bottom = Math.max(...mapped.map((point) => point.y));
      // Candidates in order of preference — centred below, centred above, then
      // beside — each kept inside the canvas area. The first that covers
      // neither the object (plus a gap) nor the last pointer position wins; if
      // none does (the object fills the view), the bottom edge of the canvas
      // area is the least bad place.
      const object: Box = { left: left - GAP / 2, top: top - GAP / 2, right: right + GAP / 2, bottom: bottom + GAP / 2 };
      const pointer = lastPointer.current;
      const pointerBox: Box | null = pointer ? { left: pointer.x - POINTER_CLEARANCE, top: pointer.y - POINTER_CLEARANCE, right: pointer.x + POINTER_CLEARANCE, bottom: pointer.y + POINTER_CLEARANCE } : null;
      const centreX = (left + right) / 2 - width / 2, centreY = (top + bottom) / 2 - height / 2;
      const candidates: Point[] = [
        { x: centreX, y: bottom + GAP },
        { x: centreX, y: top - GAP - height },
        { x: right + GAP, y: centreY },
        { x: left - GAP - width, y: centreY },
      ].map(clamp);
      const fits = (point: Point) => {
        const box: Box = { left: point.x, top: point.y, right: point.x + width, bottom: point.y + height };
        return !overlaps(box, object) && !(pointerBox && overlaps(box, pointerBox));
      };
      setPosition(candidates.find(fits) ?? fallback);
    });
    return () => cancelAnimationFrame(frame);
  }, [stateId, actionKey, anchorKey, pin, viewport?.zoom, viewport?.panX, viewport?.panY, viewport?.rotation, viewport?.mode, layoutTick, drag, gesture, language, sessionFrameVersion]);

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

  const label = (action: ResolvedAction) => resolveLabel(action.label, language);
  /** An icon button (label as tooltip), or icon + text for a primary action. */
  const face = (action: ResolvedAction, caret?: string) => <>
    {action.icon && <i className={`contextual-bar-icon${action.mirror ? " contextual-bar-icon-mirror" : ""}`} style={iconStyle(action.icon)} aria-hidden="true" />}
    {(action.primary || !action.icon) && <span>{label(action)}</span>}
    {caret && <i className="contextual-bar-icon contextual-bar-caret" style={iconStyle(caret)} aria-hidden="true" />}
  </>;
  const buttonClass = (action: ResolvedAction) => action.primary || !action.icon ? "contextual-bar-text" : "contextual-bar-icon-button";

  return <div
    ref={barRef}
    className={`contextual-bar${gesture ? " contextual-bar-busy" : ""}`}
    role="toolbar"
    data-state={resolved.state.id}
    aria-label={`${text(language, "Contextual Task Bar", "Контекстная панель задач")}: ${resolveLabel(resolved.state.label, language)}`}
    style={position ? { left: position.x, top: position.y } : { visibility: "hidden" }}
  >
    <span className="contextual-bar-grip" role="separator" aria-label={text(language, "Drag to move", "Перетащите, чтобы переместить")} title={text(language, "Drag to move", "Перетащите, чтобы переместить")} onPointerDown={beginDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} />
    {resolved.actions.map((action) => action.Component
      ? <action.Component key={action.id} context={context} />
      : action.items
      ? <span key={action.id} className="contextual-bar-dropdown">
        <button type="button" data-action={action.id} className={buttonClass(action)} title={label(action)} aria-label={label(action)} aria-haspopup="menu" aria-expanded={openDropdown === action.id} onClick={() => { setMenuOpen(false); setOpenDropdown((open) => open === action.id ? null : action.id); }}>{face(action, "СТРЕЛКА-ВНИЗ.svg")}</button>
        {openDropdown === action.id && <div className="contextual-bar-menu contextual-bar-dropdown-menu" role="menu" data-open-upward={upward ? "" : undefined}>
          {action.items.map((item) => <button key={item.id} type="button" role="menuitem" data-action={item.id} onClick={() => { setOpenDropdown(null); item.run(); }}>
            {item.icon ? <i className="contextual-bar-icon" style={iconStyle(item.icon)} aria-hidden="true" /> : <i className="contextual-bar-icon-space" aria-hidden="true" />}
            <span>{label(item)}</span>
          </button>)}
        </div>}
      </span>
      : <button key={action.id} type="button" data-action={action.id} className={buttonClass(action)} title={label(action)} aria-label={label(action)} onClick={action.run}>{face(action)}</button>)}
    <span className="contextual-bar-more">
      <button type="button" className="contextual-bar-icon-button contextual-bar-more-trigger" aria-haspopup="menu" aria-expanded={menuOpen} aria-label={text(language, "More options", "Дополнительно")} title={text(language, "More options", "Дополнительно")} onClick={() => { setOpenDropdown(null); setMenuOpen((open) => !open); }}><i className="contextual-bar-icon" style={iconStyle("МЕНЮ-ПАНЕЛИ.svg")} aria-hidden="true" /></button>
      {menuOpen && <div className="contextual-bar-menu" role="menu" data-open-upward={upward ? "" : undefined}>
        <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); updatePreferences({ contextualBar: false }); }}>{text(language, "Hide bar", "Скрыть панель")}</button>
        {pin
          ? <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); updatePreferences({ contextualBarPin: null }); }}>{text(language, "Reset bar position", "Сбросить положение панели")}</button>
          : <button type="button" role="menuitem" onClick={pinHere}>{text(language, "Pin bar position", "Закрепить положение панели")}</button>}
      </div>}
    </span>
  </div>;
}
