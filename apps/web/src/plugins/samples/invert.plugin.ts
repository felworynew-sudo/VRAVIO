import type { PluginModule } from "../types";

/**
 * The sample plugin, and the whole plugin contract demonstrated in one file.
 *
 * Section 4.7 of docs/migration-plan.md asks for "плагин-образец в
 * репозитории как живая документация" — living, meaning it is built and tested
 * like everything else rather than pasted into a README where it can rot.
 * `host.test.ts` runs this exact module.
 *
 * What it shows:
 *
 * - A plugin is a module exporting `run`. Nothing else.
 * - It receives pixels only because its manifest asks for `read-document`, and
 *   what it returns is written only because the manifest asks for
 *   `write-pixels`. Take either away and this file is unchanged — the host
 *   simply stops sending, or stops believing.
 * - It runs in a worker: there is no `document` here, no `window`, and no way
 *   to reach the application's state. A plugin gets the buffer it was handed.
 * - It returns a buffer the same size it was given. The host checks that, so
 *   getting it wrong is an error message rather than a corrupted layer.
 * - Alpha is left alone. Inverting it would turn transparent pixels opaque and
 *   the layer would gain a black rectangle where there had been nothing —
 *   the mistake every first inversion makes.
 */
const plugin: PluginModule = {
  run({ pixels }) {
    if (!pixels) return null;
    const out = pixels.slice();
    for (let index = 0; index < out.length; index += 4) {
      out[index] = 255 - out[index]!;
      out[index + 1] = 255 - out[index + 1]!;
      out[index + 2] = 255 - out[index + 2]!;
    }
    return out;
  },
};

export default plugin;
export const run = plugin.run;

/** The manifest a host would read for this plugin. Kept beside it so the
 * sample is complete: a plugin is a manifest and an entry, not just code. */
export const manifest = {
  id: "sample.invert",
  apiVersion: 1,
  label: { en: "Invert (sample plugin)", ru: "Инверсия (плагин-образец)" },
  environment: "raster",
  permissions: ["read-document", "write-pixels"],
  entry: "./samples/invert.plugin.ts",
} as const;
