import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { installGlobalDiagnostics } from "./diagnostics";
import { installScriptRecorder } from "./scripts/store";
import { kernel } from "./kernel";
import { createLoadingWindow } from "./startup/LoadingWindow";
import { runStartup } from "./startup/run";
import { useShellStore } from "./store";

const root = document.getElementById("root");
if (!root) throw new Error("VRAVIO root element is missing");
installGlobalDiagnostics();
// Subscribed to the command registry itself, so a command reached by shortcut,
// menu or panel button is recorded the same way (stage 9).
installScriptRecorder();
// A named stage at a time, on screen, instead of one line of text that stayed
// put however long any of it took (stage 11 of docs/migration-plan.md). The
// screen is plain DOM because it has to exist before React does — see
// `LoadingWindow.ts`.
const loading = createLoadingWindow(root, useShellStore.getState().language, useShellStore.getState().theme);
await runStartup((outcomes) => loading.update(outcomes));
loading.dispose();

document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") void kernel.autosave.flush(); });
window.addEventListener("beforeunload", () => { void kernel.autosave.flush(); });
createRoot(root).render(<StrictMode><App /></StrictMode>);
