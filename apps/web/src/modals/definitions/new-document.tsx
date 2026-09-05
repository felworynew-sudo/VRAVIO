import type { EnvironmentKind } from "@vravio/kernel";
import { NewDocumentDialog } from "../../NewDocumentDialog";
import type { ModalDefinition } from "../types";

interface NewDocumentProps { readonly initialKind: EnvironmentKind }

/**
 * The new-document dialog, reachable by id.
 *
 * The component itself is unchanged and stays where it is — a catalogue entry
 * is a way of *reaching* a modal, not a place to move every dialog's
 * implementation to. What changed is that `requestNewDocument` no longer sets
 * a flag in the shell store for `App.tsx` to notice and render.
 */
export default {
  id: "new-document",
  component: ({ initialKind, close }: NewDocumentProps & { close: () => void }) => <NewDocumentDialog initialKind={initialKind} close={close} />,
} satisfies ModalDefinition<NewDocumentProps> as ModalDefinition<never>;
