import type { RasterRect, RasterTextData, RasterTextTransform } from "@vravio/env-raster";

export const identityTextTransform = (): RasterTextTransform => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });

export function multiplyTextTransform(left: RasterTextTransform, right: RasterTextTransform): RasterTextTransform {
  return { a: left.a * right.a + left.c * right.b, b: left.b * right.a + left.d * right.b, c: left.a * right.c + left.c * right.d, d: left.b * right.c + left.d * right.d, e: left.a * right.e + left.c * right.f + left.e, f: left.b * right.e + left.d * right.f + left.f };
}

export function textBoundsTransform(initial: RasterRect, target: RasterRect, rotation: number): RasterTextTransform {
  const scaleX = target.width / Math.max(1, initial.width), scaleY = target.height / Math.max(1, initial.height);
  const scale = { a: scaleX, b: 0, c: 0, d: scaleY, e: target.x - initial.x * scaleX, f: target.y - initial.y * scaleY };
  if (!rotation) return scale;
  const radians = rotation * Math.PI / 180, cosine = Math.cos(radians), sine = Math.sin(radians), cx = target.x + target.width / 2, cy = target.y + target.height / 2;
  return multiplyTextTransform({ a: cosine, b: sine, c: -sine, d: cosine, e: cx - cosine * cx + sine * cy, f: cy - sine * cx - cosine * cy }, scale);
}

/** Builds the CSS `font` shorthand Canvas2D expects, honoring bold/italic. Horizontal/vertical
 *  scale are deliberately not part of this string — the `font` shorthand has no scale field, so
 *  they are applied as a `context.scale()` around each draw call instead (see `withGlyphTransform`). */
export function textFontString(text: Pick<RasterTextData, "fontFamily" | "fontSize" | "bold" | "italic">): string {
  return `${text.italic ? "italic " : ""}${text.bold ? "700 " : ""}${text.fontSize}px ${text.fontFamily}`;
}

/** A font's synthesised sub/superscript, when it has no dedicated glyphs for either — the same
 *  trade every text engine without real OpenType subs/sups support makes: shrink and shift. */
const SUPERSCRIPT_SCALE = 0.65834;

/** How far `superscript`/`subscript` shift the glyph's own baseline, as a fraction of font size —
 *  matched to Photoshop's own defaults (Position: Superscript/Subscript at their default Size
 *  58.3% and Position 33.3%, close enough that a mixed document does not look foreign). */
const SUPERSCRIPT_SHIFT = 0.33;

/** The text actually drawn for one run — `allCaps` rewrites the string (no separate glyph set to
 *  switch to), everything else about shaping is left to the canvas context's own properties. */
function displayText(text: Pick<RasterTextData, "allCaps">, value: string): string {
  return text.allCaps ? value.toLocaleUpperCase() : value;
}

/** Applies horizontal/vertical scale and super/subscript's shrink-and-shift around `x, y`, draws
 *  `run` through `draw` in that transformed space, and restores. `draw` receives (0, 0) — the
 *  anchor is `x, y` in the untransformed space either way, so scale/shift never moves where the
 *  caller thinks it put the text. */
function withGlyphTransform(context: CanvasRenderingContext2D, text: RasterTextData, x: number, y: number, draw: (localX: number, localY: number) => void): void {
  const hScale = (text.horizontalScale ?? 100) / 100, vScale = (text.verticalScale ?? 100) / 100;
  const subSup = text.superscript ? -1 : text.subscript ? 1 : 0;
  const scale = subSup ? SUPERSCRIPT_SCALE : 1;
  const shift = subSup * SUPERSCRIPT_SHIFT * text.fontSize;
  const baselineShift = -(text.baselineShift ?? 0);
  if (hScale === 1 && vScale === 1 && scale === 1 && baselineShift === 0 && shift === 0) { draw(x, y); return; }
  context.save();
  context.translate(x, y);
  context.scale(hScale * scale, vScale * scale);
  draw(0, (baselineShift + shift) / (vScale * scale));
  context.restore();
}

