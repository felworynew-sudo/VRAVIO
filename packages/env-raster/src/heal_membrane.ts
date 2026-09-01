const FIXED_ONE = 1 << 16;
const OMEGA = 111411;
const COARSEST_SWEEPS = 400;
const LEVEL_SWEEPS = 32;
const COARSEST_CELLS = 64;

interface Level {
  width: number;
  height: number;
  interior: Uint8Array;
  value: Int32Array;
}

function sweep(level: Level): void {
  const { width, height, interior, value } = level;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      if (interior[index] === 0) continue;
      for (let channel = 0; channel < 3; channel++) {
        let sum = 0;
        let neighbors = 0;
        const base = index * 3 + channel;
        if (x > 0) { sum += value[base - 3]!; neighbors++; }
        if (x + 1 < width) { sum += value[base + 3]!; neighbors++; }
        if (y > 0) { sum += value[base - width * 3]!; neighbors++; }
        if (y + 1 < height) { sum += value[base + width * 3]!; neighbors++; }
        if (neighbors === 0) continue;
        const average = sum / neighbors;
        const current = value[base]!;
        value[base] = (current + ((OMEGA * (average - current)) >> 16)) | 0;
      }
    }
  }
}

export function solveHealMembrane(
  interior: Uint8Array,
  width: number,
  height: number,
  offsetsRgb: Int16Array
): void {
  if (width <= 0 || height <= 0) return;
  const cells = width * height;

  const levels: Level[] = [];
  const finest: Level = {
    width,
    height,
    interior: new Uint8Array(interior),
    value: new Int32Array(cells * 3),
  };
  levels.push(finest);

  let anyInterior = false;
  let anyDirichlet = false;
  for (let i = 0; i < cells; i++) {
    for (let ch = 0; ch < 3; ch++) {
      finest.value[i * 3 + ch] = interior[i] !== 0
        ? 0
        : (offsetsRgb[i * 3 + ch]! * FIXED_ONE) | 0;
    }
    if (interior[i] !== 0) anyInterior = true;
    else anyDirichlet = true;
  }
  if (!anyInterior || !anyDirichlet) return;

  while (levels[levels.length - 1]!.width * levels[levels.length - 1]!.height > COARSEST_CELLS
    && levels[levels.length - 1]!.width > 2
    && levels[levels.length - 1]!.height > 2) {
    const fine = levels[levels.length - 1]!;
    const coarseW = Math.ceil(fine.width / 2);
    const coarseH = Math.ceil(fine.height / 2);
    const coarseCells = coarseW * coarseH;
    const coarse: Level = {
      width: coarseW,
      height: coarseH,
      interior: new Uint8Array(coarseCells),
      value: new Int32Array(coarseCells * 3),
    };
      for (let y = 0; y < coarseH; y++) {
      for (let x = 0; x < coarseW; x++) {
        const dirichletSum: number[] = [0, 0, 0];
        const allSum: number[] = [0, 0, 0];
        let dirichletCount = 0;
        let allCount = 0;
        for (let childY = 0; childY < 2; childY++) {
          for (let childX = 0; childX < 2; childX++) {
            const fx = x * 2 + childX;
            const fy = y * 2 + childY;
            if (fx >= fine.width || fy >= fine.height) continue;
            const fi = fy * fine.width + fx;
            allCount++;
            for (let ch = 0; ch < 3; ch++) allSum[ch]! += fine.value[fi * 3 + ch]!;
            if (fine.interior[fi] === 0) {
              dirichletCount++;
              for (let ch = 0; ch < 3; ch++) dirichletSum[ch]! += fine.value[fi * 3 + ch]!;
            }
          }
        }
        const ci = y * coarseW + x;
        coarse.interior[ci] = dirichletCount > 0 ? 0 : 1;
        for (let ch = 0; ch < 3; ch++) {
          const s = dirichletCount > 0 ? dirichletSum[ch]! : allSum[ch]!;
          const c = dirichletCount > 0 ? dirichletCount : allCount;
          coarse.value[ci * 3 + ch] = c > 0 ? (s / c) | 0 : 0;
        }
      }
    }
    levels.push(coarse);
  }

  for (let level = levels.length - 1; level >= 0; level--) {
    const current = levels[level]!;
    if (level + 1 < levels.length) {
      const coarse = levels[level + 1]!;
      for (let y = 0; y < current.height; y++) {
        for (let x = 0; x < current.width; x++) {
          const i = y * current.width + x;
          if (current.interior[i] === 0) continue;
          const cx = Math.min(Math.floor(x / 2), coarse.width - 1);
          const cy = Math.min(Math.floor(y / 2), coarse.height - 1);
          const ci = cy * coarse.width + cx;
          for (let ch = 0; ch < 3; ch++) {
            current.value[i * 3 + ch] = coarse.value[ci * 3 + ch]!;
          }
        }
      }
    }
    const sweeps = level + 1 === levels.length ? COARSEST_SWEEPS : LEVEL_SWEEPS;
    for (let iter = 0; iter < sweeps; iter++) sweep(current);
  }

  const solved = levels[0]!;
  for (let i = 0; i < cells; i++) {
    if (interior[i] === 0) continue;
    for (let ch = 0; ch < 3; ch++) {
      const v = solved.value[i * 3 + ch]!;
      const rounded = v >= 0 ? (v + FIXED_ONE / 2) >> 16 : -((-v + FIXED_ONE / 2) >> 16);
      offsetsRgb[i * 3 + ch] = Math.max(-32768, Math.min(32767, rounded));
    }
  }
}
