import { kernel } from "../kernel";
import { diagnostic } from "../diagnostics";
import { commandDefinitions } from "../commands/registry";
import { rasterTools } from "../environments/raster/tools/registry";
import { modalDefinitions } from "../modals/registry";
import { environmentsWithWindows, windowsFor } from "../windows/registry";
import { useShellStore } from "../store";
import type { LocalizedText } from "../i18n";

/**
 * What happens before the application can be used, named.
 *
 * Startup used to be one line of text — "Restoring session…" — that stayed put
 * however long any of this took, and said nothing about which part was slow.
 * A user waiting on a session restore, a font enumeration and an asset store
 * opening deserves to know which of the three they are waiting for; so does
 * whoever has to work out why a cold start takes four seconds on someone
 * else's machine.
 *
 * Each stage reports what it found rather than only that it finished. "Fonts:
 * 412 families" is the sort of thing that makes an eventual bug report useful.
 */
export interface StartupStage {
  readonly id: string;
  readonly label: LocalizedText;
  /** Returns a short summary of what it did, shown beside the stage. */
  run(): Promise<string> | string;
}

/**
 * Reading the catalogues.
 *
 * They are already in memory by the time this runs — every registry is an
 * eager glob evaluated when its module loaded — so this is not doing the work,
 * it is reporting it. Naming it as a stage anyway is deliberate: it is the
 * moment a missing or broken definition file would show, and a startup screen
 * that skipped straight from "session" to "ready" would leave the user with no
 * idea the catalogues existed at all.
 */
const catalogues: StartupStage = {
  id: "catalogues",
  label: { en: "Catalogues", ru: "Каталоги" },
  run: () => {
    const windows = environmentsWithWindows.reduce((total, kind) => total + windowsFor(kind).length, 0);
    return `${rasterTools.length} tools · ${commandDefinitions.length} commands · ${windows} panels · ${modalDefinitions.length} modals`;
  },
};

const session: StartupStage = {
  id: "session",
  label: { en: "Restoring session", ru: "Восстановление сессии" },
  run: async () => {
    const restored = await kernel.sessionReady;
    useShellStore.getState().adoptRestoredDocuments(restored.map((document) => document.id));
    // A restored child carries its link to its parent as provenance, but the
    // session around it was never saved. Without this it looks like an ordinary
    // document: applying fails, and it follows revisions of the asset it exists
    // to edit.
    const links = kernel.roundtrip.adoptRestored();
    if (restored.length) diagnostic("info", "autosave.restore", `Restored ${restored.length} document(s)${links.length ? `, ${links.length} linked` : ""}`);
    return restored.length ? `${restored.length} document(s)` : "nothing to restore";
  },
};

const assets: StartupStage = {
  id: "assets",
  label: { en: "Asset store", ru: "Хранилище ассетов" },
  run: async () => {
    await kernel.assetsReady;
    return kernel.platform.capabilities.opfs ? "OPFS" : "in memory";
  },
};

/**
 * Reading the system fonts.
 *
 * Enumerating local fonts needs the user's permission and is slow enough to be
 * worth its own line — and it must never be the reason the editor fails to
 * start. A refusal here is a normal outcome: the application falls back to the
 * fonts the browser has, which is what it did before anyone thought to ask.
 */
const fonts: StartupStage = {
  id: "fonts",
  label: { en: "System fonts", ru: "Системные шрифты" },
  run: async () => {
    if (!kernel.platform.capabilities.localFonts) return "not available in this browser";
    try {
      const families = new Set((await kernel.platform.fonts.listLocalFonts()).map((font) => font.family));
      return families.size ? `${families.size} families` : "none reported";
    } catch {
      return "not permitted";
    }
  },
};

export const startupStages: readonly StartupStage[] = [catalogues, session, assets, fonts];
