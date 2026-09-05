import { diagnostic } from "../diagnostics";
import { modalById } from "./registry";
import { dismissModal, useOpenModals } from "./runtime";

/**
 * Renders whatever modals are open, in the order they were opened.
 *
 * Rendered once, at the top of the tree. Everything that wants to ask the user
 * something goes through `openModal` instead of holding its own boolean and
 * its own copy of the JSX.
 */
export function ModalHost(): React.ReactElement | null {
  const open = useOpenModals();
  if (!open.length) return null;

  return <>
    {open.map((entry) => {
      const definition = modalById.get(entry.id);
      if (!definition) {
        // An id nobody defines is a caller's typo, and a modal that silently
        // fails to appear is the hardest kind to notice: whatever was waiting
        // on it simply never happens.
        diagnostic("error", "modal.missing", `No modal is registered as "${entry.id}"`, { id: entry.id });
        return null;
      }
      const Component = definition.component as React.ComponentType<Record<string, unknown> & { close: () => void }>;
      return <Component key={entry.key} {...entry.props} close={() => dismissModal(entry.key)} />;
    })}
  </>;
}
