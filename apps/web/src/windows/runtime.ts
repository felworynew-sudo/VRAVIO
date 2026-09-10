import type { EnvironmentKind } from "@vravio/kernel";
import { windowsFor } from "./registry";

/**
 * Which panels are on screen, per environment, across reloads.
 *
 * One implementation where there were two identical ones. The storage keys are
 * unchanged (`vravio.raster-panels.visible`, `vravio.vector-panels.visible`) —
 * both copies already followed this pattern, and changing it would silently
 * reset the panel layout of anyone who has used the application before.
 *
 * The two event pairs became one: a listener that wants to know about panels
 * no longer has to subscribe twice and remember which name belongs to which
 * environment, and a new environment gets its events by existing.
 */
const storageKey = (kind: EnvironmentKind | string): string => `vravio.${kind}-panels.visible`;

/** Fired when something asks for a panel to be shown or hidden. */
export const PANEL_REQUEST_EVENT = "vravio-panel-visibility-request";
/** Fired once the change has been stored. */
export const PANEL_CHANGED_EVENT = "vravio-panel-visibility-changed";

export interface PanelVisibilityDetail { readonly kind: string; readonly id: string; readonly visible: boolean }

const knownKey = (kind: EnvironmentKind | string): string => `vravio.${kind}-panels.known`;

function defaults(kind: EnvironmentKind | string): Set<string> {
  return new Set(windowsFor(kind).filter((definition) => definition.defaultVisible).map((definition) => definition.id));
}

function readIdArray(key: string): Set<string> | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null") as unknown;
    if (Array.isArray(value)) return new Set(value.filter((id): id is string => typeof id === "string"));
  } catch { /* invalid layouts fall back to null */ }
  return null;
}

/**
 * Reconciles a saved layout with the current catalogue — CLAUDE.md §4's own rule, written down
 * after a panel that fell out of a group (or a new tool that never joined one) went unseen by
 * anyone who had already saved a layout: "new joins, vanished drops, and the reconciliation is
 * its own thing to test, because live it only shows up releases later."
 *
 * The stored *visible* list alone cannot tell "the user hid this" apart from "this panel did not
 * exist yet" — both look like "absent from the list". A second, separate record of every id this
 * browser has ever seen for the kind is what tells them apart: an id missing from *that* one is
 * genuinely new and adopts its own `defaultVisible`, while an id present in it but missing from
 * the visible list was a deliberate hide and stays hidden.
 */
export function readVisiblePanelIds(kind: EnvironmentKind | string): Set<string> {
  const catalogue = windowsFor(kind);
  const catalogueIds = new Set(catalogue.map((definition) => definition.id));
  const stored = readIdArray(storageKey(kind));
  if (!stored) return defaults(kind);

  const known = readIdArray(knownKey(kind)) ?? stored;
  const reconciled = new Set([...stored].filter((id) => catalogueIds.has(id))); // drop vanished panels
  for (const definition of catalogue) if (!known.has(definition.id) && definition.defaultVisible) reconciled.add(definition.id); // adopt new ones' own default

  // Persisted immediately so the diff against `known` never runs twice for the same panel —
  // the second read would otherwise see it as "already known" and skip adopting its default.
  localStorage.setItem(storageKey(kind), JSON.stringify([...reconciled]));
  localStorage.setItem(knownKey(kind), JSON.stringify([...catalogueIds]));
  return reconciled;
}

export function persistVisiblePanelIds(kind: EnvironmentKind | string, ids: Iterable<string>): void {
  localStorage.setItem(storageKey(kind), JSON.stringify([...ids]));
  window.dispatchEvent(new Event(PANEL_CHANGED_EVENT));
}

export function requestPanelVisibility(kind: EnvironmentKind | string, id: string, visible: boolean): void {
  const ids = readVisiblePanelIds(kind);
  if (visible) ids.add(id); else ids.delete(id);
  persistVisiblePanelIds(kind, ids);
  window.dispatchEvent(new CustomEvent<PanelVisibilityDetail>(PANEL_REQUEST_EVENT, { detail: { kind, id, visible } }));
}
