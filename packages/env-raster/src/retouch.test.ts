import { describe, expect, it } from "vitest";
import { compositeDodgeBurn, dodgeBurnDab, dodgeBurnStrokeSegment } from "./retouch";
import type { Point } from "./types";

const W = 64, H = 64;
const gray = (value = 128) => {
  const pixels = new Uint8ClampedArray(W * H * 4);
  for (let index = 0; index < pixels.length; index += 4) { pixels[index] = value; pixels[index + 1] = value; pixels[index + 2] = value; pixels[index + 3] = 255; }
  return pixels;
};

/**
 * Reported live: dragging Burn over a face to darken its contours burnt the
 * area to solid black almost immediately, because the old implementation
 * mutated pixels in place and read back its own already-darkened output on
 * every overlapping dab along the stroke — `255 - (255-value)/(1-exposure)`
 * applied repeatedly to its own result converges toward 0 fast, and a
 * stroke's dabs overlap heavily at the default ~12% spacing.
 *
 * GIMP's own Dodge/Burn (verified by reading `app/paint/gimpdodgeburn.c`)
 * and Photoshop's documented Airbrush behaviour both cap a single stroke's
 * effect at the Exposure setting: every dab computes against the same
 * frozen pre-stroke pixel, and how much of that computed effect shows
 * through builds up through accumulated coverage, never past the ceiling.
 */
