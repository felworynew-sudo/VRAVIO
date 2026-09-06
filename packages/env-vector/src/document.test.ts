import { describe, expect, it } from "vitest";
import { createArtboard, createShape, createVectorDocument, reseedShapeIdCounters } from "./document";

/**
 * `reseedShapeIdCounters` — the fix for a real id-collision bug found live
 * (`docs/vector-plan.md` section 9): `createShape`'s `counter` is a
 * module-level variable that restarts at 0 on every page load, while a
 * *persisted* document reloaded into that fresh session already carries
 * ids minted by a previous run's counter. Without a reseed, the new
 * session's first new shape can mint an id an already-loaded shape has —
 * `addShape` has no collision check, so the two silently become the same
 * array entry to every by-id lookup.
 */
describe("reseedShapeIdCounters", () => {
  it("raises the shape counter past a persisted document's own ids, so a freshly created shape never collides with one already loaded", () => {
    // Simulates a fresh page load's counter (0) alongside a persisted
    // document that already has "path-1" and "rectangle-2" — before the
    // fix, the very next createShape("path", ...) call would also mint
    // "path-1", not "path-3".
    const persisted = createVectorDocument();
    persisted.shapes = [
      { ...createShape("path", 0, 0), id: "path-1" },
      { ...createShape("rectangle", 0, 0), id: "rectangle-2" },
    ];
    reseedShapeIdCounters(persisted);

    const created = createShape("path", 10, 10);
    expect(created.id).not.toBe("path-1");
    expect(persisted.shapes.some((shape) => shape.id === created.id)).toBe(false);
  });

  it("raises the artboard counter past a persisted document's own artboard ids the same way", () => {
    const persisted = createVectorDocument();
    persisted.artboards = [{ ...createArtboard(0, 0, 100, 100), id: "artboard-5" }];
    reseedShapeIdCounters(persisted);

    const created = createArtboard(0, 0, 50, 50);
    expect(created.id).not.toBe("artboard-5");
    expect(persisted.artboards.some((artboard) => artboard.id === created.id)).toBe(false);
  });

  it("never lowers a counter that a denser document already raised — restoring a sparser document afterward keeps the earlier headroom", () => {
    const dense = createVectorDocument();
    dense.shapes = [{ ...createShape("path", 0, 0), id: "path-50" }];
    reseedShapeIdCounters(dense);
    const highWaterMark = createShape("rectangle", 0, 0).id;

    const sparse = createVectorDocument();
    sparse.shapes = [{ ...createShape("path", 0, 0), id: "path-1" }];
    reseedShapeIdCounters(sparse);

    const createdAfterSparse = createShape("ellipse", 0, 0);
    expect(createdAfterSparse.id).not.toBe("path-1");
    expect(createdAfterSparse.id).not.toBe(highWaterMark);
  });
});
