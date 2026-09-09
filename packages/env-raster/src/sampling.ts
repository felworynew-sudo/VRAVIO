/**
 * Premultiplied bilinear sampling — the one function every resampling raster transform reads a
 * source pixel through: Warp/Skew/Distort/Perspective (`transform.ts`'s `meshLayerPixels` and
 * `quadLayerPixels`) and Puppet Warp (`puppet.ts`'s `puppetWarpPixels`).
 *
 * It used to be copied verbatim into both `transform.ts` and `puppet.ts` — CLAUDE.md's own
 * "Дубликат — это два будущих, которые расходятся": puppet.ts's copy needed a performance fix
 * (write into a reused scratch record instead of allocating a fresh tuple per pixel — a real
 * cost measured at hundreds of thousands of calls per Puppet Warp preview frame), and leaving
 * transform.ts with the old allocating copy would have meant redoing the same fix there the
 * next time anyone looked, from a codebase that had already forgotten why. One function, one
 * home; both callers get the fix by construction.
 *
 * Premultiplied because straight per-channel averaging drags the *fully transparent* colour of
 * a corner into the result at a soft edge, which reads as a dark or light fringe — corners are
 * weighted by their own alpha before contributing to red/green/blue, and the four alphas are
 * blended and divided back out at the end.
 */
export interface BilinearSample { r: number; g: number; b: number; a: number }

/** A reusable sample record — allocate one per call site, outside the hot loop, and reuse it
 * across every pixel `sampleBilinearInto` fills. */
export function bilinearSample(): BilinearSample {
  return { r: 0, g: 0, b: 0, a: 0 };
}

/** Fills `out` with the sample at (x, y) — mutates in place rather than returning a new tuple,
 * so a caller sampling every pixel of a warped region does not hand one allocation per pixel to
 * the garbage collector. */
export function sampleBilinearInto(pixels: Uint8ClampedArray, width: number, height: number, x: number, y: number, out: BilinearSample): void {
  const cx = Math.max(0, Math.min(width - 1, x)), cy = Math.max(0, Math.min(height - 1, y));
  const x0 = Math.floor(cx), y0 = Math.floor(cy);
  const x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1);
  const fx = cx - x0, fy = cy - y0;
  const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
  const at00 = (y0 * width + x0) * 4, at10 = (y0 * width + x1) * 4, at01 = (y1 * width + x0) * 4, at11 = (y1 * width + x1) * 4;
  const a00 = pixels[at00 + 3]! / 255, a10 = pixels[at10 + 3]! / 255, a01 = pixels[at01 + 3]! / 255, a11 = pixels[at11 + 3]! / 255;
  const alpha = a00 * w00 + a10 * w10 + a01 * w01 + a11 * w11;
  if (alpha <= 0) { out.r = 0; out.g = 0; out.b = 0; out.a = 0; return; }
  out.r = (pixels[at00]! * a00 * w00 + pixels[at10]! * a10 * w10 + pixels[at01]! * a01 * w01 + pixels[at11]! * a11 * w11) / alpha;
  out.g = (pixels[at00 + 1]! * a00 * w00 + pixels[at10 + 1]! * a10 * w10 + pixels[at01 + 1]! * a01 * w01 + pixels[at11 + 1]! * a11 * w11) / alpha;
  out.b = (pixels[at00 + 2]! * a00 * w00 + pixels[at10 + 2]! * a10 * w10 + pixels[at01 + 2]! * a01 * w01 + pixels[at11 + 2]! * a11 * w11) / alpha;
  out.a = alpha * 255;
}
