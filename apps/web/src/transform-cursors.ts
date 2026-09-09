/**
 * The transform frame's cursors — the owner's own drawn set, shared by raster's Free Transform
 * and vector's selection frame.
 *
 * The assets are the owner's SVGs (`transform/U-D.svg`, `LD-RU.svg`, `RU-LD.svg`,
 * `Rotate-DL.svg`, `RotateLD.svg`, `Rotate-LU.svg`) with their `пример.svg` reference sheet,
 * which draws the frame with every cursor sitting beside the handle it belongs to — so which
 * glyph goes where is read off that sheet rather than guessed. This replaces the hand-built
 * paths that used to live in `raster/tools/definitions/move.tsx`: CLAUDE.md's own lesson from
 * the last round of this exact work is that the icons already exist and inventing a second set
 * is the mistake, so nothing here is drawn — only placed.
 *
 * One module for both environments, because two copies of a cursor set are two futures that
 * drift (CLAUDE.md §4): raster and vector would answer the same question with different art the
 * first time either was touched alone.
 *
 * ## What the reference sheet says
 *
 * Reading the handle squares and the glyph beside each of them off `пример.svg`:
 *
 * - the vertical double arrow sits on the top and bottom edge handles;
 * - the same glyph turned 90° sits on the left and right edge handles (the sheet's own
 *   horizontal cursor carries `rotate(-90)`, so the turn is the designer's, not an invention);
 * - `RU-LD` (its bar carries `rotate(135)`) sits on the top-left and bottom-right corners;
 * - `LD-RU` (bar at `rotate(45)`) sits on the top-right and bottom-left corners;
 * - each bent rotate glyph sits just outside its *own* corner — the top-left glyph beyond the
 *   top-left corner, and so on. (The earlier mirrored mapping in `move.tsx` was owner-specified
 *   for the *old* art, which was a scale bracket pressed into rotate duty; this set is drawn for
 *   the job and the sheet places it directly.)
 *
 * Only three rotate files were supplied, and the fourth corner is not missing art: the three are
 * exact reflections of one another (`512 − 54.09 = 457.91`, `512 − 341.55 = 170.45`), and the
 * sheet's fourth glyph is the first one mirrored vertically. So all four are one path plus a
 * transform, which is both shorter and impossible to let drift apart.
 */

/** The owner's art is drawn in a 512 box; every shape below is in those units. */
const VIEW = 512;

/** Rendered cursor size in CSS pixels. 32 is the largest a custom cursor is reliably shown at
 * across browsers on Windows, and these glyphs are drawn edge to edge, so smaller would lose the
 * arrowheads. */
const SIZE = 32;

/** Centred: every glyph in this set is drawn around the middle of its box, so the handle's exact
 * point sits under the middle of the cursor whichever direction it faces. */
const HOTSPOT = SIZE / 2;

/**
 * The white outline's width, in the art's own 512 units.
 *
 * The files carry `stroke-width: 10.81`, which is 0.68px once the box is drawn at 32 — thinner
 * than the roughly 1px of white that keeps a black cursor readable over black artwork. 20 units
 * is 1.25px at this size and the only optical adjustment made to the owner's shapes; `paint-order`
 * keeps the outline *outside* the fill, so the shape itself is not thinned by it.
 */
const OUTLINE = 20;

/** Wraps the owner's shapes into a cursor value: their geometry, an outline that survives being
 * shrunk to 32px, and a native keyword as the fallback CSS uses only if the data URI is refused. */
function cursorOf(shapes: string, fallback: string, transform?: string): string {
  const body = transform ? `<g transform='${transform}'>${shapes}</g>` : shapes;
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${SIZE}' height='${SIZE}' viewBox='0 0 ${VIEW} ${VIEW}'>`
    + `<g fill='#000' stroke='#fff' stroke-width='${OUTLINE}' stroke-miterlimit='10' paint-order='stroke'>${body}</g>`
    + `</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${HOTSPOT} ${HOTSPOT}, ${fallback}`;
}

/** `U-D.svg` — the vertical double arrow with its bar. */
const SCALE_VERTICAL =
  `<polygon points='342.25 128.76 274.31 128.76 274.31 239.25 223.88 239.25 223.88 128.76 155.96 128.76 249.1 12.39 342.25 128.76'/>`
  + `<polygon points='342.25 383.24 249.1 499.61 155.96 383.24 223.88 383.24 223.88 272.75 274.31 272.75 274.31 383.24 342.25 383.24'/>`
  + `<rect x='182.92' y='230.45' width='132.37' height='51.1'/>`;

