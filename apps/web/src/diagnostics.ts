export interface DiagnosticEntry { time: string; level: "info" | "warn" | "error"; area: string; message: string; detail?: string }

const STORAGE_KEY = "vravio.diagnostics.v1";
const LIMIT = 250;

export function readDiagnostics(): DiagnosticEntry[] {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as DiagnosticEntry[]; } catch { return []; }
}

export function diagnostic(level: DiagnosticEntry["level"], area: string, message: string, detail?: unknown): void {
  const serialized = detail instanceof Error ? `${detail.name}: ${detail.message}\n${detail.stack ?? ""}` : detail === undefined ? undefined : typeof detail === "string" ? detail : JSON.stringify(detail);
  const entries = readDiagnostics(); entries.push({ time: new Date().toISOString(), level, area, message, ...(serialized ? { detail: serialized } : {}) });
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(-LIMIT))); } catch { /* Diagnostics must never break editing. */ }
  window.dispatchEvent(new Event("vravio-diagnostics-change"));
  if (level === "error") console.error(`[VRAVIO:${area}] ${message}`, detail); else if (level === "warn") console.warn(`[VRAVIO:${area}] ${message}`, detail);
}

export function clearDiagnostics(): void { localStorage.removeItem(STORAGE_KEY); window.dispatchEvent(new Event("vravio-diagnostics-change")); }

export function installGlobalDiagnostics(): () => void {
  const error = (event: ErrorEvent) => diagnostic("error", "window", event.message, event.error ?? `${event.filename}:${event.lineno}:${event.colno}`);
  const rejection = (event: PromiseRejectionEvent) => diagnostic("error", "promise", "Unhandled promise rejection", event.reason);
  window.addEventListener("error", error); window.addEventListener("unhandledrejection", rejection);
  return () => { window.removeEventListener("error", error); window.removeEventListener("unhandledrejection", rejection); };
}
