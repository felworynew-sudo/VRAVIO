import { describe, expect, it } from "vitest";
import { brushPresets } from "./registry";
import { toolById } from "../../tools";

/**
 * Stage 10 of docs/migration-plan.md. The presets were three hard-coded
 * buttons; what a catalogue buys is that they can now be checked, and this is
 * the check that was impossible before.
 */

/** Every option the brush family actually offers. */
const brushOptionIds = new Set((toolById("raster.brush")?.options ?? []).map((option) => option.id));

describe("brush presets", () => {
  it("found the definition files", () => {
    expect(brushPresets.length).toBeGreaterThan(0);
  });

  it("gives every preset its own id and its own place in the order", () => {
    expect(new Set(brushPresets.map((preset) => preset.id)).size).toBe(brushPresets.length);
    expect(new Set(brushPresets.map((preset) => preset.order)).size).toBe(brushPresets.length);
  });

  it("sets only options the brush actually has", () => {
    // The failure this catches: a preset naming an option that has been renamed
    // or removed. Nothing throws — `setToolOption` stores it happily and the
    // brush never reads it — so the preset button just quietly does less than
    // it says. Before the catalogue there was nothing to check it against.
    expect(brushOptionIds.size, "the brush declares no options to check against").toBeGreaterThan(0);
    for (const preset of brushPresets) {
      for (const option of Object.keys(preset.options)) {
        expect(brushOptionIds.has(option), `preset "${preset.id}" sets "${option}", which the brush does not have`).toBe(true);
      }
    }
  });

  it("gives every preset something to set", () => {
    // A preset that sets nothing is a button that does nothing.
    for (const preset of brushPresets) expect(Object.keys(preset.options).length, preset.id).toBeGreaterThan(0);
  });

  it("stays inside each option's declared range", () => {
    // A hardness of 150 is not a stronger brush; it is a preset that will be
    // clamped somewhere far from here, and the button will feel broken.
    const options = new Map((toolById("raster.brush")?.options ?? []).map((option) => [option.id, option]));
    for (const preset of brushPresets) {
      for (const [id, value] of Object.entries(preset.options)) {
        const spec = options.get(id);
        if (!spec || spec.type !== "number" || typeof value !== "number") continue;
        if (spec.min !== undefined) expect(value, `${preset.id}.${id}`).toBeGreaterThanOrEqual(spec.min);
        if (spec.max !== undefined) expect(value, `${preset.id}.${id}`).toBeLessThanOrEqual(spec.max);
      }
    }
  });
});
