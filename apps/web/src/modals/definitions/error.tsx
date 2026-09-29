import { useShellStore } from "../../store";
import { text } from "../../i18n";
import type { ModalDefinition } from "../types";
import { ModalBackdrop } from "../ModalBackdrop";
import { explainError } from "../../errors/explain";

interface ErrorProps {
  readonly title: string;
  /** What the caller knows about the situation, already in the interface language. Optional when
   * `error` is given — the explanation then speaks for itself. */
  readonly message?: string;
  /** The raw failure (an exception, an engine's error string). Never shown as the message: it is
   * turned into a reason, causes and remedies in the interface language by `explainError`, and its
   * own text goes into the folded technical detail. */
  readonly error?: unknown;
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
function ErrorModal({ title, message, error, detail, close }: ErrorProps & { close: () => void }) {
  const language = useShellStore((state) => state.language);
  const explained = error === undefined ? null : explainError(error, language);
  const technical = [detail, explained?.technical].filter(Boolean).join("\n");

  return <ModalBackdrop className="rasterize-confirm-backdrop" onMouseDown={close}>
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
      {message && <p>{message}</p>}
      {explained && <>
        <p className="error-reason">{explained.reason}</p>
        <div className="error-lists">
          <b>{text(language, "Possible causes", "Возможные причины")}</b>
          <ul>{explained.causes.map((cause) => <li key={cause}>{cause}</li>)}</ul>
          <b>{text(language, "What to do", "Что сделать")}</b>
          <ul>{explained.remedies.map((remedy) => <li key={remedy}>{remedy}</li>)}</ul>
        </div>
      </>}
      {technical && <details className="modal-detail-fold"><summary>{text(language, "Technical details", "Технические подробности")}</summary><pre className="modal-detail">{technical}</pre></details>}
      <footer>
        <button className="primary" onClick={close}>{text(language, "Close", "Закрыть")}</button>
      </footer>
    </section>
  </ModalBackdrop>;
}

export default { id: "error", component: ErrorModal } satisfies ModalDefinition<ErrorProps> as ModalDefinition<never>;
