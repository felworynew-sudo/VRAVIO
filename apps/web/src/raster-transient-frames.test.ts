import { describe, expect, it } from "vitest";
import { cancelTransientCanvasFrames } from "./raster-transient-frames";

describe("cancelTransientCanvasFrames", () => {
  it("cancels every queued preview/work frame and drops their stale payloads", () => {
    const refs = {
      preview: { current: { frame: 11 } },
      layeredPreview: { current: { frame: 12 } },
      workFrame: { current: 13 },
      pendingWork: { current: () => undefined },
    };
    const cancelled: number[] = [];

    cancelTransientCanvasFrames(refs, (frame) => cancelled.push(frame));

    expect(cancelled).toEqual([11, 12, 13]);
    expect(refs.preview.current).toBeNull();
    expect(refs.layeredPreview.current).toBeNull();
    expect(refs.workFrame.current).toBeNull();
    expect(refs.pendingWork.current).toBeNull();
  });
});
