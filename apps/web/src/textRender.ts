import type { RasterTextData } from "@vravio/env-raster";

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

/** Renders a text layer's pixels from its live text data — the single source of truth used both while committing a new/edited layer and whenever its properties change. Non-destructive: callers keep `layer.text` around and re-invoke this instead of mutating baked pixels directly. */
export function renderTextLayerPixels(text: RasterTextData, width: number, height: number): Uint8ClampedArray {
  const surface = document.createElement("canvas");
  surface.width = width; surface.height = height;
  const context = surface.getContext("2d")!;
  context.font = textFontString(text);
  context.textBaseline = "top"; context.textAlign = text.align; context.fillStyle = text.color;
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
  return context.getImageData(0, 0, width, height).data;
}
