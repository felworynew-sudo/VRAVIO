/**
 * Photoshop-style geometry modifiers shared by the raster and vector shape
 * tools. Keeping them here prevents a square made by a raster rectangle from
 * using subtly different math than a square made by a vector rectangle.
 *
 * Shift constrains a box to equal sides; Alt/Option makes the press point its
 * centre. These modifiers are intentionally evaluated from the *current*
 * pointer state, so pressing or releasing a key halfway through a drag updates
 * the live result instead of only affecting the final mouse-up.
 */
export interface BoxDragModifiers {
  readonly shiftKey?: boolean;
  readonly altKey?: boolean;
}

export interface DragBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export function boxFromDrag(
  from: { readonly x: number; readonly y: number },
  to: { readonly x: number; readonly y: number },
  modifiers: BoxDragModifiers = {},
): DragBox {
  let dx = to.x - from.x;
  let dy = to.y - from.y;
  if (modifiers.shiftKey) {
    const extent = Math.max(Math.abs(dx), Math.abs(dy));
    dx = extent * (dx < 0 ? -1 : 1);
    dy = extent * (dy < 0 ? -1 : 1);
  }
  const start = modifiers.altKey ? { x: from.x - dx, y: from.y - dy } : from;
  const end = modifiers.altKey ? { x: from.x + dx, y: from.y + dy } : { x: from.x + dx, y: from.y + dy };
  return { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) };
}
