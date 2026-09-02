import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { diagnostic, installGlobalDiagnostics } from "./diagnostics";
import { kernel } from "./kernel";
import { useShellStore } from "./store";

const root = document.getElementById("root");
if (!root) throw new Error("VRAVIO root element is missing");
installGlobalDiagnostics();
root.textContent = "Restoring session… (Восстановление сессии…)";

try {
  const restored = await kernel.sessionReady;
  useShellStore.getState().adoptRestoredDocuments(restored.map((document) => document.id));
  if (restored.length) diagnostic("info", "autosave.restore", `Restored ${restored.length} document(s)`);
} catch (error) {
  diagnostic("error", "autosave.restore", error instanceof Error ? error.message : String(error), error);
}

document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") void kernel.autosave.flush(); });
window.addEventListener("beforeunload", () => { void kernel.autosave.flush(); });
createRoot(root).render(<StrictMode><App /></StrictMode>);