/** Word-wraps one paragraph (no `\n` inside `value`) into lines that fit `boxWidth`, breaking
 *  mid-word only when a single word alone overflows it — optionally showing a hyphen at that
 *  forced break (`hyphenate`; see `RasterTextData.hyphenate`'s own doc comment on what this is
 *  not: no dictionary, no linguistically correct break point). */
function wrapParagraphLines(context: CanvasRenderingContext2D, value: string, boxWidth: number, hyphenate: boolean): string[] {
  const rawLines: string[] = [];
  const words = value.split(" ");
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (context.measureText(candidate).width <= boxWidth || !current) { current = candidate; continue; }
    rawLines.push(current); current = word;
  }
  rawLines.push(current);

  // A single word too wide for boxWidth on its own still has to go somewhere — break it letter by
  // letter, with an optional trailing hyphen at the break. `rawLines`' own loop above only ever
  // lets a line grow past boxWidth this way (a lone word with nothing to share the line with), so
  // a line with a space in it never needs this — it was already kept within boxWidth to get here.
  const forceBreak = (word: string): string[] => {
    const broken: string[] = [];
    let piece = "";
    for (const character of word) {
      const withHyphen = hyphenate ? `${piece}${character}-` : `${piece}${character}`;
      if (context.measureText(withHyphen).width <= boxWidth || !piece) { piece += character; continue; }
      broken.push(hyphenate ? `${piece}-` : piece); piece = character;
    }
    broken.push(piece);
    return broken;
  };
  return rawLines.flatMap((line) => !line.includes(" ") && context.measureText(line).width > boxWidth ? forceBreak(line) : [line]);
}

/** Splits `value` into paragraphs (`\n`-separated blocks), each word-wrapped into its own lines —
 *  the shape every paragraph-level feature (indents, justify, list markers, spaceBefore/After)
 *  needs: which lines belong to which paragraph, and which is a paragraph's first/last line. */
function wrapParagraphs(context: CanvasRenderingContext2D, text: RasterTextData, boxWidth: number): string[][] {
  const usable = Math.max(1, boxWidth - (text.indentBefore ?? 0) - (text.indentAfter ?? 0));
  return text.value.split("\n").map((paragraph) => wrapParagraphLines(context, paragraph, usable, Boolean(text.hyphenate)));
}

const listMarker = (text: RasterTextData, paragraphIndex: number): string | null =>
  text.listType === "bullet" ? "•" : text.listType === "number" ? `${paragraphIndex + 1}.` : null;

function quadratic(path: NonNullable<RasterTextData["path"]>, t: number): { x: number; y: number; angle: number } {
  const mt = 1 - t;
  const x = mt * mt * path.start.x + 2 * mt * t * path.control.x + t * t * path.end.x;
  const y = mt * mt * path.start.y + 2 * mt * t * path.control.y + t * t * path.end.y;
  const dx = 2 * mt * (path.control.x - path.start.x) + 2 * t * (path.end.x - path.control.x);
  const dy = 2 * mt * (path.control.y - path.start.y) + 2 * t * (path.end.y - path.control.y);
  return { x, y, angle: Math.atan2(dy, dx) + (path.flip ? Math.PI : 0) };
}

