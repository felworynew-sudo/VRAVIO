/** Manual Liquify workspace: a per-pixel inverse-displacement field plus a freeze (protection) mask. */

export interface LiquifyState {
  width: number;
  height: number;
  /** Inverse displacement in field pixels: sampling for output (x,y) reads source (x + dx, y + dy). */
  dx: Float32Array;
  dy: Float32Array;
  /** 0 = free, 255 = fully frozen (protected from further deformation). */
  freeze: Uint8ClampedArray;
}

export type LiquifyTool = "warp" | "twirl" | "pucker" | "bloat" | "freeze" | "thaw" | "reconstruct" | "smooth";

export function createLiquifyState(width: number, height: number): LiquifyState {
  return { width, height, dx: new Float32Array(width * height), dy: new Float32Array(width * height), freeze: new Uint8ClampedArray(width * height) };
}

export function cloneLiquifyState(state: LiquifyState): LiquifyState {
  return { width: state.width, height: state.height, dx: state.dx.slice(), dy: state.dy.slice(), freeze: state.freeze.slice() };
}

export function isLiquifyIdentity(state: LiquifyState): boolean {
  for (let index = 0; index < state.dx.length; index += 1) if (state.dx[index] !== 0 || state.dy[index] !== 0) return false;
  return true;
}

function falloff(distance: number, radius: number, density = 0.5): number {
  if (distance >= radius) return 0;
  const linear = 1 - distance / radius, soft = linear * linear;
  return soft + (linear - soft) * Math.max(0, Math.min(1, density));
}

function forEachBrushNode(state: LiquifyState, cx: number, cy: number, radius: number, visit: (index: number, weight: number, ox: number, oy: number) => void, density = 0.5): void {
  const left = Math.max(0, Math.floor(cx - radius)), right = Math.min(state.width - 1, Math.ceil(cx + radius));
  const top = Math.max(0, Math.floor(cy - radius)), bottom = Math.min(state.height - 1, Math.ceil(cy + radius));
  for (let y = top; y <= bottom; y += 1) for (let x = left; x <= right; x += 1) {
    const ox = x - cx, oy = y - cy, distance = Math.hypot(ox, oy);
    const weight = falloff(distance, radius, density);
    if (weight <= 0) continue;
    const index = y * state.width + x;
    const protection = 1 - state.freeze[index]! / 255;
    if (protection <= 0) continue;
    visit(index, weight * protection, ox, oy);
  }
}

/**
 * Writes a node's displacement after clamping its magnitude to the current
 * brush radius — the single door every displacement-adding tool (Warp,
 * Twirl, Pucker/Bloat) must go through, so none of them can independently
 * regress the same bug. Reconstruct/Smooth don't call this: they blend
 * toward an existing or neighbouring value and can only shrink the field
 * or average already-bounded neighbours, never grow it past what put it
 * there.
 *
 * Found live, twice: holding Twirl in one spot spirals a node's stored
 * displacement outward without limit, because each held tick adds a fixed
 * delta computed from the node's ORIGINAL (undisplaced) offset — not a
 * true composed rotation around the accumulated position — so N ticks sum
 * to a magnitude that grows linearly with N in a fixed direction, not a
 * point orbiting at constant radius. Bloat/Pucker's outward pull has the
 * same "add the same delta every tick" shape. Once the accumulated vector
 * outgrows the brush's own radius, the inverse-sampled source point can
 * cross the deformation centre or run off the layer edge, and the fold
 * reads on screen as a self-intersecting spiral or a punched-through hole
 * rather than a smooth swirl/bulge — confirmed by reverting this clamp and
 * holding Twirl and Bloat in place in the running app: both reliably
 * produce the fold within a couple dozen held ticks, and holding it
 * clamped keeps both a clean, bounded deformation indefinitely.
 *
 * Patchy's own Liquify (`src/core/liquify.cpp`, `LiquifyMesh::render`)
 * takes a related but distinct approach — it clamps the FINAL sampled
 * source coordinate to the image bounds at render time, on a coarse
 * interpolated mesh (capped at 129 nodes per axis) rather than a
 * dense per-pixel field. The coarse mesh means any one node's runaway
 * value gets spread by bilinear interpolation over a wide neighbourhood
 * instead of creating a tight, high-frequency knot the way a per-pixel
 * field can — see docs/master-plan.md §1.3 for why VRAVIO keeps the
 * denser field for now and clamps per node instead of migrating to a
 * mesh.
 */
