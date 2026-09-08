import type { PluginModule } from "../types";

/**
 * The raster sample plugin, and the whole plugin contract demonstrated in one
 * file.
 *
 * Section 4.7 of docs/migration-plan.md asks for "плагин-образец в
 * репозитории как живая документация" — living, meaning it is built and tested
 * like everything else rather than pasted into a README where it can rot.
 * `host.test.ts` runs this exact module.
 *
 * What it shows:
 *
 * - A plugin is a module exporting `run`. Nothing else.
 * - It receives a payload only because its manifest asks for `read-document`,
 *   and what it returns is written only because the manifest asks for
 *   `write-document`. Take either away and this file is unchanged — the host
 *   simply stops sending, or stops believing.
 * - It runs in a worker: there is no `document` here, no `window`, and no way
 *   to reach the application's state.
 * - It checks `payload.kind` rather than assuming. A plugin declares one
 *   environment in its manifest and will only ever be offered inside it, but a
 *   plugin that reads a buffer without checking what it is is a plugin that
 *   corrupts something the first time that stops being true.
 * - Alpha is left alone. Inverting it would turn transparent pixels opaque and
 *   the layer would gain a black rectangle where there had been nothing —
 *   the mistake every first inversion makes.
 */
const plugin: PluginModule = {
  run({ payload }) {
    if (!payload?.buffer || payload.kind !== "pixels") return null;
    const out = new Uint8ClampedArray(payload.buffer.slice(0));
    for (let index = 0; index < out.length; index += 4) {
      out[index] = 255 - out[index]!;
      out[index + 1] = 255 - out[index + 1]!;
      out[index + 2] = 255 - out[index + 2]!;
    }
    return { kind: "pixels", buffer: out.buffer as ArrayBuffer, meta: payload.meta };
  },
};

export default plugin;
export const run = plugin.run;

/** The manifest a host would read for this plugin. Kept beside it so the
 * sample is complete: a plugin is a manifest and an entry, not just code. */
export const manifest = {
  id: "sample.invert",
  apiVersion: 2,
  // No parentheses in either language: the main menu resolves a plugin's
  // label through `localized()`, which reads a parenthesised tail as the
  // Russian half and throws the rest away (see App.tsx's `windowMenuItems`
  // for the same trap, found there when the checkmarks vanished).
  label: { en: "Invert — sample plugin", ru: "Инверсия — плагин-образец" },
  environment: "raster",
  permissions: ["read-document", "write-document"],
  entry: "./samples/invert.plugin.ts",
} as const;
