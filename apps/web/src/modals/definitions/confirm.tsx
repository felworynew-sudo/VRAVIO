import { useShellStore } from "../../store";
import { text } from "../../i18n";
import type { ModalDefinition } from "../types";

interface ConfirmProps {
  readonly title: string;
  readonly message: string;
  readonly confirmLabel?: string;
  readonly danger?: boolean;
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
function Confirm({ title, message, confirmLabel, danger, onResolve, close }: ConfirmProps & { close: () => void }) {
  const language = useShellStore((state) => state.language);
  const cancel = () => { onResolve(false); close(); };

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
      <footer>
        <button onClick={cancel}>{text(language, "Cancel", "Отмена")}</button>
        <button className={danger ? "danger" : "primary"} onClick={() => { onResolve(true); close(); }}>
          {confirmLabel ?? text(language, "OK", "OK")}
        </button>
      </footer>
    </section>
  </div>;
}

export default { id: "confirm", component: Confirm } satisfies ModalDefinition<ConfirmProps> as ModalDefinition<never>;