/** `LD-RU.svg` — bottom-left to top-right. */
const SCALE_NESW =
  `<polygon points='411.84 231.9 363.8 183.86 285.67 261.99 250.02 226.33 328.14 148.2 280.12 100.17 428.26 83.74 411.84 231.9'/>`
  + `<polygon points='231.9 411.84 83.74 428.26 100.17 280.12 148.2 328.14 226.33 250.02 261.99 285.67 183.86 363.8 231.9 411.84'/>`
  + `<rect x='189.81' y='230.45' width='132.37' height='51.1' transform='translate(256 -106.04) rotate(45)'/>`;

/** `RU-LD.svg` — top-left to bottom-right. */
const SCALE_NWSE =
  `<polygon points='100.16 231.89 148.2 183.86 226.33 261.99 261.99 226.33 183.86 148.2 231.89 100.17 83.74 83.74 100.16 231.89'/>`
  + `<polygon points='280.11 411.84 428.26 428.26 411.83 280.11 363.8 328.14 285.67 250.01 250.01 285.67 328.14 363.8 280.11 411.84'/>`
  + `<rect x='189.81' y='230.45' width='132.37' height='51.1' transform='translate(618.04 256) rotate(135)'/>`;

/** `Rotate-DL.svg` — the bent double arrow whose elbow wraps the *top-left* corner. The other
 * three corners are this same path reflected, which is exactly what the supplied `RotateLD.svg`
 * and `Rotate-LU.svg` are. */
const ROTATE_TOP_LEFT =
  `<path d='M54.09,341.55l93.12,116.38,93.16-116.38h-67.94v-86.24c0-45.76,37.1-82.85,82.85-82.85h86.29v67.9l116.34-93.12-116.34-93.16v67.94h-85.81c-73.88,0-133.77,59.89-133.77,133.77v85.76H54.09Z'/>`;

export const CURSOR_SCALE_NS = cursorOf(SCALE_VERTICAL, "ns-resize");
export const CURSOR_SCALE_EW = cursorOf(SCALE_VERTICAL, "ew-resize", `rotate(90 ${VIEW / 2} ${VIEW / 2})`);
export const CURSOR_SCALE_NESW = cursorOf(SCALE_NESW, "nesw-resize");
export const CURSOR_SCALE_NWSE = cursorOf(SCALE_NWSE, "nwse-resize");

export const CURSOR_ROTATE_TL = cursorOf(ROTATE_TOP_LEFT, "alias");
export const CURSOR_ROTATE_TR = cursorOf(ROTATE_TOP_LEFT, "alias", `translate(${VIEW} 0) scale(-1 1)`);
export const CURSOR_ROTATE_BL = cursorOf(ROTATE_TOP_LEFT, "alias", `translate(0 ${VIEW}) scale(1 -1)`);
export const CURSOR_ROTATE_BR = cursorOf(ROTATE_TOP_LEFT, "alias", `translate(${VIEW} ${VIEW}) scale(-1 -1)`);

/** Where a handle sits on the frame, as the -1/0/1 grid both environments already use. */
export type HandleSign = -1 | 0 | 1;

/**
 * The scale cursor for a handle position.
 *
 * Opposite corners share one glyph, the way `nwse-resize` and `nesw-resize` are shared natively
 * and the way the reference sheet draws it: the arrow is 180°-symmetric, so a per-corner asset
 * would be the same picture four times.
 */
export function scaleCursorFor(hx: HandleSign, hy: HandleSign): string {
  if (hx === 0) return CURSOR_SCALE_NS;
  if (hy === 0) return CURSOR_SCALE_EW;
  return hx === hy ? CURSOR_SCALE_NWSE : CURSOR_SCALE_NESW;
}

/**
 * The rotate cursor for a corner, each glyph on its own corner as the reference sheet places it.
 * A bend is not 180°-symmetric, so unlike the scale arrow this really is four distinct glyphs.
 */
export function rotateCursorFor(hx: -1 | 1, hy: -1 | 1): string {
  if (hy === -1) return hx === -1 ? CURSOR_ROTATE_TL : CURSOR_ROTATE_TR;
  return hx === -1 ? CURSOR_ROTATE_BL : CURSOR_ROTATE_BR;
}