function drawOnPath(context: CanvasRenderingContext2D, text: RasterTextData): void {
  if (!text.path || !text.value) return;
  const characters = [...displayText(text, text.value).replace(/\n/g, " ")];
  const widths = characters.map((character) => context.measureText(character).width + text.letterSpacing);
  const total = widths.reduce((sum, value) => sum + value, 0);
  const chord = Math.max(1, Math.hypot(text.path.end.x - text.path.start.x, text.path.end.y - text.path.start.y));
  if (text.mode === "dynamic" && text.dynamicPreset === "circle") {
    const centerX = (text.path.start.x + text.path.end.x) / 2, centerY = (text.path.start.y + text.path.end.y) / 2;
    const radius = Math.max(text.fontSize, chord / 2), circumference = Math.PI * 2 * radius, scale = Math.min(1, circumference / Math.max(1, total));
    let cursor = -Math.PI / 2 - total * scale / circumference * Math.PI;
    for (let index = 0; index < characters.length; index += 1) {
      const advanceAngle = widths[index]! * scale / radius, angle = cursor + advanceAngle / 2;
      context.save(); context.translate(centerX + Math.cos(angle) * radius, centerY + Math.sin(angle) * radius); context.rotate(angle + Math.PI / 2); context.scale(scale, scale); context.textAlign = "center"; context.textBaseline = "bottom"; context.fillText(characters[index]!, 0, 0); context.restore(); cursor += advanceAngle;
    }
    return;
  }
  const scale = text.mode === "dynamic" ? Math.min(1, chord / Math.max(1, total)) : 1;
  let cursor = text.align === "center" ? (chord - total * scale) / 2 : text.align === "right" ? chord - total * scale : 0;
  for (let index = 0; index < characters.length; index += 1) {
    const advance = widths[index]! * scale, point = quadratic(text.path, Math.max(0, Math.min(1, (cursor + advance / 2) / chord)));
    context.save(); context.translate(point.x, point.y); context.rotate(point.angle); context.scale(scale, scale); context.textAlign = "center"; context.textBaseline = text.path.flip ? "top" : "bottom"; context.fillText(characters[index]!, 0, 0); context.restore(); cursor += advance;
  }
}

/** Draws one already-wrapped line at `(x, y)` (its `align`-anchored origin), honoring
 *  letter-spacing, strikethrough/underline, and — when `justifyWidth` is given — stretching the
 *  gaps between words to fill it (Photoshop's "Justify" family). Returns the line's own drawn
 *  width, which the caller needs for underline/strikethrough extent when `justifyWidth` changed it. */
function drawLine(context: CanvasRenderingContext2D, text: RasterTextData, rawLine: string, x: number, y: number, justifyWidth: number | null): number {
  const line = displayText(text, rawLine);
  const words = line.split(" ");
  const naturalWidth = [...line].reduce((sum, character) => sum + context.measureText(character).width, 0) + text.letterSpacing * Math.max(0, [...line].length - 1);
  const extraGap = justifyWidth !== null && words.length > 1 ? Math.max(0, (justifyWidth - naturalWidth) / (words.length - 1)) : 0;
  const totalWidth = justifyWidth !== null ? Math.max(naturalWidth, justifyWidth) : naturalWidth;
  const origin = text.align === "center" ? x - totalWidth / 2 : text.align === "right" ? x - totalWidth : x;

  withGlyphTransform(context, text, origin, y, (localOrigin, localY) => {
    const previousAlign = context.textAlign;
    context.textAlign = "left";
    let cursor = localOrigin;
    for (const word of words) {
      for (const character of word) { context.fillText(character, cursor, localY); cursor += context.measureText(character).width + text.letterSpacing; }
      cursor += extraGap;
    }
    context.textAlign = previousAlign;
  });

  if (text.underline || text.strikethrough) {
    const thickness = Math.max(1, Math.round(text.fontSize / 16));
    if (text.underline) context.fillRect(origin, y + text.fontSize * 1.06, totalWidth, thickness);
    if (text.strikethrough) context.fillRect(origin, y + text.fontSize * 0.62, totalWidth, thickness);
  }
  return totalWidth;
}