describe("Dodge/Burn does not compound within one stroke", () => {
  it("many overlapping dabs at the same point go no further than one full dab", () => {
    const base = gray(128);
    const coverage = new Uint8ClampedArray(W * H);
    const point: Point = { x: 32, y: 32 };
    // A single full-coverage dab, hardness 1 so its centre is unambiguously 100% covered.
    dodgeBurnDab(coverage, W, H, point, 20, 0.5, undefined, 1, 0, 1);
    const onceOutput = base.slice();
    compositeDodgeBurn(onceOutput, base, coverage, W, H, { x: 0, y: 0, width: W, height: H }, "burn", "midtones");
    const onceValue = onceOutput[(32 * W + 32) * 4]!;

    // Twenty more dabs stamped on the exact same spot — a stroke that barely moved, or a user
    // holding the brush still, both of which used to burn a spot to black almost instantly.
    for (let repeat = 0; repeat < 20; repeat += 1) dodgeBurnDab(coverage, W, H, point, 20, 0.5, undefined, 1, 0, 1);
    const repeatedOutput = base.slice();
    compositeDodgeBurn(repeatedOutput, base, coverage, W, H, { x: 0, y: 0, width: W, height: H }, "burn", "midtones");
    const repeatedValue = repeatedOutput[(32 * W + 32) * 4]!;

    // Coverage is capped at the exposure ceiling, so the twenty-dab result is identical to the
    // one-dab result at this pixel — not darker, and nowhere near 0.
    expect(repeatedValue).toBe(onceValue);
    expect(repeatedValue).toBeGreaterThan(0);
  });

  it("a stroke with tightly overlapping dabs (tight spacing) still stays above black at moderate exposure", () => {
    const base = gray(160);
    const coverage = new Uint8ClampedArray(W * H);
    // Tight spacing — the default the brush options bar ships with — stamps many overlapping
    // dabs along a short, slow drag back and forth, closer to how a real "trace the contour"
    // gesture behaves than one straight pass.
    let carry = 0;
    for (let pass = 0; pass < 3; pass += 1) {
      const from: Point = { x: 10, y: 32 }, to: Point = { x: 54, y: 32 };
      carry = dodgeBurnStrokeSegment(coverage, W, H, pass % 2 === 0 ? from : to, pass % 2 === 0 ? to : from, 18, 0.5, undefined, 1, 0, 0.8, 0.05, carry);
    }
    const output = base.slice();
    compositeDodgeBurn(output, base, coverage, W, H, { x: 0, y: 0, width: W, height: H }, "burn", "midtones");
    const centre = output[(32 * W + 32) * 4]!;
    expect(centre).toBeGreaterThan(0);
    // The exposure cap (0.92 max inside applyDodgeBurnPixel's own clamp, further weighted by
    // range) means a midtone pixel at 0.5 exposure never reaches pure black.
    expect(centre).toBeGreaterThan(10);
  });

  it("dodge lightens toward white, burn darkens toward black, both bounded", () => {
    const base = gray(128);
    const dodgeCoverage = new Uint8ClampedArray(W * H), burnCoverage = new Uint8ClampedArray(W * H);
    const point: Point = { x: 32, y: 32 };
    dodgeBurnDab(dodgeCoverage, W, H, point, 20, 0.5, undefined, 1, 0, 1);
    dodgeBurnDab(burnCoverage, W, H, point, 20, 0.5, undefined, 1, 0, 1);

    const dodged = base.slice(), burned = base.slice();
    compositeDodgeBurn(dodged, base, dodgeCoverage, W, H, { x: 0, y: 0, width: W, height: H }, "dodge", "midtones");
    compositeDodgeBurn(burned, base, burnCoverage, W, H, { x: 0, y: 0, width: W, height: H }, "burn", "midtones");

    const centre = (32 * W + 32) * 4;
    expect(dodged[centre]!).toBeGreaterThan(base[centre]!);
    expect(dodged[centre]!).toBeLessThanOrEqual(255);
    expect(burned[centre]!).toBeLessThan(base[centre]!);
    expect(burned[centre]!).toBeGreaterThanOrEqual(0);
  });

  it("a pixel the stroke never touched passes through unchanged", () => {
    const base = gray(90);
    const coverage = new Uint8ClampedArray(W * H);
    dodgeBurnDab(coverage, W, H, { x: 10, y: 10 }, 6, 0.9, undefined, 1, 0, 1);
    const output = new Uint8ClampedArray(base.length).fill(1); // deliberately garbage, to prove it gets overwritten from `base`
    compositeDodgeBurn(output, base, coverage, W, H, { x: 0, y: 0, width: W, height: H }, "burn", "midtones");
    const untouched = (50 * W + 50) * 4;
    expect(output[untouched]).toBe(base[untouched]);
    expect(output[untouched + 3]).toBe(base[untouched + 3]);
  });

  it("range weights toward the chosen tonal band", () => {
    const dark = gray(30), light = gray(220);
    const coverage = new Uint8ClampedArray(W * H);
    dodgeBurnDab(coverage, W, H, { x: 32, y: 32 }, 20, 0.6, undefined, 1, 0, 1);
    const centre = (32 * W + 32) * 4;

    const shadowsOnDark = dark.slice(); compositeDodgeBurn(shadowsOnDark, dark, coverage, W, H, { x: 0, y: 0, width: W, height: H }, "dodge", "shadows");
    const highlightsOnDark = dark.slice(); compositeDodgeBurn(highlightsOnDark, dark, coverage, W, H, { x: 0, y: 0, width: W, height: H }, "dodge", "highlights");
    // "Shadows" weights toward dark pixels — a dark pixel dodged in shadow-range moves further
    // than the same dark pixel dodged in highlight-range, which barely touches it.
    expect(shadowsOnDark[centre]! - dark[centre]!).toBeGreaterThan(highlightsOnDark[centre]! - dark[centre]!);

    const shadowsOnLight = light.slice(); compositeDodgeBurn(shadowsOnLight, light, coverage, W, H, { x: 0, y: 0, width: W, height: H }, "burn", "shadows");
    const highlightsOnLight = light.slice(); compositeDodgeBurn(highlightsOnLight, light, coverage, W, H, { x: 0, y: 0, width: W, height: H }, "burn", "highlights");
    expect(light[centre]! - highlightsOnLight[centre]!).toBeGreaterThan(light[centre]! - shadowsOnLight[centre]!);
  });
});
