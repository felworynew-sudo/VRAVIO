/**
 * A reusable grayscale brush tip. Alpha is deliberately detached from colour:
 * a brush resource describes coverage only, while the paint tool supplies the
 * foreground colour and blend behaviour. That is the common denominator for
 * user-defined tips, GIMP brushes and the bitmap payload of Adobe ABR.
 */
export interface BrushTip {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  readonly alpha: Uint8ClampedArray;
  /** Preferred distance to the next stamp, expressed as a tip-size fraction. */
  readonly spacing?: number;
}

export function createBrushTip(id: string, width: number, height: number, alpha: Uint8ClampedArray, spacing?: number): BrushTip {
  if (!id.trim()) throw new Error("A BrushTip needs an id");
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new RangeError("BrushTip dimensions must be positive integers");
  if (alpha.length !== width * height) throw new RangeError("BrushTip alpha must match its dimensions");
  return { id, width, height, alpha: alpha.slice(), ...(spacing === undefined ? {} : { spacing: Math.max(.01, spacing) }) };
}
