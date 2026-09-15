import { layerDocumentPixels, layerPixelsView } from "./layer-bounds";
import { parseHexColor } from "./color";
import type { RasterLayer, RasterRect, RgbaColor } from "./types";

const clampByte = (value: number) => Math.max(0, Math.min(255, Math.round(value)));

function overlayChannels(pixels: Uint8ClampedArray, index: number, red: number, green: number, blue: number, colorAlpha: number, alpha: number): void {
  const sourceAlpha = Math.max(0, Math.min(1, alpha * colorAlpha / 255));
  const destinationAlpha = pixels[index + 3]! / 255;
  const outputAlpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
  if (outputAlpha <= 0) return;
  pixels[index] = clampByte((red * sourceAlpha + pixels[index]! * destinationAlpha * (1 - sourceAlpha)) / outputAlpha);
  pixels[index + 1] = clampByte((green * sourceAlpha + pixels[index + 1]! * destinationAlpha * (1 - sourceAlpha)) / outputAlpha);
  pixels[index + 2] = clampByte((blue * sourceAlpha + pixels[index + 2]! * destinationAlpha * (1 - sourceAlpha)) / outputAlpha);
  pixels[index + 3] = clampByte(outputAlpha * 255);
}

function overlayPixel(pixels: Uint8ClampedArray, index: number, color: RgbaColor, alpha: number): void {
  overlayChannels(pixels, index, color.r, color.g, color.b, color.a, alpha);
}

/**
 * The offsets of a disc of the given radius, in row-major order.
 *
 * The glows sample this shape around every pixel. Deciding membership inside
 * that loop — a `Math.hypot` per candidate, over a square of up to 65x65 —
 * cost more than reading the pixels it selected, and it recomputed the same
 * shape for all two million of them.
 */
function discOffsets(radius: number): Int32Array {
  const limit = radius * radius, offsets: number[] = [];
  for (let dy = -radius; dy <= radius; dy += 1) for (let dx = -radius; dx <= radius; dx += 1) {
    if (dx * dx + dy * dy <= limit) { offsets.push(dx, dy); }
  }
  return Int32Array.from(offsets);
}

function neighborhoodAlpha(source: Uint8ClampedArray, width: number, height: number, x: number, y: number, disc: Int32Array): number {
  let maximum = 0;
  for (let index = 0; index < disc.length; index += 2) {
    const sampleX = x + disc[index]!, sampleY = y + disc[index + 1]!;
    if (sampleX < 0 || sampleY < 0 || sampleX >= width || sampleY >= height) continue;
    const alpha = source[(sampleY * width + sampleX) * 4 + 3]!;
    if (alpha > maximum) maximum = alpha;
  }
  return maximum / 255;
}

function neighborhoodMinimumAlpha(source: Uint8ClampedArray, width: number, height: number, x: number, y: number, disc: Int32Array): number {
  let minimum = 255;
  for (let index = 0; index < disc.length; index += 2) {
    const sampleX = x + disc[index]!, sampleY = y + disc[index + 1]!;
    // Anything past the edge counts as fully transparent, so the glow follows
    // the document border the way it follows the shape's own outline.
    if (sampleX < 0 || sampleY < 0 || sampleX >= width || sampleY >= height) return 0;
    const alpha = source[(sampleY * width + sampleX) * 4 + 3]!;
    if (alpha < minimum) minimum = alpha;
  }
  return minimum / 255;
}

/**
 * The rectangle of a layer's own content an effect needs to read to correctly paint a given
 * output rectangle — GEGL's `get_required_for_output`, applied to this file's five spatial
 * effects (docs/master-plan.md §37.3 item 2). Deliberately a different question from `render.ts`'s
 * `signatureInkRegion` ("how far can this effect's ink bleed, for invalidation"), not the same
 * computation under two names: `innerShadow`/`innerGlow`/`bevel` never paint outside a layer's own
 * opaque footprint, so `signatureInkRegion` correctly treats them as non-expanding for that
 * purpose — but they still *read* a shifted or neighbouring pixel (below), so a cropped render
 * still needs the wider input or it silently darkens/dims near the crop's own edge, not the
 * layer's. `gradientOverlay`/`glass` read no neighbour at all, so they need no expansion here.
 */
