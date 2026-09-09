import { useEffect, useState } from "react";

/**
 * Turns one of the project's own icon files into a CSS `cursor` value.
 *
 * The reason this exists rather than `cursor: url("/ИКОНКА.svg") 16 16`: a
 * browser refuses a cursor image past roughly 128x128 and silently falls back
 * to whatever comes after the comma — no error, no warning, just the ordinary
 * pointer. The icons in this project are authored large (the clipping-mask
 * cursor is 640x320), so every one of them used that way is inert. The file is
 * fetched once and its `width`/`height` rewritten to a cursor-sized pair; the
 * `viewBox` carries the drawing, so nothing else has to change and the icon
 * file itself is never touched — `icons/` is off limits by project rule, and
 * copying an icon's path data into code would be the "two futures that
 * diverge" duplicate CLAUDE.md §4 warns about.
 *
 * Not the same thing as `move.tsx`'s `buildArrowCursor`, which draws its glyph
 * inline: that one has no asset behind it, this one does.
 */

interface CursorImage { readonly image: string; readonly width: number; readonly height: number }

const cache = new Map<string, Promise<CursorImage | null>>();

/** Rewrites the root `<svg>`'s width/height, keeping its aspect ratio and viewBox. */
function resizeSvg(markup: string, longestSide: number): { markup: string; width: number; height: number } | null {
  const openTag = markup.match(/<svg\b[^>]*>/i)?.[0];
  if (!openTag) return null;
  const width = Number(openTag.match(/\bwidth="([\d.]+)"/i)?.[1]);
  const height = Number(openTag.match(/\bheight="([\d.]+)"/i)?.[1]);
  const scale = width > 0 && height > 0 ? longestSide / Math.max(width, height) : 1;
  const scaled = width > 0 && height > 0
    ? { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
    : { width: longestSide, height: longestSide };
  const resized = openTag
    .replace(/\bwidth="[^"]*"/i, `width="${scaled.width}"`)
    .replace(/\bheight="[^"]*"/i, `height="${scaled.height}"`);
  return { markup: markup.replace(openTag, resized), ...scaled };
}

async function loadCursorImage(url: string, longestSide: number): Promise<CursorImage | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const markup = await response.text();
    // A dev server answers any unknown path with index.html and a 200 (CLAUDE.md
    // §4), so "it responded" is not "the icon is there".
    if (!markup.includes("<svg")) return null;
    const resized = resizeSvg(markup, longestSide);
    return resized && { image: `data:image/svg+xml,${encodeURIComponent(resized.markup)}`, width: resized.width, height: resized.height };
  } catch {
    return null;
  }
}

/**
 * The cursor value for an icon, or `undefined` until it has loaded (and for
 * good if it cannot) — so a caller spreads it into a style and gets the normal
 * cursor in the meantime, never a broken one.
 */
export function useIconCursor(url: string, options: { size?: number; hotspot?: "center" | "topLeft"; fallback?: string } = {}): string | undefined {
  const { size = 28, hotspot = "center", fallback = "pointer" } = options;
  const key = `${url}@${size}`;
  const [image, setImage] = useState<CursorImage | null>(null);

  useEffect(() => {
    let cancelled = false;
    let pending = cache.get(key);
    if (!pending) { pending = loadCursorImage(url, size); cache.set(key, pending); }
    void pending.then((value) => { if (!cancelled) setImage(value); });
    return () => { cancelled = true; };
  }, [key, url, size]);

  if (!image) return undefined;
  // Computed from the *resized* image rather than passed in: the icons are not
  // square (this one is 2:1), so a hand-written pair is wrong the moment an
  // icon's aspect changes, and a hotspot outside the image is left to the
  // browser to clamp.
  const x = hotspot === "center" ? Math.round(image.width / 2) : 0;
  const y = hotspot === "center" ? Math.round(image.height / 2) : 0;
  return `url("${image.image}") ${x} ${y}, ${fallback}`;
}
