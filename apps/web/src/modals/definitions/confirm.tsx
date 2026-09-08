import { useState } from "react";
import { useShellStore } from "../../store";
import { text } from "../../i18n";
import type { ModalDefinition } from "../types";

interface ConfirmProps {
  readonly title: string;
  readonly message: string;
  readonly confirmLabel?: string;
  readonly danger?: boolean;
  /** See `confirmModal`'s own doc comment — present only when this question is
   * worth letting the user silence. Named `confirmKey`, not `key`: `key` is a
   * reserved React prop that never reaches a component's own `props` object,
   * so calling it that here would silently read as `undefined` always. */
  readonly confirmKey?: string;
  readonly onResolve: (confirmed: boolean) => void;
}

/**
 * "Are you sure?", for anything that needs to ask.
 *
 * Generic on purpose. `RasterizeConfirmDialog` was this dialog with one
 * question baked into it, reachable only from the one component that imported
 * it; the caller now supplies the words and gets an answer back through
 * `confirmModal`.
 *
 * Dismissing counts as "no" — clicking the backdrop, or pressing Escape,
 * cannot mean yes.
 */
function Confirm({ title, message, confirmLabel, danger, confirmKey, onResolve, close }: ConfirmProps & { close: () => void }) {
  const language = useShellStore((state) => state.language);
  const updatePreferences = useShellStore((state) => state.updatePreferences);
  const confirmPreferences = useShellStore((state) => state.preferences.confirmPreferences);
  const [suppress, setSuppress] = useState(false);
  const cancel = () => { onResolve(false); close(); };
  const confirm = () => {
    if (confirmKey && suppress) updatePreferences({ confirmPreferences: { ...confirmPreferences, [confirmKey]: false } });
    onResolve(true);
    close();
  };

  return <div className="dialog-backdrop rasterize-confirm-backdrop" onMouseDown={cancel}>
    <section
      className="rasterize-confirm"
      role="alertdialog"
      aria-modal="true"
      tabIndex={-1}
      ref={(node) => node?.focus()}
      onKeyDown={(event) => { if (event.key === "Escape") cancel(); }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <strong>{title}</strong>
      <p>{message}</p>
      {confirmKey && <label className="confirm-suppress"><input type="checkbox" checked={suppress} onChange={(event) => setSuppress(event.target.checked)}/>{text(language, "Don't ask again", "Больше не спрашивать")}</label>}
      <footer>
        <button onClick={cancel}>{text(language, "Cancel", "Отмена")}</button>
        <button className={danger ? "danger" : "primary"} onClick={confirm}>
          {confirmLabel ?? text(language, "OK", "OK")}
        </button>
      </footer>
    </section>
  </div>;
}

export default { id: "confirm", component: Confirm } satisfies ModalDefinition<ConfirmProps> as ModalDefinition<never>;
