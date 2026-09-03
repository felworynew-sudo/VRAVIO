import { useEffect, useRef, useState } from "react";
import { applyDrag, applyStep, formatNumber, parseNumericInput, type NumberFieldSpec } from "./number-input";

/**
 * A numeric field with every way of setting a number an editor is expected
 * to offer: typing (with a unit suffix), arrow keys, the wheel, and a
 * scrubby drag on the label.
 *
 * The drag lives on the *label*, not the input, which is where Photoshop
 * puts it. Dragging on the input itself would fight text selection: the
 * same gesture that scrubs the value is the one that selects the digits to
 * retype them, and no amount of threshold tuning makes both feel right.
 *
 * All the arithmetic is in number-input.ts; this file only turns events
 * into calls on it, which is what keeps the behaviour testable without a
 * DOM.
 */
export function NumberBox({ label, value, spec, onChange, id, className }: {
  label?: string | undefined;
  value: number;
  spec: NumberFieldSpec;
  onChange(value: number): void;
  id?: string | undefined;
  className?: string | undefined;
}) {
  // What is in the input while it is being typed in. Kept separate from
  // `value` so a half-typed "-" or "1." is not parsed and thrown away
  // mid-keystroke; committed on blur or Enter.
  const [draft, setDraft] = useState<string | null>(null);
  // The value focus started on, so Escape has something to go back to.
  const committedRef = useRef(value);
  const dragRef = useRef<{ pointerId: number; startY: number; startValue: number } | null>(null);
  // Escape blurs the field, and blurring is what normally commits. Without
  // this flag the blur that Escape itself causes would commit the very draft
  // Escape just threw away: at that moment the input still holds the typed
  // text, because React has not re-rendered from `setDraft(null)` yet.
  const cancellingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const shown = draft ?? formatNumber(value, spec);

  const commitDraft = (raw: string) => {
    const parsed = parseNumericInput(raw, spec);
    setDraft(null);
    // Unparseable input keeps the value it had rather than becoming zero.
    if (parsed !== null && parsed !== value) onChange(parsed);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      const next = applyStep(value, event.key === "ArrowUp" ? 1 : -1, spec, event);
      setDraft(null);
      if (next !== value) onChange(next);
      return;
    }
    if (event.key === "Enter") { commitDraft(event.currentTarget.value); inputRef.current?.blur(); return; }
    if (event.key === "Escape") {
      // Back to what the field held when it was focused, and out of the way
      // — the same thing Escape does in Photoshop's fields.
      cancellingRef.current = true;
      setDraft(null);
      if (committedRef.current !== value) onChange(committedRef.current);
      inputRef.current?.blur();
    }
  };

  // Wheel is registered manually because React's onWheel is passive, and a
  // passive listener cannot preventDefault — the page would scroll under the
  // pointer while the value changed.
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const onWheel = (event: WheelEvent) => {
      if (document.activeElement !== input) return;
      event.preventDefault();
      const next = applyStep(value, event.deltaY < 0 ? 1 : -1, spec, event);
      if (next !== value) onChange(next);
    };
    input.addEventListener("wheel", onWheel, { passive: false });
    return () => input.removeEventListener("wheel", onWheel);
  }, [value, spec, onChange]);

  const onLabelPointerDown = (event: React.PointerEvent<HTMLSpanElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, startY: event.clientY, startValue: value };
  };

  const onLabelPointerMove = (event: React.PointerEvent<HTMLSpanElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const next = applyDrag(drag.startValue, event.clientY - drag.startY, spec, event);
    if (next !== value) onChange(next);
  };

  const endDrag = (event: React.PointerEvent<HTMLSpanElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return <label className={["number-box", className].filter(Boolean).join(" ")}>
    {label !== undefined && label !== "" && <span
      className="number-box-label"
      onPointerDown={onLabelPointerDown}
      onPointerMove={onLabelPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >{label}</span>}
    <span className="number-box-field">
      <input
        ref={inputRef}
        id={id}
        type="text"
        inputMode="decimal"
        value={shown}
        onFocus={() => { committedRef.current = value; }}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={(event) => { if (cancellingRef.current) { cancellingRef.current = false; setDraft(null); return; } commitDraft(event.target.value); }}
        onKeyDown={onKeyDown}
      />
      {spec.unit && <i className="number-box-unit">{spec.unit}</i>}
    </span>
  </label>;
}