/** Renders a text layer's pixels from its live text data — the single source of truth used both while committing a new/edited layer and whenever its properties change. Non-destructive: callers keep `layer.text` around and re-invoke this instead of mutating baked pixels directly. */
export function renderTextLayerPixels(text: RasterTextData, width: number, height: number): Uint8ClampedArray {
  const surface = document.createElement("canvas");
  surface.width = width; surface.height = height;
  const context = surface.getContext("2d")!;
  if (text.transform) context.setTransform(text.transform.a, text.transform.b, text.transform.c, text.transform.d, text.transform.e, text.transform.f);
  context.font = textFontString(text);
  context.textBaseline = "top"; context.textAlign = text.align; context.fillStyle = text.color;
  // These three are recent Canvas 2D context extensions (all in TS's lib.dom.d.ts and every
  // Chromium-based target this project ships on) — real browser behaviour, not synthesised here:
  // fontKerning toggles the font's own GPOS kerning pairs, fontVariantCaps requests true OpenType
  // small-caps substitution (falling back to a scaled-caps synthesis where the font has none, the
  // same two-tier behaviour any small-caps renderer has), direction reverses Canvas's own
  // glyph-run layout for a wholly-RTL string (not a full Unicode Bidi Algorithm — see
  // RasterTextData.direction's own doc comment on mixed-direction runs).
  context.fontKerning = text.kerning ?? "auto";
  context.fontVariantCaps = text.smallCaps ? "small-caps" : "normal";
  context.direction = text.direction ?? "ltr";
  const finish = () => {
    const pixels = context.getImageData(0, 0, width, height).data;
    let left = width, top = height, right = 0, bottom = 0;
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) if (pixels[(y * width + x) * 4 + 3]) { left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x + 1); bottom = Math.max(bottom, y + 1); }
    text.visualBounds = right > left && bottom > top ? { x: left, y: top, width: right - left, height: bottom - top } : { x: 0, y: 0, width: 0, height: 0 };
    return pixels;
  };
  if ((text.mode === "path" || text.mode === "dynamic") && text.path) { drawOnPath(context, text); return finish(); }

  if (!text.boxWidth) {
    // Unbounded (point) text: no wrap, no justify, no indents/markers — a paragraph is exactly
    // one line, the same as before this file grew paragraph support.
    text.value.split("\n").forEach((line, lineIndex) => {
      drawLine(context, text, line, text.x, text.y + lineIndex * text.fontSize * text.lineHeight, null);
    });
    return finish();
  }

  const paragraphs = wrapParagraphs(context, text, text.boxWidth);
  const indentBefore = text.indentBefore ?? 0;
  const baseX = text.align === "right" ? text.x - (text.indentAfter ?? 0) : text.x + indentBefore;
  const justifyWidth = text.justify && text.justify !== "none" ? text.boxWidth - indentBefore - (text.indentAfter ?? 0) : null;
  let y = text.y;
  paragraphs.forEach((lines, paragraphIndex) => {
    y += paragraphIndex > 0 ? (text.spaceBefore ?? 0) : 0;
    const marker = listMarker(text, paragraphIndex);
    if (marker) {
      const markerWidth = context.measureText(`${marker} `).width;
      drawLine(context, text, marker, baseX, y, null);
      lines.forEach((line, lineIndex) => {
        const lineX = baseX + markerWidth + (lineIndex === 0 ? (text.firstLineIndent ?? 0) : 0);
        const isLast = lineIndex === lines.length - 1;
        const stretch = justifyWidth !== null && (!isLast || text.justify === "full") ? justifyWidth - markerWidth : null;
        drawLine(context, text, line, lineX, y, stretch);
        y += text.fontSize * text.lineHeight;
      });
    } else {
      lines.forEach((line, lineIndex) => {
        const lineX = baseX + (lineIndex === 0 ? (text.firstLineIndent ?? 0) : 0);
        const isLast = lineIndex === lines.length - 1;
        const stretch = justifyWidth !== null && (!isLast || text.justify === "full") ? justifyWidth : null;
        drawLine(context, text, line, lineX, y, stretch);
        y += text.fontSize * text.lineHeight;
      });
    }
    y += paragraphIndex < paragraphs.length - 1 ? (text.spaceAfter ?? 0) : 0;
  });
  return finish();
}
