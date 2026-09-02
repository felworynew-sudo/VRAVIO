import { create } from "zustand";

interface BusyTask {
  readonly id: number;
  readonly label: string;
  readonly startedAt: number;
}

interface BusyState {
  readonly tasks: readonly BusyTask[];
  begin(label: string): number;
  end(id: number): void;
}

/**
 * What the application is busy doing.
 *
 * Kept out of the shell store on purpose: this is written from inside long
 * operations, several times a second in some of them, and every write here
 * would otherwise re-render everything subscribed to the shell.
 */
export const useBusyStore = create<BusyState>((set) => ({
  tasks: [],
  begin: (label) => {
    const id = nextId++;
    set((state) => ({ tasks: [...state.tasks, { id, label, startedAt: performance.now() }] }));
    return id;
  },
  end: (id) => set((state) => ({ tasks: state.tasks.filter((task) => task.id !== id) })),
}));

let nextId = 1;

/** A frame, or the next turn of the loop where there are no frames to wait for. */
const nextFrame = (run: () => void): void => {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => run());
  else setTimeout(run, 0);
};

/**
 * Runs work that will visibly hold up the interface, saying so while it does.
 *
 * Some operations here are seconds long — a filter over a large document, a
 * model loading, an export — and the browser gives no sign that anything is
 * happening. Without a signal the only feedback is that clicks stop working,
 * which reads as a crash rather than as progress.
 *
 * Works for both synchronous and asynchronous work, and clears on failure as
 * well as on success: an operation that throws must not leave the pointer
 * spinning forever.
 */
export function withBusy<T>(label: string, work: () => T): T;
export function withBusy<T>(label: string, work: () => Promise<T>): Promise<T>;
export function withBusy<T>(label: string, work: () => T | Promise<T>): T | Promise<T> {
  const { begin, end } = useBusyStore.getState();
  const id = begin(label);
  let result: T | Promise<T>;
  try {
    result = work();
  } catch (error) {
    end(id);
    throw error;
  }
  if (result instanceof Promise) return result.finally(() => end(id)) as Promise<T>;
  // Synchronous work has already blocked the thread by the time this returns, so
  // the marker is only useful to whatever paints before it starts; releasing on
  // the next frame lets that paint happen at all.
  nextFrame(() => end(id));
  return result;
}

/**
 * Yields to the browser so a pending paint can happen before blocking work.
 *
 * Setting a flag and immediately monopolising the thread paints nothing: the
 * flag and the work land in the same frame. Two frames is what it takes for a
 * style change to reach the screen.
 */
export const paintFirst = (): Promise<void> =>
  new Promise((resolve) => nextFrame(() => nextFrame(() => resolve())));

/** Runs blocking work after letting the busy state reach the screen. */
export async function withBusyPainted<T>(label: string, work: () => T | Promise<T>): Promise<T> {
  const { begin, end } = useBusyStore.getState();
  const id = begin(label);
  try {
    await paintFirst();
    return await work();
  } finally {
    end(id);
  }
}

/** Marks the application busy until the returned function is called. */
export function beginBusy(label: string): () => void {
  const { begin, end } = useBusyStore.getState();
  const id = begin(label);
  let released = false;
  return () => { if (!released) { released = true; end(id); } };
}
