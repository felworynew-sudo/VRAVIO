import { describe, expect, it } from "vitest";
import { blendSimpleLayerStack, parseHexColor, type SimpleBlendLayer } from "@vravio/env-raster";
import { BLEND_MODES, blendModeById, neutralColorName } from "../../raster-blend-modes";

/**
 * The New Layer dialog's "Fill with <Mode>-neutral color" claim, measured.
 *
 * Declaring which colour is neutral for which blend mode is exactly the kind
 * of table that is written once from memory and then quietly disagrees with
 * the compositor forever — the dialog would offer a fill that visibly tints
 * the picture, and nothing would fail. So the table is not trusted here: each
 * declared neutral colour is composited over a real picture through this
 * project's own compositor, and the picture has to come back unchanged.
 *
 * Tolerance is one 8-bit step, and it is not slack: "50% grey" is 128, while
 * the true neutral is 127.5 — the half step that cannot be written in eight
 * bits. Photoshop fills with 128 too, so this reproduces Photoshop including
 * that error. The white and black modes are exact.
 */
const WIDTH = 16, HEIGHT = 16;

function picture(): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  for (let index = 0; index < pixels.length; index += 4) {
    const pixel = index / 4;
    pixels[index] = (pixel * 7) % 256;
    pixels[index + 1] = (pixel * 13 + 40) % 256;
    pixels[index + 2] = (pixel * 29 + 90) % 256;
    pixels[index + 3] = 255;
  }
  return pixels;
}

function solid(hex: string): Uint8ClampedArray {
  const { r, g, b } = parseHexColor(hex);
  const pixels = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  for (let index = 0; index < pixels.length; index += 4) { pixels[index] = r; pixels[index + 1] = g; pixels[index + 2] = b; pixels[index + 3] = 255; }
  return pixels;
}

/** The largest per-channel change the covering layer made to the picture. */
function largestChange(mode: string, hex: string): number {
  const base = picture();
  const layers: readonly SimpleBlendLayer[] = [
    { pixels: base, opacity: 1, blendMode: "normal" },
    { pixels: solid(hex), opacity: 1, blendMode: mode },
  ];
  const result = blendSimpleLayerStack(WIDTH, HEIGHT, layers, 0, 0);
  let worst = 0;
  for (let index = 0; index < base.length; index += 1) {
    if (index % 4 === 3) continue;
    worst = Math.max(worst, Math.abs(result[index]! - base[index]!));
  }
  return worst;
}

describe("the New Layer dialog's neutral colours", () => {
  it("covers every blend mode the engine has, once, in Photoshop's order", () => {
    expect(BLEND_MODES.length).toBe(27);
    expect(new Set(BLEND_MODES.map((entry) => entry.id)).size).toBe(27);
    expect(BLEND_MODES[0]!.id).toBe("normal");
    expect(blendModeById.get("softLight")?.en).toBe("Soft Light");
  });

  for (const entry of BLEND_MODES.filter((item) => item.neutral)) {
    it(`leaves the picture alone: ${entry.en} filled with ${neutralColorName(entry.neutral).en}`, () => {
      expect(largestChange(entry.id, entry.neutral!)).toBeLessThanOrEqual(1);
    });
  }

  /**
   * The other half of the claim: a mode declared to have NO neutral colour
   * must really have none, or the dialog is disabling a checkbox that would
   * have worked. White, black and grey are all tried, and all three have to
   * visibly change the picture.
   */
  for (const entry of BLEND_MODES.filter((item) => !item.neutral && item.id !== "normal" && item.id !== "dissolve")) {
    it(`has no neutral colour at all: ${entry.en}`, () => {
      const changes = (["#ffffff", "#000000", "#808080"] as const).map((hex) => largestChange(entry.id, hex));
      expect(Math.min(...changes)).toBeGreaterThan(1);
    });
  }

  /**
   * And the guard that would catch the table drifting the other way: a
   * neutral colour swapped between two modes still has to be wrong. Multiply
   * with black is the blackest case there is.
   */
  it("fails the way it should when a neutral colour is wrong", () => {
    expect(largestChange("multiply", "#000000")).toBeGreaterThan(1);
    expect(largestChange("screen", "#ffffff")).toBeGreaterThan(1);
    expect(largestChange("overlay", "#ffffff")).toBeGreaterThan(1);
  });
});
