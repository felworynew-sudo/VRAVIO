import type { PluginModule } from "../types";

/**
 * The audio sample plugin — the same contract as `invert.plugin.ts`, in a
 * different environment, with nothing in `plugins/` changed to allow it.
 *
 * That is what it is here to demonstrate: the host, the worker, the permission
 * checks and the registry are the same code for both, because none of them
 * looks inside a payload. What differs is entirely in
 * `environments/audio/plugins/surface.ts`, which is the audio environment's own
 * file, in the audio environment's own directory.
 *
 * Halves the amplitude (−6 dB), and clamps — a plugin cannot be trusted to
 * stay in range, but neither should it hand back samples that will clip when
 * they are written into a clip.
 */
const plugin: PluginModule = {
  run({ payload, options }) {
    if (!payload?.buffer || payload.kind !== "samples") return null;
    const gain = typeof options.gain === "number" ? options.gain : 0.5;
    const samples = new Float32Array(payload.buffer.slice(0));
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = Math.max(-1, Math.min(1, samples[index]! * gain));
    }
    return { kind: "samples", buffer: samples.buffer as ArrayBuffer, meta: payload.meta };
  },
};

export default plugin;
export const run = plugin.run;

export const manifest = {
  id: "sample.gain",
  apiVersion: 2,
  // See invert.plugin.ts: a parenthesised tail would be eaten by `localized()`.
  label: { en: "Halve volume — sample plugin", ru: "Убавить громкость вдвое — плагин-образец" },
  environment: "audio",
  permissions: ["read-document", "write-document"],
  entry: "./samples/gain.plugin.ts",
} as const;
