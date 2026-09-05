import type { EnvironmentKind } from "@vravio/kernel";
import { ToolbarEditor } from "../../toolbar/ToolbarEditor";
import type { ModalDefinition } from "../types";

interface ToolbarEditorProps { readonly kind: EnvironmentKind }

/** Photoshop's "Edit Toolbar…", opened by id from the palette's `(…)` button. */
export default {
  id: "toolbar-editor",
  component: ({ kind, close }: ToolbarEditorProps & { close: () => void }) => <ToolbarEditor kind={kind} close={close} />,
} satisfies ModalDefinition<ToolbarEditorProps> as ModalDefinition<never>;
