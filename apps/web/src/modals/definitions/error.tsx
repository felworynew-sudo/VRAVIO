import { useShellStore } from "../../store";
import { text } from "../../i18n";
import type { ModalDefinition } from "../types";

interface ErrorProps {
  readonly title: string;
  readonly message: string;
  /** The technical part — a decoder's own message, a stack. Shown folded away,
   * because it helps whoever reports the problem and means nothing to whoever
   * only wanted to open a file. */
  readonly detail?: string;
}

/**
 * Something went wrong, said out loud.
 *
 * The counterpart to `diagnostic("error", …)`, which only records. Several
 * failures — a PSD that would not decode, a save the platform refused —
 * recorded and returned, so the application appeared to simply ignore the
 * user: no document opened, nothing said, and the only evidence in a log
 * behind a menu. Both are wanted; the log is the record, this is the telling.
 */
function ErrorModal({ title, message, detail, close }: ErrorProps & { close: () => void }) {
  const language = useShellStore((state) => state.language);

  return <div className="dialog-backdrop rasterize-confirm-backdrop" onMouseDown={close}>
    <section
      className="rasterize-confirm"
      role="alertdialog"
      aria-modal="true"
      tabIndex={-1}
      ref={(node) => node?.focus()}
      onKeyDown={(event) => { if (event.key === "Escape") close(); }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <strong>{title}</strong>
      <p>{message}</p>
      {detail && <pre className="modal-detail">{detail}</pre>}
      <footer>
        <button className="primary" onClick={close}>{text(language, "Close", "Закрыть")}</button>
      </footer>
    </section>
  </div>;
}

export default { id: "error", component: ErrorModal } satisfies ModalDefinition<ErrorProps> as ModalDefinition<never>;
