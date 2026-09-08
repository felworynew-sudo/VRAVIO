import { useEffect, useRef } from "react";
import type { EnvironmentKind } from "@vravio/kernel";
import { beginBusy } from "../busy";
import { diagnostic } from "../diagnostics";
import { resolveLabel, text } from "../i18n";
import { errorModal } from "../modals/runtime";
import { useShellStore } from "../store";
import { runPlugin } from "./host";
import { pluginById } from "./registry";
import { environmentsWithPluginSurface, pluginSurfaceFor } from "./surfaces";

export const PLUGIN_RUN_EVENT = "vravio-plugin-run";

/**
 * The one place a plugin run happens, for every environment.
 *
 * A workspace calls this with its own `state` and its own `door`, and gets the
 * whole run: refusal, permission-gated read, worker, validation, commit, busy
 * cursor, diagnostics and the error modal. Before this, that sequence lived
 * inside `RasterWorkspace.tsx` — which is why only raster could host a plugin,
 * and why a second environment would have meant a second copy of it to drift
 * out of step with the first (CLAUDE.md section 4: "дубликат — это два
 * будущих, которые разойдутся").
 *
 * What stays per-environment is only what genuinely differs: reading a
 * document into a payload, judging a returned one, and writing it back — all
 * three in that environment's own `PluginSurface`. `door` is passed straight
 * through to it, unexamined; nothing here knows or cares what is in it.
 *
 * The effect re-subscribes when the environment or door identity changes, and
 * reads `state` through a ref so a document edit does not tear the listener
 * down and rebuild it on every revision.
 */
export function usePluginRuns(kind: EnvironmentKind | string | undefined, state: unknown, door: unknown): void {
  const language = useShellStore((shell) => shell.language);
  const latest = useRef({ state, door, language });
  latest.current = { state, door, language };

  useEffect(() => {
    const surface = kind ? pluginSurfaceFor(kind) : undefined;
    if (!surface) return;

    const onRun = (raw: Event) => {
      const detail = (raw as CustomEvent<{ pluginId: string }>).detail;
      const entry = pluginById(detail?.pluginId);
      if (!entry) { diagnostic("warn", "plugin.run", `No plugin registered as "${detail?.pluginId}"`); return; }
      // A run request that reaches the wrong environment's workspace is not an
      // error to report — with two workspaces mounted, each hears every event
      // and only the addressee acts.
      if (entry.manifest.environment !== kind) return;

      const { state: currentState, door: currentDoor, language: currentLanguage } = latest.current;
      const name = resolveLabel(entry.manifest.label, currentLanguage);
      const fail = (message: string) => {
        diagnostic("error", "plugin.run", `${entry.manifest.id}: ${message}`);
        errorModal({
          title: text(currentLanguage, "The plugin could not finish", "Плагин не смог завершить работу"),
          message: `${name}: ${message}`,
        });
      };

      void (async () => {
        const done = beginBusy(name);
        try {
          const sent = await surface.read(currentState, currentDoor);
          if (!sent) { diagnostic("warn", "plugin.run", `${entry.manifest.id}: nothing to send — no active target`); return; }

          const outcome = await runPlugin(entry.manifest, { payload: sent, hostableEnvironments: environmentsWithPluginSurface }, entry.spawn);
          if (outcome.error) { fail(outcome.error); return; }
          if (!outcome.payload) return; // ran, returned nothing, or was not permitted to write

          const rejection = surface.accept(outcome.payload, sent);
          if (rejection) { fail(rejection); return; }
          await surface.commit(outcome.payload, sent, currentState, currentDoor);
        } catch (error) {
          fail(error instanceof Error ? error.message : String(error));
        } finally { done(); }
      })();
    };

    window.addEventListener(PLUGIN_RUN_EVENT, onRun);
    return () => window.removeEventListener(PLUGIN_RUN_EVENT, onRun);
  }, [kind]);
}
