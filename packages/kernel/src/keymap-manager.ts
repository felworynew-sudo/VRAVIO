import type { Disposable } from "./types";

export interface KeyboardShortcutEvent {
  readonly code: string;
  readonly key?: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

export interface KeyBinding {
  readonly commandId: string;
  readonly shortcut: string;
  readonly scope: string;
}

const modifierOrder = ["Mod", "Alt", "Shift"] as const;

function normalizeKeyToken(token: string): string {
  const lower = token.trim().toLocaleLowerCase();
  if (lower === "+" || lower === "plus") return "Plus";
  if (lower === "-" || lower === "minus") return "Minus";
  if (lower === "=" || lower === "equal") return "Equal";
  if (lower === "space" || lower === " ") return "Space";
  if (lower === "escape" || lower === "esc") return "Escape";
  return token.trim().length === 1 ? token.trim().toLocaleUpperCase() : token.trim();
}

export function normalizeShortcut(shortcut: string): string {
  const expanded = shortcut.trim().endsWith("++") ? `${shortcut.trim().slice(0, -1)}Plus` : shortcut.trim();
  const tokens = expanded.split("+").map((token) => token.trim()).filter(Boolean);
  const modifiers = new Set<string>();
  let key = "";
  for (const token of tokens) {
    const lower = token.toLocaleLowerCase();
    if (["mod", "ctrl", "control", "cmd", "command", "meta"].includes(lower)) modifiers.add("Mod");
    else if (lower === "alt" || lower === "option") modifiers.add("Alt");
    else if (lower === "shift") modifiers.add("Shift");
    else key = normalizeKeyToken(token);
  }
  if (!key) throw new Error(`Shortcut has no key: ${shortcut}`);
  return [...modifierOrder.filter((modifier) => modifiers.has(modifier)), key].join("+");
}

function physicalKey(event: KeyboardShortcutEvent): { key: string; implicitShift: boolean } {
  if (/^Key[A-Z]$/.test(event.code)) return { key: event.code.slice(3), implicitShift: false };
  if (/^Digit[0-9]$/.test(event.code)) return { key: event.code.slice(5), implicitShift: false };
  if (/^Numpad[0-9]$/.test(event.code)) return { key: event.code.slice(6), implicitShift: false };
  if (event.code === "Equal" || event.code === "NumpadAdd") return { key: event.shiftKey || event.code === "NumpadAdd" ? "Plus" : "Equal", implicitShift: event.shiftKey };
  if (event.code === "Minus" || event.code === "NumpadSubtract") return { key: "Minus", implicitShift: false };
  if (event.code === "BracketLeft") return { key: "[", implicitShift: false };
  if (event.code === "BracketRight") return { key: "]", implicitShift: false };
  if (event.code === "Semicolon") return { key: ";", implicitShift: false };
  if (event.code === "Space") return { key: "Space", implicitShift: false };
  if (event.code === "Escape") return { key: "Escape", implicitShift: false };
  return { key: normalizeKeyToken(event.key ?? event.code), implicitShift: false };
}

export function shortcutFromEvent(event: KeyboardShortcutEvent): string {
  const { key, implicitShift } = physicalKey(event);
  const tokens: string[] = [];
  if (event.ctrlKey || event.metaKey) tokens.push("Mod");
  if (event.altKey) tokens.push("Alt");
  if (event.shiftKey && !implicitShift) tokens.push("Shift");
  tokens.push(key);
  return tokens.join("+");
}

export class KeymapManager {
  readonly #bindings = new Map<string, KeyBinding>();
  readonly #listeners = new Set<() => void>();

  bind(commandId: string, shortcut: string, scope = "global"): Disposable {
    const binding = { commandId, shortcut: normalizeShortcut(shortcut), scope };
    this.#bindings.set(commandId, binding);
    this.#notify();
    return { dispose: () => { if (this.#bindings.get(commandId) === binding) { this.#bindings.delete(commandId); this.#notify(); } } };
  }

  unbind(commandId: string): boolean {
    const removed = this.#bindings.delete(commandId);
    if (removed) this.#notify();
    return removed;
  }

  get(commandId: string): KeyBinding | undefined { return this.#bindings.get(commandId); }
  list(): readonly KeyBinding[] { return [...this.#bindings.values()]; }

  resolve(event: KeyboardShortcutEvent, scopes: readonly string[] = ["global"]): string | null {
    const shortcut = shortcutFromEvent(event);
    const scopeSet = new Set(scopes);
    const bindings = [...this.#bindings.values()].reverse();
    const exact = bindings.find((binding) => scopeSet.has(binding.scope) && binding.shortcut === shortcut);
    if (exact) return exact.commandId;
    // A bare-letter binding (no modifiers of its own, e.g. tool-group letters like "M") also
    // answers Shift+<letter>: Photoshop's convention for cycling within the group, layered onto
    // plain selection rather than declared as a second shortcut. Anything with Ctrl or Alt held
    // is a different shortcut outright, so this only ever applies to Shift alone.
    if (event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
      // A plain object, not a spread of `event`: DOM Event fields are prototype accessors, not
      // own enumerable properties, so `{ ...event }` silently drops all of them.
      const bare = shortcutFromEvent({ code: event.code, ...(event.key !== undefined ? { key: event.key } : {}), ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey, shiftKey: false });
      return bindings.find((binding) => scopeSet.has(binding.scope) && binding.shortcut === bare && !binding.shortcut.includes("+"))?.commandId ?? null;
    }
    return null;
  }

  conflicts(shortcut: string, scope = "global"): readonly KeyBinding[] {
    const normalized = normalizeShortcut(shortcut);
    return this.list().filter((binding) => binding.scope === scope && binding.shortcut === normalized);
  }

  /** Notifies on every bind/unbind, so UI listing the keymap (Settings) can stay live. */
  subscribe(listener: () => void): Disposable {
    this.#listeners.add(listener);
    return { dispose: () => this.#listeners.delete(listener) };
  }

  #notify(): void { for (const listener of this.#listeners) listener(); }
}

