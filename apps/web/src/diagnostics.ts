export interface DiagnosticEntry { time: string; level: "info" | "warn" | "error"; area: string; message: string; detail?: string }

const STORAGE_KEY = "vravio.diagnostics.v1";
const LIMIT = 250;

export function readDiagnostics(): DiagnosticEntry[] {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as DiagnosticEntry[]; } catch { return []; }
}

/**
 * Whether there is a browser to record into and announce to.
 *
 * This module's whole promise is that diagnostics never break anything, and it
 * was breaking the thing it is least allowed to: outside a browser — under
 * vitest, and eventually in a worker — `window` is simply not defined, so a
 * `dispatchEvent` threw a ReferenceError straight through whatever had just
 * tried to report a problem. Recording a diagnostic must not be the reason a
 * caller fails.
 */
const inBrowser = typeof window !== "undefined";

export function diagnostic(level: DiagnosticEntry["level"], area: string, message: string, detail?: unknown): void {
  const serialized = detail instanceof Error ? `${detail.name}: ${detail.message}\n${detail.stack ?? ""}` : detail === undefined ? undefined : typeof detail === "string" ? detail : JSON.stringify(detail);
  const entries = readDiagnostics(); entries.push({ time: new Date().toISOString(), level, area, message, ...(serialized ? { detail: serialized } : {}) });
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(-LIMIT))); } catch { /* Diagnostics must never break editing. */ }
  if (inBrowser) window.dispatchEvent(new Event("vravio-diagnostics-change"));
  if (level === "error") console.error(`[VRAVIO:${area}] ${message}`, detail); else if (level === "warn") console.warn(`[VRAVIO:${area}] ${message}`, detail);
}

export function clearDiagnostics(): void { localStorage.removeItem(STORAGE_KEY); if (inBrowser) window.dispatchEvent(new Event("vravio-diagnostics-change")); }

export function installGlobalDiagnostics(): () => void {
  const error = (event: ErrorEvent) => diagnostic("error", "window", event.message, event.error ?? `${event.filename}:${event.lineno}:${event.colno}`);
  const rejection = (event: PromiseRejectionEvent) => diagnostic("error", "promise", "Unhandled promise rejection", event.reason);
  window.addEventListener("error", error); window.addEventListener("unhandledrejection", rejection);
  return () => { window.removeEventListener("error", error); window.removeEventListener("unhandledrejection", rejection); };
}
