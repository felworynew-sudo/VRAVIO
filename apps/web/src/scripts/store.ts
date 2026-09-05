import { create } from "zustand";
import { diagnostic } from "../diagnostics";
import { kernel } from "../kernel";
import { useShellStore } from "../store";
import { ScriptRecorder } from "./recording";
import { playScript } from "./player";
import type { Script, ScriptRun } from "./types";

const STORAGE_KEY = "vravio.scripts.v1";

function readStored(): Script[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter((entry): entry is Script =>
      Boolean(entry) && typeof entry === "object"
      && typeof (entry as Script).id === "string"
      && typeof (entry as Script).name === "string"
      && Array.isArray((entry as Script).steps));
  } catch { return []; }
}

interface ScriptsState {
  readonly scripts: readonly Script[];
  readonly recording: boolean;
  /** How many steps the recording has caught, so the UI can say so live. */
  readonly recordedCount: number;
  readonly lastRun: (ScriptRun & { readonly scriptId: string }) | null;
  startRecording(): void;
  stopRecording(name: string): Script | null;
  cancelRecording(): void;
  play(id: string): Promise<void>;
  remove(id: string): void;
  rename(id: string, name: string): void;
}

/** The recorder itself is not React state — see its own note. */
const recorder = new ScriptRecorder();

const persist = (scripts: readonly Script[]): void => {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(scripts)); }
  catch (error) { diagnostic("error", "script.save", "Could not save scripts", error); }
};

export const useScriptsStore = create<ScriptsState>((set, get) => ({
  scripts: readStored(),
  recording: false,
  recordedCount: 0,
  lastRun: null,

  startRecording: () => { recorder.start(); set({ recording: true, recordedCount: 0 }); },

  stopRecording: (name) => {
    const steps = recorder.stop();
    set({ recording: false, recordedCount: 0 });
    // A recording that caught nothing is not a script. Saving it would leave
    // an entry that does nothing when played, and the only honest explanation
    // would be "you recorded nothing".
    if (!steps.length) { diagnostic("info", "script.record", "Nothing was recorded"); return null; }

    const script: Script = { id: crypto.randomUUID(), name: name.trim() || new Date().toLocaleString(), steps, recordedAt: new Date().toISOString() };
    const scripts = [...get().scripts, script];
    persist(scripts);
    set({ scripts });
    return script;
  },

  cancelRecording: () => { recorder.stop(); set({ recording: false, recordedCount: 0 }); },

  play: async (id) => {
    const script = get().scripts.find((entry) => entry.id === id);
    if (!script) return;
    // Playing while recording would record the playback — every step twice
    // over, in a script that already exists.
    if (get().recording) { diagnostic("warn", "script.play", "Refused to play a script while recording"); return; }
    // The context is rebuilt per step by the player; this closure is what it
    // calls. Reading the shell store each time is the point — a script that
    // creates a document and then works on it must see the one it made.
    const run = await playScript(script, () => ({ activeDocumentId: useShellStore.getState().activeDocumentId }));
    set({ lastRun: { ...run, scriptId: id } });
  },

  remove: (id) => {
    const scripts = get().scripts.filter((entry) => entry.id !== id);
    persist(scripts);
    set({ scripts });
  },

  rename: (id, name) => {
    const scripts = get().scripts.map((entry) => (entry.id === id ? { ...entry, name } : entry));
    persist(scripts);
    set({ scripts });
  },
}));

/**
 * Starts watching the command registry.
 *
 * Subscribed once, at startup, to the registry rather than to any one caller:
 * a command reached by shortcut, by menu or by a panel button all arrive here,
 * which is the whole reason the registry emits this (see `CommandRegistry`).
 */
export function installScriptRecorder(): () => void {
  const subscription = kernel.commands.onExecuted((execution) => {
    if (!recorder.recording) return;
    recorder.observe(execution.args ? { commandId: execution.id, args: execution.args } : { commandId: execution.id });
    useScriptsStore.setState({ recordedCount: recorder.steps.length });
  });
  return () => subscription.dispose();
}
