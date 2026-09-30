/**
 * Every boundary of a filled region of pixels — each separate part, each with its holes — as
 * polygons on pixel corners. One tracer for everything that needs a shape's outline: "Convert to
 * 3D" extrudes it (§65.9), Puppet Warp lays its mesh on it (§65.15).
 *
 * Potrace's path decomposition (Selinger, "Potrace: a polygon-based tracing algorithm", §2.1),
 * the step Inkscape's Trace Bitmap runs first: every edge between a filled and an empty pixel
 * becomes a directed edge with the filled side on its right, the edges are linked into closed
 * paths, and a path's orientation says what it is — clockwise (in y-down space) around filled
 * pixels, anticlockwise around a hole. At a corner where two pixels touch only diagonally the path
 * always turns right, so they stay separate parts and no path touches itself (a pinched polygon is
 * what triangulation handles worst). Each hole then goes to the smallest outline that contains it —
 * three.js's own `SVGLoader.createShapes` groups holes the same way.
 */

export interface PixelOutline {
  /** Clockwise in y-down space, on pixel corners. */
  readonly outer: { x: number; y: number }[];
  readonly holes: { x: number; y: number }[][];
}

export function traceOutlines(width: number, height: number, filled: (x: number, y: number) => boolean, minArea = 4): PixelOutline[] {
  const at = (x: number, y: number) => x >= 0 && x < width && y >= 0 && y < height && filled(x, y);
  const stride = width + 1;
  // Directed boundary edges keyed by their start vertex. A vertex starts at most two edges (the
  // diagonal case), so two slots per vertex; direction 0..3 = east, south, west, north.
  const first = new Int8Array(stride * (height + 1)).fill(-1);
  const second = new Int8Array(stride * (height + 1)).fill(-1);
  const add = (vx: number, vy: number, direction: number) => {
    const index = vy * stride + vx;
    if (first[index] === -1) first[index] = direction; else second[index] = direction;
  };
  let edges = 0;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    if (!at(x, y)) continue;
    // Clockwise around the pixel in y-down space, so the filled pixel is always on the right.
    if (!at(x, y - 1)) { add(x, y, 0); edges += 1; }
    if (!at(x + 1, y)) { add(x + 1, y, 1); edges += 1; }
    if (!at(x, y + 1)) { add(x + 1, y + 1, 2); edges += 1; }
    if (!at(x - 1, y)) { add(x, y + 1, 3); edges += 1; }
  }
  if (edges === 0) return [];
  const step = [[1, 0], [0, 1], [-1, 0], [0, -1]] as const;
  const take = (index: number, incoming: number): number => {
    const a = first[index]!, b = second[index]!;
    if (b === -1) { first[index] = -1; return a; }
    // Two ways on: prefer the right turn (incoming + 1), keeping diagonal neighbours apart.
    const right = (incoming + 1) % 4;
    if (a === right) { first[index] = b; second[index] = -1; return a; }
    second[index] = -1; return b;
  };
  const loops: { x: number; y: number }[][] = [];
  for (let start = 0; start < first.length; start += 1) {
    while (first[start] !== -1) {
      const points: { x: number; y: number }[] = [];
      let vx = start % stride, vy = Math.floor(start / stride);
      const startX = vx, startY = vy;
      // The loop's first edge: no incoming direction yet, so either slot will do.
      let direction = first[start]!;
      if (second[start] !== -1) { first[start] = second[start]!; second[start] = -1; } else first[start] = -1;
      let previous = -1;
      for (let guard = 0; guard <= edges; guard += 1) {
        // Only corners are kept: a run of edges in one direction is one straight side.
        if (direction !== previous) points.push({ x: vx, y: vy });
        previous = direction;
        vx += step[direction]![0]; vy += step[direction]![1];
        if (vx === startX && vy === startY) break;
        const index = vy * stride + vx;
        if (first[index] === -1) break;
        direction = take(index, direction);
      }
      if (points.length >= 3) loops.push(points);
    }
  }
  const signedArea = (loop: readonly { x: number; y: number }[]) => {
    let sum = 0;
    for (let index = 0; index < loop.length; index += 1) { const p = loop[index]!, q = loop[(index + 1) % loop.length]!; sum += p.x * q.y - q.x * p.y; }
    return sum / 2;
  };
  const outlines: { outer: { x: number; y: number }[]; holes: { x: number; y: number }[][]; area: number }[] = [];
  const holes: { loop: { x: number; y: number }[]; area: number }[] = [];
  for (const loop of loops) {
    const area = signedArea(loop);
    if (Math.abs(area) < minArea) continue;
    if (area > 0) outlines.push({ outer: loop, holes: [], area }); else holes.push({ loop, area: -area });
  }
  for (const hole of holes) {
    // A point just inside the hole: the middle of its first edge, a quarter pixel to the left of
    // travel — the empty side, since filled is always on the right.
    const a = hole.loop[0]!, b = hole.loop[1]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const probe = { x: (a.x + b.x) / 2 + (b.y - a.y) / length * 0.25, y: (a.y + b.y) / 2 - (b.x - a.x) / length * 0.25 };
    let owner: (typeof outlines)[number] | undefined;
    for (const candidate of outlines) if (candidate.area > hole.area && pointInPolygon(probe, candidate.outer) && (!owner || candidate.area < owner.area)) owner = candidate;
    owner?.holes.push(hole.loop);
  }
  return outlines.map(({ outer, holes: ownHoles }) => ({ outer, holes: ownHoles }));
}

/** Even–odd point-in-polygon. */
export function pointInPolygon(point: { x: number; y: number }, loop: readonly { x: number; y: number }[]): boolean {
  let hit = false;
  for (let index = 0, previousIndex = loop.length - 1; index < loop.length; previousIndex = index, index += 1) {
    const a = loop[index]!, b = loop[previousIndex]!;
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}