function commitDisplacement(state: LiquifyState, index: number, dx: number, dy: number, radius: number): void {
  const nextX = state.dx[index]! + dx, nextY = state.dy[index]! + dy;
  const length = Math.hypot(nextX, nextY);
  const scale = length > radius ? radius / length : 1;
  state.dx[index] = nextX * scale;
  state.dy[index] = nextY * scale;
}

/** Warp: drags the deformation field along the pointer's motion, pressure-scaled. */
export function liquifyWarp(state: LiquifyState, x: number, y: number, motionX: number, motionY: number, radius: number, strength: number, density = 0.5): void {
  forEachBrushNode(state, x, y, radius, (index, weight) => {
    commitDisplacement(state, index, -motionX * weight * strength, -motionY * weight * strength, radius);
  }, density);
}

/** Twirl: rotates the field around the brush center; positive strength is clockwise. */
export function liquifyTwirl(state: LiquifyState, x: number, y: number, radius: number, strength: number, density = 0.5): void {
  forEachBrushNode(state, x, y, radius, (index, weight, ox, oy) => {
    const angle = -weight * strength * 12 * Math.PI / 180;
    const sin = Math.sin(angle), cos = Math.cos(angle);
    const sourceX = ox * cos - oy * sin, sourceY = ox * sin + oy * cos;
    commitDisplacement(state, index, sourceX - ox, sourceY - oy, radius);
  }, density);
}

/** Pucker (sign=1) pulls pixels toward the brush center; Bloat (sign=-1) pushes them away. */
export function liquifyPuckerBloat(state: LiquifyState, x: number, y: number, radius: number, strength: number, sign: 1 | -1, density = 0.5): void {
  forEachBrushNode(state, x, y, radius, (index, weight, ox, oy) => {
    const pull = weight * strength * 0.12 * sign;
    commitDisplacement(state, index, ox * pull, oy * pull, radius);
  }, density);
}

/** Reconstruct: relaxes displacement back toward identity (zero), fastest where least protected. */
export function liquifyReconstruct(state: LiquifyState, x: number, y: number, radius: number, strength: number, density = 0.5): void {
  forEachBrushNode(state, x, y, radius, (index, weight) => {
    const amount = Math.min(1, weight * strength);
    state.dx[index]! *= 1 - amount;
    state.dy[index]! *= 1 - amount;
  }, density);
}

/** Smooth: relaxes each node toward its 4-neighbor displacement average. */
export function liquifySmooth(state: LiquifyState, x: number, y: number, radius: number, strength: number, density = 0.5): void {
  const source = { dx: state.dx.slice(), dy: state.dy.slice() };
  forEachBrushNode(state, x, y, radius, (index, weight) => {
    const px = index % state.width, py = Math.floor(index / state.width);
    const left = px > 0 ? index - 1 : index, right = px < state.width - 1 ? index + 1 : index;
    const up = py > 0 ? index - state.width : index, down = py < state.height - 1 ? index + state.width : index;
    const averageX = (source.dx[left]! + source.dx[right]! + source.dx[up]! + source.dx[down]!) / 4;
    const averageY = (source.dy[left]! + source.dy[right]! + source.dy[up]! + source.dy[down]!) / 4;
    const amount = Math.min(1, weight * strength);
    state.dx[index] = state.dx[index]! + (averageX - state.dx[index]!) * amount;
    state.dy[index] = state.dy[index]! + (averageY - state.dy[index]!) * amount;
  }, density);
}

