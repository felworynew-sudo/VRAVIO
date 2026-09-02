import type { RasterRect } from "./types";

export interface TilePlan {
  /** Region fed to the model, including the overlap skirt. */
  readonly rect: RasterRect;
  readonly column: number;
  readonly row: number;
}

export interface TilingOptions {
  readonly tileSize: number;
  /** Skirt shared with each neighbour, in pixels. */
  readonly overlap: number;
}

/**
 * Splits an image into overlapping tiles.
 *
 * Models take a fixed input, so a large image has to be cut up. Tiles are advanced by
 * `tileSize - overlap` and each carries a skirt into its neighbours; without that skirt the
 * model sees a hard edge and the seams show up in the output.
 */
export function planTiles(width: number, height: number, options: TilingOptions): TilePlan[] {
  const tileSize = Math.max(1, Math.floor(options.tileSize));
  const overlap = Math.max(0, Math.min(Math.floor(options.overlap), tileSize - 1));
  const stride = Math.max(1, tileSize - overlap);
  const plans: TilePlan[] = [];
  const starts = (extent: number): number[] => {
    if (extent <= tileSize) return [0];
    const positions: number[] = [];
    for (let start = 0; start < extent - overlap; start += stride) positions.push(Math.min(start, extent - tileSize));
    // The last tile is pinned to the far edge so the image is fully covered without a runt tile.
    if (positions[positions.length - 1] !== extent - tileSize) positions.push(extent - tileSize);
    return [...new Set(positions)];
  };
  const columns = starts(width), rows = starts(height);
  for (let row = 0; row < rows.length; row += 1) for (let column = 0; column < columns.length; column += 1) {
    plans.push({
      column, row,
      rect: { x: columns[column]!, y: rows[row]!, width: Math.min(tileSize, width), height: Math.min(tileSize, height) },
    });
  }
  return plans;
}

/**
 * Reassembles processed tiles with a feathered cross-fade in the overlap.
 *
 * Each contribution is weighted by its distance from the tile edge, and the accumulated weight
 * divides the sum at the end. Copying tiles in flat would leave a visible grid; a plain average
 * would darken every seam where fewer tiles overlap.
 */
export class TileCompositor {
  readonly #width: number;
  readonly #height: number;
  readonly #sum: Float32Array;
  readonly #weight: Float32Array;

  constructor(width: number, height: number) {
    this.#width = width;
    this.#height = height;
    this.#sum = new Float32Array(width * height * 4);
    this.#weight = new Float32Array(width * height);
  }

  add(tile: Uint8ClampedArray, plan: TilePlan, overlap: number): void {
    const { rect } = plan;
    const feather = Math.max(1, Math.floor(overlap));
    for (let y = 0; y < rect.height; y += 1) {
      const documentY = rect.y + y;
      if (documentY < 0 || documentY >= this.#height) continue;
      // A tile flush against the image border keeps full weight there: there is no neighbour
      // to blend with, and fading would wash out the edge.
      const topWeight = rect.y <= 0 ? 1 : Math.min(1, (y + .5) / feather);
      const bottomWeight = rect.y + rect.height >= this.#height ? 1 : Math.min(1, (rect.height - y - .5) / feather);
      for (let x = 0; x < rect.width; x += 1) {
        const documentX = rect.x + x;
        if (documentX < 0 || documentX >= this.#width) continue;
        const leftWeight = rect.x <= 0 ? 1 : Math.min(1, (x + .5) / feather);
        const rightWeight = rect.x + rect.width >= this.#width ? 1 : Math.min(1, (rect.width - x - .5) / feather);
        const weight = Math.max(1e-4, Math.min(topWeight, bottomWeight, leftWeight, rightWeight));
        const source = (y * rect.width + x) * 4, target = (documentY * this.#width + documentX) * 4;
        for (let channel = 0; channel < 4; channel += 1) this.#sum[target + channel] = this.#sum[target + channel]! + tile[source + channel]! * weight;
        const weightIndex = documentY * this.#width + documentX;
        this.#weight[weightIndex] = this.#weight[weightIndex]! + weight;
      }
    }
  }

  finish(): Uint8ClampedArray {
    const output = new Uint8ClampedArray(this.#width * this.#height * 4);
    for (let pixel = 0; pixel < this.#weight.length; pixel += 1) {
      const weight = this.#weight[pixel]!;
      if (weight <= 0) continue;
      const index = pixel * 4;
      output[index] = Math.round(this.#sum[index]! / weight);
      output[index + 1] = Math.round(this.#sum[index + 1]! / weight);
      output[index + 2] = Math.round(this.#sum[index + 2]! / weight);
      output[index + 3] = Math.round(this.#sum[index + 3]! / weight);
    }
    return output;
  }
}

/** Copies one tile out of an image, clamping at the borders. */
export function extractTile(pixels: Uint8ClampedArray, width: number, height: number, rect: RasterRect): Uint8ClampedArray {
  const tile = new Uint8ClampedArray(rect.width * rect.height * 4);
  for (let y = 0; y < rect.height; y += 1) {
    const sourceY = Math.max(0, Math.min(height - 1, rect.y + y));
    for (let x = 0; x < rect.width; x += 1) {
      const sourceX = Math.max(0, Math.min(width - 1, rect.x + x));
      const source = (sourceY * width + sourceX) * 4, target = (y * rect.width + x) * 4;
      tile[target] = pixels[source]!;
      tile[target + 1] = pixels[source + 1]!;
      tile[target + 2] = pixels[source + 2]!;
      tile[target + 3] = pixels[source + 3]!;
    }
  }
  return tile;
}
