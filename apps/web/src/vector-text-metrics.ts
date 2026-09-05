import type { TextMeasurer } from "@vravio/env-vector";
import { textFontString } from "./textRender";

/**
 * The real `TextMeasurer` `@vravio/env-vector`'s `shapeBounds`/`hitTestShape`
 * accept but cannot construct themselves — that package has no DOM. This is
 * the one place a vector text shape's bounds actually get measured against a
 * font, via the same `textFontString` the raster text layer already uses
 * (bold/italic default false: `VectorShape`'s `text` kind has neither field
 * yet), so a vector document and a raster one never disagree about what a
 * given font string measures as.
 *
 * One offscreen canvas, reused rather than created per call — this runs on
 * every `shapeAt` hit-test and every render of the properties panel's
 * width/height, and creating a canvas element is not free.
 */
const context = window.document.createElement("canvas").getContext("2d");

export const vectorTextMeasurer: TextMeasurer = {
  measure(value, fontFamily, fontSize) {
    if (!context) return { width: Math.max(40, value.length * fontSize * .55), ascent: fontSize, descent: fontSize * .3 };
    context.font = textFontString({ fontFamily, fontSize, bold: false, italic: false });
    const metrics = context.measureText(value || " ");
    // actualBoundingBox* is what a rendered glyph really occupies — closer to
    // Illustrator's own text bounds than the font's abstract em-box, and it
    // is what makes a selection box hug the visible letters rather than
    // whatever whitespace the font's design leaves above/below them.
    return {
      width: Math.max(1, metrics.width),
      ascent: metrics.actualBoundingBoxAscent || fontSize,
      descent: metrics.actualBoundingBoxDescent || fontSize * .3,
    };
  },
};
