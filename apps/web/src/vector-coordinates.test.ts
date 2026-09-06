import { describe, expect, it } from "vitest";
import { toDocumentPoint, toScreenPoint } from "./vector-coordinates";

/**
 * `toScreenPoint` is the exact inverse of `toDocumentPoint`, hand-derived
 * for `docs/master-plan.md` section 4.8's unscaled-overlay refactor — the
 * kind of trigonometry that is easy to get subtly wrong (a sign flip on the
 * rotation, dividing where it should multiply) and cheap to actually prove
 * rather than trust by inspection. Round-trips a point through
 * document→screen→document and checks it lands back where it started,
 * across zoom/pan/rotation combinations a real session would hit.
 */
describe("toScreenPoint / toDocumentPoint round-trip", () => {
  const stageBounds = { x: -100, y: -50, width: 800, height: 600 };
  const workspaceSize = { width: 1000, height: 700 };
  const fakeWorkspace = { getBoundingClientRect: () => ({ left: 0, top: 0, width: workspaceSize.width, height: workspaceSize.height, right: workspaceSize.width, bottom: workspaceSize.height, x: 0, y: 0, toJSON: () => "" }) } as unknown as HTMLElement;

  const cases = [
    { zoom: 1, panX: 0, panY: 0, rotation: 0 },
    { zoom: 2.5, panX: 40, panY: -30, rotation: 0 },
    { zoom: 0.3, panX: -120, panY: 200, rotation: 37 },
    { zoom: 1.75, panX: 0, panY: 0, rotation: -90 },
    { zoom: 4, panX: 15, panY: 15, rotation: 180 },
  ];

  const points = [{ x: 0, y: 0 }, { x: 250, y: 130 }, { x: -400, y: 900 }, { x: 1920, y: 1080 }];

  for (const viewport of cases) {
    for (const point of points) {
      it(`round-trips (${point.x}, ${point.y}) at zoom=${viewport.zoom} pan=(${viewport.panX},${viewport.panY}) rotation=${viewport.rotation}°`, () => {
        const screen = toScreenPoint(point, workspaceSize, viewport, stageBounds);
        const back = toDocumentPoint({ clientX: screen.x, clientY: screen.y }, fakeWorkspace, viewport, stageBounds);
        expect(back.x).toBeCloseTo(point.x, 6);
        expect(back.y).toBeCloseTo(point.y, 6);
      });
    }
  }

  it("places the stage's own centre at the workspace's own centre when pan/rotation are zero", () => {
    const centre = { x: stageBounds.x + stageBounds.width / 2, y: stageBounds.y + stageBounds.height / 2 };
    const screen = toScreenPoint(centre, workspaceSize, { zoom: 1, panX: 0, panY: 0, rotation: 0 }, stageBounds);
    expect(screen.x).toBeCloseTo(workspaceSize.width / 2, 6);
    expect(screen.y).toBeCloseTo(workspaceSize.height / 2, 6);
  });
});
