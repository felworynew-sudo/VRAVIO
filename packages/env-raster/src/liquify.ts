/** Manual Liquify workspace: a per-pixel inverse-displacement field plus a freeze (protection) mask. */

export interface LiquifyState {
  width: number;
  height: number;
  /** Inverse displacement in source pixels: sampling for output (x,y) reads source (x - dx, y - dy). */
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

function falloff(distance: number, radius: number): number {
  if (distance >= radius) return 0;
  const t = 1 - distance / radius;
  return t * t * (3 - 2 * t);
}

function forEachBrushNode(state: LiquifyState, cx: number, cy: number, radius: number, visit: (index: number, weight: number, ox: number, oy: number) => void): void {
  const left = Math.max(0, Math.floor(cx - radius)), right = Math.min(state.width - 1, Math.ceil(cx + radius));
  const top = Math.max(0, Math.floor(cy - radius)), bottom = Math.min(state.height - 1, Math.ceil(cy + radius));
  for (let y = top; y <= bottom; y += 1) for (let x = left; x <= right; x += 1) {
    const ox = x - cx, oy = y - cy, distance = Math.hypot(ox, oy);
    const weight = falloff(distance, radius);
    if (weight <= 0) continue;
    const index = y * state.width + x;
    const protection = 1 - state.freeze[index]! / 255;
    if (protection <= 0) continue;
    visit(index, weight * protection, ox, oy);
  }
}

/** Warp: drags the deformation field along the pointer's motion, pressure-scaled. */
export function liquifyWarp(state: LiquifyState, x: number, y: number, motionX: number, motionY: number, radius: number, strength: number): void {
  forEachBrushNode(state, x, y, radius, (index, weight) => {
    state.dx[index]! -= motionX * weight * strength;
    state.dy[index]! -= motionY * weight * strength;
  });
}

/** Twirl: rotates the field around the brush center; positive strength is clockwise. */
export function liquifyTwirl(state: LiquifyState, x: number, y: number, radius: number, strength: number): void {
  forEachBrushNode(state, x, y, radius, (index, weight, ox, oy) => {
    const angle = weight * strength * 0.12;
    const sin = Math.sin(angle), cos = Math.cos(angle);
    const sourceX = x + ox * cos - oy * sin, sourceY = y + ox * sin + oy * cos;
    state.dx[index]! += (x + ox) - sourceX;
    state.dy[index]! += (y + oy) - sourceY;
  });
}

/** Pucker (sign=1) pulls pixels toward the brush center; Bloat (sign=-1) pushes them away. */
export function liquifyPuckerBloat(state: LiquifyState, x: number, y: number, radius: number, strength: number, sign: 1 | -1): void {
  forEachBrushNode(state, x, y, radius, (index, weight, ox, oy) => {
    const distance = Math.hypot(ox, oy) || 1;
    const pull = weight * strength * 0.35 * sign;
    state.dx[index]! += (ox / distance) * pull;
    state.dy[index]! += (oy / distance) * pull;
  });
}

/** Reconstruct: relaxes displacement back toward identity (zero), fastest where least protected. */
export function liquifyReconstruct(state: LiquifyState, x: number, y: number, radius: number, strength: number): void {
  forEachBrushNode(state, x, y, radius, (index, weight) => {
    const amount = Math.min(1, weight * strength);
    state.dx[index]! *= 1 - amount;
    state.dy[index]! *= 1 - amount;
  });
}

/** Smooth: relaxes each node toward its 4-neighbor displacement average. */
export function liquifySmooth(state: LiquifyState, x: number, y: number, radius: number, strength: number): void {
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
  });
}

export function liquifyFreeze(state: LiquifyState, x: number, y: number, radius: number, thaw: boolean): void {
  const left = Math.max(0, Math.floor(x - radius)), right = Math.min(state.width - 1, Math.ceil(x + radius));
  const top = Math.max(0, Math.floor(y - radius)), bottom = Math.min(state.height - 1, Math.ceil(y + radius));
  for (let py = top; py <= bottom; py += 1) for (let px = left; px <= right; px += 1) {
    const distance = Math.hypot(px - x, py - y); if (distance >= radius) continue;
    const index = py * state.width + px, weight = falloff(distance, radius);
    state.freeze[index] = thaw ? Math.max(0, state.freeze[index]! - weight * 255) : Math.min(255, state.freeze[index]! + weight * 255);
  }
}

function sampleBilinearClamped(pixels: Uint8ClampedArray, width: number, height: number, x: number, y: number, out: [number, number, number, number]): void {
  const clampedX = Math.max(0, Math.min(width - 1.001, x)), clampedY = Math.max(0, Math.min(height - 1.001, y));
  const x0 = Math.floor(clampedX), y0 = Math.floor(clampedY), x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1);
  const fx = clampedX - x0, fy = clampedY - y0;
  const i00 = (y0 * width + x0) * 4, i10 = (y0 * width + x1) * 4, i01 = (y1 * width + x0) * 4, i11 = (y1 * width + x1) * 4;
  for (let channel = 0; channel < 4; channel += 1) {
    const top = pixels[i00 + channel]! * (1 - fx) + pixels[i10 + channel]! * fx;
    const bottom = pixels[i01 + channel]! * (1 - fx) + pixels[i11 + channel]! * fx;
    out[channel] = top * (1 - fy) + bottom * fy;
  }
}

/** Renders once from the immutable original pixels; a zero-displacement field returns byte-identical output. */
export function renderLiquify(pixels: Uint8ClampedArray, width: number, height: number, state: LiquifyState): Uint8ClampedArray {
  const output = new Uint8ClampedArray(pixels.length), sample: [number, number, number, number] = [0, 0, 0, 0];
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const index = y * width + x, dx = state.dx[index]!, dy = state.dy[index]!;
    const target = index * 4;
    if (dx === 0 && dy === 0) { output[target] = pixels[target]!; output[target + 1] = pixels[target + 1]!; output[target + 2] = pixels[target + 2]!; output[target + 3] = pixels[target + 3]!; continue; }
    sampleBilinearClamped(pixels, width, height, x - dx, y - dy, sample);
    output[target] = sample[0]; output[target + 1] = sample[1]; output[target + 2] = sample[2]; output[target + 3] = sample[3];
  }
  return output;
}