export function requiredSourceRegion(layer: RasterLayer, outputRegion: RasterRect, documentWidth: number, documentHeight: number): RasterRect {
  const effects = layer.effects ?? {};
  let left = outputRegion.x, top = outputRegion.y;
  let right = outputRegion.x + outputRegion.width, bottom = outputRegion.y + outputRegion.height;
  const include = (x: number, y: number, width: number, height: number) => {
    left = Math.min(left, x); top = Math.min(top, y);
    right = Math.max(right, x + width); bottom = Math.max(bottom, y + height);
  };
  const shift = (offsetX: number, offsetY: number) => include(outputRegion.x - Math.round(offsetX), outputRegion.y - Math.round(offsetY), outputRegion.width, outputRegion.height);
  const grow = (radius: number) => include(outputRegion.x - radius, outputRegion.y - radius, outputRegion.width + radius * 2, outputRegion.height + radius * 2);
  if (effects.dropShadow?.enabled) shift(effects.dropShadow.offsetX, effects.dropShadow.offsetY);
  if (effects.innerShadow?.enabled) shift(effects.innerShadow.offsetX, effects.innerShadow.offsetY);
  if (effects.outerGlow?.enabled) grow(Math.max(1, Math.min(32, Math.round(effects.outerGlow.radius))));
  if (effects.innerGlow?.enabled) grow(Math.max(1, Math.min(32, Math.round(effects.innerGlow.radius))));
  if (effects.bevel?.enabled) grow(1);
  const x = Math.max(0, left), y = Math.max(0, top);
  const clampedRight = Math.min(documentWidth, right), clampedBottom = Math.min(documentHeight, bottom);
  return { x, y, width: Math.max(0, clampedRight - x), height: Math.max(0, clampedBottom - y) };
}

interface RenderedEffects { readonly effects: unknown; readonly width: number; readonly height: number; readonly output: Uint8ClampedArray; readonly pixelsRevision: number }

/**
 * The last rendered surface for a given layer.
 *
 * The compositor works in tiles, and each tile asks for the whole layer's
 * effects: a viewport of forty tiles rendered the same document-sized surface
 * forty times, which turned a glow from slow into unusable. Every style edit
 * replaces the effects object, and `pixelsRevision` (docs/master-plan.md
 * §37.6.2) is bumped by every path that edits a layer's pixels — together
 * they are enough to know the surface is still the right one, without
 * requiring a fresh buffer *object* on every edit the way keying on
 * `layer.pixels` itself used to. Keyed on the layer, not the buffer: a
 * WeakMap still lets the entry go when the layer does, and a layer is the
 * more stable of the two — `swapLayerRegion`'s undo/redo swap already
 * mutates the same buffer in place when it can, `pixelsRevision` is what
 * tells this cache that happened.
 */
const renderedEffects = new WeakMap<RasterLayer, RenderedEffects>();

/**
 * Produces a temporary rendered surface; source pixels remain untouched.
 *
 * `region`, when given, asks for only that document-space rectangle of the result — the ROI half
 * of the same GEGL-style contract `requiredSourceRegion` above declares for the input side
 * (docs/master-plan.md §37.3 item 2). A region smaller than the full document skips the
 * whole-surface cache below entirely (a partial result is never stored as if it were the full
 * one — the next full-document request still recomputes and caches normally, so this path can
 * only ever save work, never serve stale or incomplete data through the cache). Every existing
 * call site omits `region` and gets today's exact behaviour, unchanged.
 */
