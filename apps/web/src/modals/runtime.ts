import { create } from "zustand";
import { useShellStore } from "../store";

interface OpenModal {
  readonly key: number;
  readonly id: string;
  readonly props: Record<string, unknown>;
}

interface ModalState {
  readonly open: readonly OpenModal[];
  push(id: string, props: Record<string, unknown>): number;
  dismiss(key: number): void;
}

/**
 * Which modals are open, as a stack.
 *
 * A stack rather than one slot because a modal legitimately opens another — a
 * confirmation raised from inside a dialog, an error reported while one is
 * already up — and the older one has to still be there underneath when the
 * newer is dismissed.
 *
 * Kept out of the shell store for the same reason `busy.ts` is: everything
 * subscribed to the shell would re-render when a dialog opens.
 */
const useModalStore = create<ModalState>((set) => ({
  open: [],
  push: (id, props) => {
    const key = nextKey++;
    set((state) => ({ open: [...state.open, { key, id, props }] }));
    return key;
  },
  dismiss: (key) => set((state) => ({ open: state.open.filter((entry) => entry.key !== key) })),
}));

let nextKey = 1;

export const useOpenModals = () => useModalStore((state) => state.open);
export const dismissModal = (key: number): void => useModalStore.getState().dismiss(key);

/**
 * Opens a modal by id, and returns a function that closes that one.
 *
 * By id, not by importing the component: see `types.ts`. Callable from
 * anywhere — a command, a tool, an event handler — because it is a store
 * write, not a React hook.
 */
export function openModal(id: string, props: Record<string, unknown> = {}): () => void {
  const key = useModalStore.getState().push(id, props);
  return () => dismissModal(key);
}

/**
 * Asks the user to confirm something, resolving to their answer.
 *
 * The shape callers actually want: `if (await confirmModal({...})) …`, instead
 * of splitting the operation across two callbacks and a piece of component
 * state holding what to do next.
 *
 * `confirmKey`, if given, is this confirmation's identity in `preferences.
 * confirmPreferences` — pass one when the question is worth letting the user
 * silence permanently (via the dialog's own "Don't ask again", or re-enable
 * later from Settings). Omit it for a one-off question with no reason to
 * remember an answer. When the user already said not to ask, this resolves
 * `true` immediately without opening anything — the caller cannot tell the
 * difference from a fresh "yes" click, which is the point.
 *
 * Deliberately just a free-form string, not tied to `EnvironmentKind` or any
 * other closed catalogue — a plugin-provided environment (none exist yet;
 * see master-plan.md §1.9 item 10г on why nothing here assumes one either)
 * could call this with its own key today and get the same suppress/re-enable
 * behavior for free, no core change needed.
 *
 * Named `confirmKey`, not `key`: `key` is a reserved React prop that gets
 * stripped before a component ever sees it in its own `props`, and — the
 * sharper trap — a plain object carrying a `key` field silently loses that
 * field to React's element-identity machinery the moment it's spread onto
 * JSX (`<Component {...thatObject} />`), not just when passed as an explicit
 * `key=` attribute. `ModalHost.tsx` does exactly that spread for every modal.
 */
export function confirmModal(props: { title: string; message: string; confirmLabel?: string; danger?: boolean; confirmKey?: string }): Promise<boolean> {
  return new Promise((resolve) => {
    if (props.confirmKey && useShellStore.getState().preferences.confirmPreferences[props.confirmKey] === false) { resolve(true); return; }
    const close = openModal("confirm", {
      ...props,
      onResolve: (confirmed: boolean) => { close(); resolve(confirmed); },
    });
  });
}

/**
 * Shows an error to the user.
 *
 * Separate from `diagnostic("error", …)`, which records it: several import and
 * save failures wrote a diagnostic and returned, so dropping a corrupt file on
 * the window did nothing whatsoever and the only trace was in a log the user
 * has to know to open. Recording and telling are both wanted; this is telling.
 */
export function errorModal(props: { title: string; message: string; detail?: string }): void {
  openModal("error", props);
}