export function liquifyFreeze(state: LiquifyState, x: number, y: number, radius: number, thaw: boolean, strength = 1, density = 0.5): void {
  const left = Math.max(0, Math.floor(x - radius)), right = Math.min(state.width - 1, Math.ceil(x + radius));
  const top = Math.max(0, Math.floor(y - radius)), bottom = Math.min(state.height - 1, Math.ceil(y + radius));
  for (let py = top; py <= bottom; py += 1) for (let px = left; px <= right; px += 1) {
    const distance = Math.hypot(px - x, py - y); if (distance >= radius) continue;
    const index = py * state.width + px, weight = falloff(distance, radius, density) * strength;
    state.freeze[index] = thaw ? Math.max(0, state.freeze[index]! - weight * 255) : Math.min(255, state.freeze[index]! + weight * 255);
  }
}

function sampleBilinearClamped(pixels: Uint8ClampedArray, width: number, height: number, x: number, y: number, out: [number, number, number, number]): void {
  const clampedX = Math.max(0, Math.min(width - 1.001, x)), clampedY = Math.max(0, Math.min(height - 1.001, y));
  const x0 = Math.floor(clampedX), y0 = Math.floor(clampedY), x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1);
  const fx = clampedX - x0, fy = clampedY - y0;
  const i00 = (y0 * width + x0) * 4, i10 = (y0 * width + x1) * 4, i01 = (y1 * width + x0) * 4, i11 = (y1 * width + x1) * 4;
  // Interpolate premultiplied colours. Straight-RGBA interpolation pulls the
  // hidden RGB of transparent pixels into an edge and creates dark halos after
  // a deformation — Patchy uses the same premultiplied-alpha rule here.
  const weights = [(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy] as const;
  const indices = [i00, i10, i01, i11] as const;
  let alpha = 0, red = 0, green = 0, blue = 0;
  for (let sampleIndex = 0; sampleIndex < 4; sampleIndex += 1) {
    const source = indices[sampleIndex]!, weight = weights[sampleIndex]!, a = pixels[source + 3]! / 255;
    alpha += a * weight;
    red += pixels[source]! * a * weight;
    green += pixels[source + 1]! * a * weight;
    blue += pixels[source + 2]! * a * weight;
  }
  if (alpha <= 1e-6) { out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 0; return; }
  out[0] = red / alpha; out[1] = green / alpha; out[2] = blue / alpha; out[3] = alpha * 255;
}

function sampleField(values: Float32Array, width: number, height: number, x: number, y: number): number {
  const clampedX = Math.max(0, Math.min(width - 1, x)), clampedY = Math.max(0, Math.min(height - 1, y));
  const x0 = Math.floor(clampedX), y0 = Math.floor(clampedY), x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1);
  const fx = clampedX - x0, fy = clampedY - y0;
  const top = values[y0 * width + x0]! * (1 - fx) + values[y0 * width + x1]! * fx;
  const bottom = values[y1 * width + x0]! * (1 - fx) + values[y1 * width + x1]! * fx;
  return top * (1 - fy) + bottom * fy;
}

/** Renders once from the immutable original pixels; a zero-displacement field returns byte-identical output. */
export function renderLiquify(pixels: Uint8ClampedArray, width: number, height: number, state: LiquifyState): Uint8ClampedArray {
  const output = new Uint8ClampedArray(pixels.length), sample: [number, number, number, number] = [0, 0, 0, 0];
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const fieldX = width <= 1 ? 0 : x * (state.width - 1) / (width - 1), fieldY = height <= 1 ? 0 : y * (state.height - 1) / (height - 1);
    const dx = sampleField(state.dx, state.width, state.height, fieldX, fieldY) * (width <= 1 || state.width <= 1 ? 1 : (width - 1) / (state.width - 1));
    const dy = sampleField(state.dy, state.width, state.height, fieldX, fieldY) * (height <= 1 || state.height <= 1 ? 1 : (height - 1) / (state.height - 1));
    const target = (y * width + x) * 4;
    if (dx === 0 && dy === 0) { output[target] = pixels[target]!; output[target + 1] = pixels[target + 1]!; output[target + 2] = pixels[target + 2]!; output[target + 3] = pixels[target + 3]!; continue; }
    sampleBilinearClamped(pixels, width, height, x + dx, y + dy, sample);
    output[target] = sample[0]; output[target + 1] = sample[1]; output[target + 2] = sample[2]; output[target + 3] = sample[3];
  }
  return output;
}