export function renderLayerEffects(layer: RasterLayer, width: number, height: number, region?: RasterRect): Uint8ClampedArray {
  const effects = layer.effects ?? {};
  // Allocate only once an effect is actually enabled: the compositor calls this for every
  // layer on every frame, and the no-effects case is by far the most common.
  // Glass is rendered by the compositor because it reads the backdrop, not by
  // this source-only layer-style renderer.
  if (!Object.entries(effects).some(([key, effect]) => key !== "glass" && effect?.enabled)) return layerPixelsView(layer);
  const fullRegion = !region || (region.x === 0 && region.y === 0 && region.width === width && region.height === height);
  if (fullRegion) {
    const cached = renderedEffects.get(layer);
    if (cached && cached.effects === layer.effects && cached.width === width && cached.height === height && cached.pixelsRevision === layer.pixelsRevision) return cached.output;
  }
  const outputRegion = fullRegion ? { x: 0, y: 0, width, height } : region!;
  // The rectangle of the layer's own content this call actually needs to read — for the
  // full-document case this is the whole document, same as before; for a cropped `region` it is
  // `region` grown by however far each enabled effect reaches (see `requiredSourceRegion`'s own
  // comment for why this can't just reuse `signatureInkRegion`).
  const sourceRegion = fullRegion ? outputRegion : requiredSourceRegion(layer, outputRegion, width, height);
  // Document space, both in and out. A layer's pixels are stored in the layer's
  // own bounds — the optimisation that took 21 layers from 166 MB to 3.1 MB —
  // so a trimmed layer's buffer has a stride of its own, while everything below
  // (and render.ts's `wholeCanvas` branch, which reads this surface back)
  // addresses it as `y * documentWidth + x`. Reading the layer's buffer at the
  // document's stride sheared the picture and ran off the end of a buffer that
  // was also too short: the "turning on a layer style distorts the layer" the
  // owner reported. The materialised copy is what the WeakMap above caches, so
  // it is paid once per edit, not once per tile — and now, once per requested
  // region on a cache miss, instead of once for the whole document regardless.
  const source = layerDocumentPixels(layer, width, height, fullRegion ? undefined : sourceRegion);
  const srcX = sourceRegion.x, srcY = sourceRegion.y, srcW = sourceRegion.width, srcH = sourceRegion.height;
  const outX = outputRegion.x, outY = outputRegion.y, outW = outputRegion.width, outH = outputRegion.height;
  const output = new Uint8ClampedArray(outW * outH * 4);
  const shadow = effects.dropShadow;
  if (shadow?.enabled) {
    const color = parseHexColor(shadow.color), offsetX = Math.round(shadow.offsetX), offsetY = Math.round(shadow.offsetY);
    for (let oy = 0; oy < outH; oy += 1) for (let ox = 0; ox < outW; ox += 1) {
      const shadowSourceX = outX + ox - offsetX - srcX, shadowSourceY = outY + oy - offsetY - srcY;
      if (shadowSourceX < 0 || shadowSourceY < 0 || shadowSourceX >= srcW || shadowSourceY >= srcH) continue;
      overlayPixel(output, (oy * outW + ox) * 4, color, source[(shadowSourceY * srcW + shadowSourceX) * 4 + 3]! / 255 * shadow.opacity);
    }
  }
  const outer = effects.outerGlow;
  if (outer?.enabled) {
    const color = parseHexColor(outer.color), disc = discOffsets(Math.max(1, Math.min(32, Math.round(outer.radius))));
    for (let oy = 0; oy < outH; oy += 1) for (let ox = 0; ox < outW; ox += 1) {
      const sourceX = outX + ox - srcX, sourceY = outY + oy - srcY, index = (oy * outW + ox) * 4;
      const own = source[(sourceY * srcW + sourceX) * 4 + 3]! / 255;
      if (own >= 1) continue;
      overlayPixel(output, index, color, (neighborhoodAlpha(source, srcW, srcH, sourceX, sourceY, disc) - own) * outer.opacity);
    }
  }
  for (let oy = 0; oy < outH; oy += 1) for (let ox = 0; ox < outW; ox += 1) {
    const sourceX = outX + ox - srcX, sourceY = outY + oy - srcY, sourceIndex = (sourceY * srcW + sourceX) * 4, outputIndex = (oy * outW + ox) * 4;
    overlayChannels(output, outputIndex, source[sourceIndex]!, source[sourceIndex + 1]!, source[sourceIndex + 2]!, 255, source[sourceIndex + 3]! / 255);
  }
  const gradient = effects.gradientOverlay;
  if (gradient?.enabled) {
    // The gradient's phase is relative to the whole document, not to `region` — the same stripe
    // has to land at the same place whichever piece of it is being rendered right now.
    const from = parseHexColor(gradient.from), to = parseHexColor(gradient.to), radians = gradient.angle * Math.PI / 180, dx = Math.cos(radians), dy = Math.sin(radians), extent = Math.max(1, Math.abs(dx) * width + Math.abs(dy) * height);
    for (let oy = 0; oy < outH; oy += 1) for (let ox = 0; ox < outW; ox += 1) {
      const documentX = outX + ox, documentY = outY + oy, sourceX = documentX - srcX, sourceY = documentY - srcY;
      const outputIndex = (oy * outW + ox) * 4; if (!source[(sourceY * srcW + sourceX) * 4 + 3]) continue;
      const t = Math.max(0, Math.min(1, .5 + ((documentX - width / 2) * dx + (documentY - height / 2) * dy) / extent));
      overlayChannels(output, outputIndex, from.r + (to.r - from.r) * t, from.g + (to.g - from.g) * t, from.b + (to.b - from.b) * t, 255, gradient.opacity);
    }
  }
  const innerShadow = effects.innerShadow;
  const innerGlow = effects.innerGlow;
  const bevel = effects.bevel;
  // Parsed once. These used to be re-parsed for every pixel of the layer.
  const innerShadowColor = innerShadow?.enabled ? parseHexColor(innerShadow.color) : null;
  const innerGlowColor = innerGlow?.enabled ? parseHexColor(innerGlow.color) : null;
  const innerGlowDisc = innerGlow?.enabled ? discOffsets(Math.max(1, Math.min(32, Math.round(innerGlow.radius)))) : null;
  const innerShadowOffsetX = innerShadow?.enabled ? Math.round(innerShadow.offsetX) : 0, innerShadowOffsetY = innerShadow?.enabled ? Math.round(innerShadow.offsetY) : 0;
  for (let oy = 0; oy < outH; oy += 1) for (let ox = 0; ox < outW; ox += 1) {
    const sourceX = outX + ox - srcX, sourceY = outY + oy - srcY, outputIndex = (oy * outW + ox) * 4;
    const own = source[(sourceY * srcW + sourceX) * 4 + 3]! / 255; if (own <= 0) continue;
    if (innerShadow?.enabled && innerShadowColor) {
      const shiftedX = sourceX - innerShadowOffsetX, shiftedY = sourceY - innerShadowOffsetY;
      const shifted = shiftedX < 0 || shiftedY < 0 || shiftedX >= srcW || shiftedY >= srcH ? 0 : source[(shiftedY * srcW + shiftedX) * 4 + 3]! / 255;
      overlayPixel(output, outputIndex, innerShadowColor, own * (1 - shifted) * innerShadow.opacity);
    }
    if (innerGlow?.enabled && innerGlowColor && innerGlowDisc) {
      const edge = 1 - neighborhoodMinimumAlpha(source, srcW, srcH, sourceX, sourceY, innerGlowDisc);
      overlayPixel(output, outputIndex, innerGlowColor, Math.max(0, edge) * innerGlow.opacity);
    }
    if (bevel?.enabled) {
      const left = sourceX > 0 ? source[(sourceY * srcW + sourceX - 1) * 4 + 3]! : 0, top = sourceY > 0 ? source[((sourceY - 1) * srcW + sourceX) * 4 + 3]! : 0;
      const shade = ((left + top) / 510 - own) * bevel.strength;
      const channel = shade >= 0 ? 255 : 0;
      overlayChannels(output, outputIndex, channel, channel, channel, 255, Math.min(1, Math.abs(shade)));
    }
  }
  if (fullRegion) {
    // Keyed on the layer itself, not the materialised copy: that copy is new
    // every call, so keying on it would cache nothing and hold the entry alive
    // by its only reference.
    renderedEffects.set(layer, { effects: layer.effects, width, height, output, pixelsRevision: layer.pixelsRevision });
  }
  return output;
}
