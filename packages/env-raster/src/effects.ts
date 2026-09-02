import { parseHexColor } from "./color";
import type { RasterLayer, RgbaColor } from "./types";

const clampByte = (value: number) => Math.max(0, Math.min(255, Math.round(value)));

function overlayPixel(pixels: Uint8ClampedArray, index: number, color: RgbaColor, alpha: number): void {
  const sourceAlpha = Math.max(0, Math.min(1, alpha * color.a / 255));
  const destinationAlpha = pixels[index + 3]! / 255;
  const outputAlpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
  if (outputAlpha <= 0) return;
  pixels[index] = clampByte((color.r * sourceAlpha + pixels[index]! * destinationAlpha * (1 - sourceAlpha)) / outputAlpha);
  pixels[index + 1] = clampByte((color.g * sourceAlpha + pixels[index + 1]! * destinationAlpha * (1 - sourceAlpha)) / outputAlpha);
  pixels[index + 2] = clampByte((color.b * sourceAlpha + pixels[index + 2]! * destinationAlpha * (1 - sourceAlpha)) / outputAlpha);
  pixels[index + 3] = clampByte(outputAlpha * 255);
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

interface RenderedEffects { readonly effects: unknown; readonly width: number; readonly height: number; readonly output: Uint8ClampedArray }

/**
 * The last rendered surface for a given pixel buffer.
 *
 * The compositor works in tiles, and each tile asks for the whole layer's
 * effects: a viewport of forty tiles rendered the same document-sized surface
 * forty times, which turned a glow from slow into unusable. Every path that
 * edits a layer assigns it a fresh buffer and every style edit replaces the
 * effects object, so buffer identity plus effects identity is enough to know
 * the surface is still the right one. A WeakMap lets the entry go when the
 * buffer does.
 */
const renderedEffects = new WeakMap<Uint8ClampedArray, RenderedEffects>();

/** Produces a temporary rendered surface; source pixels remain untouched. */
export function renderLayerEffects(layer: RasterLayer, width: number, height: number): Uint8ClampedArray {
  const source = layer.pixels, effects = layer.effects ?? {};
  // Allocate only once an effect is actually enabled: the compositor calls this for every
  // layer on every frame, and the no-effects case is by far the most common.
  if (!Object.values(effects).some((effect) => effect?.enabled)) return source;
  const cached = renderedEffects.get(source);
  if (cached && cached.effects === layer.effects && cached.width === width && cached.height === height) return cached.output;
  const output = new Uint8ClampedArray(source.length);
  const shadow = effects.dropShadow;
  if (shadow?.enabled) {
    const color = parseHexColor(shadow.color);
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
      const sourceX = x - Math.round(shadow.offsetX), sourceY = y - Math.round(shadow.offsetY);
      if (sourceX < 0 || sourceY < 0 || sourceX >= width || sourceY >= height) continue;
      overlayPixel(output, (y * width + x) * 4, color, source[(sourceY * width + sourceX) * 4 + 3]! / 255 * shadow.opacity);
    }
  }
  const outer = effects.outerGlow;
  if (outer?.enabled) {
    const color = parseHexColor(outer.color), disc = discOffsets(Math.max(1, Math.min(32, Math.round(outer.radius))));
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4, own = source[index + 3]! / 255;
      if (own >= 1) continue;
      overlayPixel(output, index, color, (neighborhoodAlpha(source, width, height, x, y, disc) - own) * outer.opacity);
    }
  }
  for (let index = 0; index < source.length; index += 4) overlayPixel(output, index, { r: source[index]!, g: source[index + 1]!, b: source[index + 2]!, a: 255 }, source[index + 3]! / 255);
  const gradient = effects.gradientOverlay;
  if (gradient?.enabled) {
    const from = parseHexColor(gradient.from), to = parseHexColor(gradient.to), radians = gradient.angle * Math.PI / 180, dx = Math.cos(radians), dy = Math.sin(radians), extent = Math.max(1, Math.abs(dx) * width + Math.abs(dy) * height);
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4; if (!source[index + 3]) continue;
      const t = Math.max(0, Math.min(1, .5 + ((x - width / 2) * dx + (y - height / 2) * dy) / extent));
      overlayPixel(output, index, { r: from.r + (to.r - from.r) * t, g: from.g + (to.g - from.g) * t, b: from.b + (to.b - from.b) * t, a: 255 }, gradient.opacity);
    }
  }
  const innerShadow = effects.innerShadow;
  const innerGlow = effects.innerGlow;
  const bevel = effects.bevel;
  // Parsed once. These used to be re-parsed for every pixel of the layer.
  const innerShadowColor = innerShadow?.enabled ? parseHexColor(innerShadow.color) : null;
  const innerGlowColor = innerGlow?.enabled ? parseHexColor(innerGlow.color) : null;
  const innerGlowDisc = innerGlow?.enabled ? discOffsets(Math.max(1, Math.min(32, Math.round(innerGlow.radius)))) : null;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const index = (y * width + x) * 4, own = source[index + 3]! / 255; if (own <= 0) continue;
    if (innerShadow?.enabled && innerShadowColor) {
      const shiftedX = x - Math.round(innerShadow.offsetX), shiftedY = y - Math.round(innerShadow.offsetY);
      const shifted = shiftedX < 0 || shiftedY < 0 || shiftedX >= width || shiftedY >= height ? 0 : source[(shiftedY * width + shiftedX) * 4 + 3]! / 255;
      overlayPixel(output, index, innerShadowColor, own * (1 - shifted) * innerShadow.opacity);
    }
    if (innerGlow?.enabled && innerGlowColor && innerGlowDisc) {
      const edge = 1 - neighborhoodMinimumAlpha(source, width, height, x, y, innerGlowDisc);
      overlayPixel(output, index, innerGlowColor, Math.max(0, edge) * innerGlow.opacity);
    }
    if (bevel?.enabled) {
      const left = x > 0 ? source[(y * width + x - 1) * 4 + 3]! : 0, top = y > 0 ? source[((y - 1) * width + x) * 4 + 3]! : 0;
      const shade = ((left + top) / 510 - own) * bevel.strength;
      overlayPixel(output, index, shade >= 0 ? { r: 255, g: 255, b: 255, a: 255 } : { r: 0, g: 0, b: 0, a: 255 }, Math.min(1, Math.abs(shade)));
    }
  }
  renderedEffects.set(source, { effects: layer.effects, width, height, output });
  return output;
}
