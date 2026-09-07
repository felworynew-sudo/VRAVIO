import { describe, expect, it } from "vitest";
import { blitAtOrigin } from "./definitions/clipboard";

/**
 * master-plan.md §1.9 item 7: `Mod+Shift+V` (Paste in Place) has to land a
 * copy at the exact document coordinates it came from, not always the
 * canvas top-left `Mod+V` uses. The command itself reads the real system
 * clipboard, which a browser will only grant to a genuine user gesture —
 * not a script, automated or not — so this tests the one piece that
 * differs between the two commands and that a script actually can verify:
 * `blitAtOrigin`'s placement arithmetic.
 *
 * Lives here, one level above `./definitions/`, not beside `clipboard.ts`
 * itself — `registry.ts`'s own `import.meta.glob(["./definitions/*.ts", ...])`
 * naively matches any `*.ts` in that folder, `.test.ts` included, and tried
 * to register this file's exports as a command module. `registry.test.ts`
 * and `catalogue.test.ts` already live up here for the same reason.
 */
describe("blitAtOrigin", () => {
  const RED: readonly [number, number, number, number] = [255, 0, 0, 255];
  const solid = (width: number, height: number, color: readonly [number, number, number, number]) => {
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let index = 0; index < width * height; index += 1) pixels.set(color, index * 4);
    return pixels;
  };
  const at = (buffer: Uint8ClampedArray, width: number, x: number, y: number) => {
    const offset = (y * width + x) * 4;
    return [buffer[offset], buffer[offset + 1], buffer[offset + 2], buffer[offset + 3]];
  };

  it("places the source at (0,0) — plain Paste's placement", () => {
    const source = solid(10, 10, RED);
    const output = blitAtOrigin(source, 10, 10, 100, 100, 0, 0);
    expect(at(output, 100, 0, 0)).toEqual([...RED]);
    expect(at(output, 100, 9, 9)).toEqual([...RED]);
    expect(at(output, 100, 10, 10)).toEqual([0, 0, 0, 0]);
  });

  it("places the source at the remembered copy origin — Paste in Place", () => {
    const source = solid(10, 10, RED);
    const output = blitAtOrigin(source, 10, 10, 100, 100, 30, 40);
    // Exactly where a selection copied from (30,40)-(40,50) should land back.
    expect(at(output, 100, 30, 40)).toEqual([...RED]);
    expect(at(output, 100, 39, 49)).toEqual([...RED]);
    // Neither the old top-left placement nor one pixel short of the region.
    expect(at(output, 100, 0, 0)).toEqual([0, 0, 0, 0]);
    expect(at(output, 100, 29, 40)).toEqual([0, 0, 0, 0]);
    expect(at(output, 100, 40, 40)).toEqual([0, 0, 0, 0]);
  });

  it("clips rather than wraps or throws when the origin runs off the top-left edge", () => {
    const source = solid(10, 10, RED);
    // A paste-in-place whose remembered origin no longer fits — the document
    // was resized or cropped since the copy — not just a theoretical case.
    const output = blitAtOrigin(source, 10, 10, 20, 20, -5, -5);
    expect(output.length).toBe(20 * 20 * 4);
    // Only the source's bottom-right 5×5 corner is still on-document, landing
    // at the target's own top-left corner.
    expect(at(output, 20, 0, 0)).toEqual([...RED]);
    expect(at(output, 20, 4, 4)).toEqual([...RED]);
    // Just past that patch, and everywhere else, stays untouched/transparent.
    expect(at(output, 20, 5, 4)).toEqual([0, 0, 0, 0]);
    expect(at(output, 20, 4, 5)).toEqual([0, 0, 0, 0]);
    expect(at(output, 20, 19, 19)).toEqual([0, 0, 0, 0]);
  });
});
