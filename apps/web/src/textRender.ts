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

/** Builds the CSS `font` shorthand Canvas2D expects, honoring bold/italic. */
export function textFontString(text: Pick<RasterTextData, "fontFamily" | "fontSize" | "bold" | "italic">): string {
  return `${text.italic ? "italic " : ""}${text.bold ? "700 " : ""}${text.fontSize}px ${text.fontFamily}`;
}

/** Word-wraps a paragraph into lines that fit `boxWidth`, breaking mid-word only when a single word alone overflows it. Explicit newlines stay as paragraph breaks. */
function wrapParagraph(context: CanvasRenderingContext2D, value: string, boxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of value.split("\n")) {
    const words = paragraph.split(" ");
    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (context.measureText(candidate).width <= boxWidth || !current) { current = candidate; continue; }
      lines.push(current); current = word;
    }
    lines.push(current);
  }
  return lines;
}

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
  const characters = [...text.value.replace(/\n/g, " ")];
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

/** Renders a text layer's pixels from its live text data — the single source of truth used both while committing a new/edited layer and whenever its properties change. Non-destructive: callers keep `layer.text` around and re-invoke this instead of mutating baked pixels directly. */
export function renderTextLayerPixels(text: RasterTextData, width: number, height: number): Uint8ClampedArray {
  const surface = document.createElement("canvas");
  surface.width = width; surface.height = height;
  const context = surface.getContext("2d")!;
  if (text.transform) context.setTransform(text.transform.a, text.transform.b, text.transform.c, text.transform.d, text.transform.e, text.transform.f);
  context.font = textFontString(text);
  context.textBaseline = "top"; context.textAlign = text.align; context.fillStyle = text.color;
  const finish = () => {
    const pixels = context.getImageData(0, 0, width, height).data;
    let left = width, top = height, right = 0, bottom = 0;
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) if (pixels[(y * width + x) * 4 + 3]) { left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x + 1); bottom = Math.max(bottom, y + 1); }
    text.visualBounds = right > left && bottom > top ? { x: left, y: top, width: right - left, height: bottom - top } : { x: 0, y: 0, width: 0, height: 0 };
    return pixels;
  };
  if ((text.mode === "path" || text.mode === "dynamic") && text.path) { drawOnPath(context, text); return finish(); }
  const lines = text.boxWidth ? wrapParagraph(context, text.value, text.boxWidth) : text.value.split("\n");
  lines.forEach((line, lineIndex) => {
    const y = text.y + lineIndex * text.fontSize * text.lineHeight;
    let lineWidth: number;
    if (!text.letterSpacing) {
      context.fillText(line, text.x, y);
      lineWidth = context.measureText(line).width;
    } else {
      const totalWidth = [...line].reduce((sum, character) => sum + context.measureText(character).width + text.letterSpacing, -text.letterSpacing);
      const origin = text.align === "center" ? text.x - totalWidth / 2 : text.align === "right" ? text.x - totalWidth : text.x;
      let x = origin;
      const previousAlign = context.textAlign; context.textAlign = "left";
      for (const character of line) { context.fillText(character, x, y); x += context.measureText(character).width + text.letterSpacing; }
      context.textAlign = previousAlign;
      lineWidth = Math.max(0, totalWidth);
    }
    if (text.underline) {
      const underlineY = y + text.fontSize * 1.06, thickness = Math.max(1, Math.round(text.fontSize / 16));
      const startX = text.align === "center" ? text.x - lineWidth / 2 : text.align === "right" ? text.x - lineWidth : text.x;
      context.fillRect(startX, underlineY, lineWidth, thickness);
    }
  });
  return finish();
}
