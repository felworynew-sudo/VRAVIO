import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { diagnostic, installGlobalDiagnostics } from "./diagnostics";
import { installScriptRecorder } from "./scripts/store";
import { kernel } from "./kernel";
import { useShellStore } from "./store";

const root = document.getElementById("root");
if (!root) throw new Error("VRAVIO root element is missing");
installGlobalDiagnostics();
// Subscribed to the command registry itself, so a command reached by shortcut,
// menu or panel button is recorded the same way (stage 9).
installScriptRecorder();
root.textContent = "Restoring session… (Восстановление сессии…)";

try {
  const restored = await kernel.sessionReady;
  useShellStore.getState().adoptRestoredDocuments(restored.map((document) => document.id));
  await kernel.assetsReady;
  // A restored child carries its link to its parent as provenance, but the
  // session around it was never saved. Without this it looks like an ordinary
  // document: applying fails, and it follows revisions of the asset it exists
  // to edit.
  const links = kernel.roundtrip.adoptRestored();
  if (restored.length) diagnostic("info", "autosave.restore", `Restored ${restored.length} document(s)${links.length ? `, ${links.length} linked` : ""}`);
} catch (error) {
  diagnostic("error", "autosave.restore", error instanceof Error ? error.message : String(error), error);
}

document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") void kernel.autosave.flush(); });
window.addEventListener("beforeunload", () => { void kernel.autosave.flush(); });
createRoot(root).render(<StrictMode><App /></StrictMode>);
