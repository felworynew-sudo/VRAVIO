import { describe, expect, it } from "vitest";
import { createVideoClip, createVideoTransition } from "./document";
import {
  applyCropEdge, applyLeftTrim, applyRightTrim, applyTransitionCurve, canSplitAt, constrainBoundaryTrim, constrainClipDrag, rippleShift,
  snapFrame, splitClip, transitionBlendAt,
} from "./clip-operations";

function clipAt(start: number, duration: number, offset = 0, sourceDuration = duration + 1000): ReturnType<typeof createVideoClip> {
  return createVideoClip("asset", duration, sourceDuration, 30, { startFrame: start, offsetFrames: offset });
}

describe("constrainClipDrag", () => {
  it("allows free movement with no neighbors", () => {
    const clip = clipAt(1000, 500);
    expect(constrainClipDrag(clip, 300, [clip], 0)).toBe(300);
    expect(constrainClipDrag(clip, -300, [clip], 0)).toBe(-300);
  });

  it("clamps at frame 0", () => {
    const clip = clipAt(1000, 500);
    expect(constrainClipDrag(clip, -2000, [clip], 0)).toBe(-1000);
  });

  it("cannot overlap the previous clip", () => {
    const previous = clipAt(0, 500); // ends at 500
    const clip = clipAt(1000, 500);
    const sorted = [previous, clip];
    // dragging left by 600 would put clip.start at 400, inside previous's [0,500)
    expect(constrainClipDrag(clip, -600, sorted, 1)).toBe(-500); // clamped so start lands exactly at 500
  });

  it("cannot overlap the next clip", () => {
    const clip = clipAt(0, 500);
    const next = clipAt(1000, 500);
    const sorted = [clip, next];
    // dragging right by 600 would put clip end at 1100, past next.start=1000
    expect(constrainClipDrag(clip, 600, sorted, 0)).toBe(500);
  });
});

describe("constrainBoundaryTrim", () => {
  const minDuration = 100;

  it("left trim cannot push start before 0", () => {
    const clip = clipAt(50, 500, 200);
    expect(constrainBoundaryTrim(clip, -100, "left", [clip], 0, minDuration)).toBe(-50);
  });

  it("left trim cannot push offset negative", () => {
    const clip = clipAt(1000, 500, 20);
    expect(constrainBoundaryTrim(clip, -100, "left", [clip], 0, minDuration)).toBe(-20);
  });

  it("left trim respects minimum duration", () => {
    const clip = clipAt(1000, 500, 200);
    expect(constrainBoundaryTrim(clip, 450, "left", [clip], 0, minDuration)).toBe(400);
  });

  it("left trim cannot overlap the previous clip", () => {
    const previous = clipAt(800, 100);
    const clip = clipAt(1000, 500, 400);
    expect(constrainBoundaryTrim(clip, -300, "left", [previous, clip], 1, minDuration)).toBe(-100);
  });

  it("right trim respects minimum duration when shrinking", () => {
    const clip = clipAt(1000, 500, 0);
    expect(constrainBoundaryTrim(clip, -450, "right", [clip], 0, minDuration)).toBe(-400);
  });

  it("right trim cannot exceed the source's remaining length", () => {
    const clip = clipAt(1000, 500, 0, 600); // sourceDuration 600, offset 0, duration 500 -> 100 frames of source left
    expect(constrainBoundaryTrim(clip, 300, "right", [clip], 0, minDuration)).toBe(100);
  });

  it("right trim cannot overlap the next clip", () => {
    const clip = clipAt(0, 500, 0, 10000);
    const next = clipAt(700, 500);
    expect(constrainBoundaryTrim(clip, 400, "right", [clip, next], 0, minDuration)).toBe(200);
  });

  it("rippleFollowing lets a right trim grow past the next clip's old start", () => {
    const clip = clipAt(0, 500, 0, 10000);
    const next = clipAt(700, 500);
    expect(constrainBoundaryTrim(clip, 400, "right", [clip, next], 0, minDuration, true)).toBe(400);
  });

  it("rippleFollowing still bounds a right trim by the source's remaining length", () => {
    const clip = clipAt(0, 500, 0, 600); // only 100 frames of source left past the clip's own end
    const next = clipAt(700, 500);
    expect(constrainBoundaryTrim(clip, 400, "right", [clip, next], 0, minDuration, true)).toBe(100);
  });

  it("rippleFollowing does nothing to a left trim — its own end position never moves", () => {
    const clip = clipAt(1000, 500, 400);
    const previous = clipAt(800, 100);
    const withoutRipple = constrainBoundaryTrim(clip, -300, "left", [previous, clip], 1, minDuration, false);
    const withRipple = constrainBoundaryTrim(clip, -300, "left", [previous, clip], 1, minDuration, true);
    expect(withRipple).toBe(withoutRipple);
  });
});

describe("canSplitAt / splitClip", () => {
  it("rejects a split at or outside the clip's bounds", () => {
    const clip = clipAt(1000, 500);
    expect(canSplitAt(clip, 1000, 50)).toBe(false); // at start
    expect(canSplitAt(clip, 1500, 50)).toBe(false); // at end
    expect(canSplitAt(clip, 900, 50)).toBe(false); // before start
  });

  it("rejects a split too close to either edge for the minimum duration", () => {
    const clip = clipAt(1000, 500);
    expect(canSplitAt(clip, 1005, 50)).toBe(false);
    expect(canSplitAt(clip, 1495, 50)).toBe(false);
  });

  it("accepts a split that leaves both halves at or above the minimum duration", () => {
    const clip = clipAt(1000, 500);
    expect(canSplitAt(clip, 1050, 50)).toBe(true);
    expect(canSplitAt(clip, 1450, 50)).toBe(true);
  });

  it("splits into two clips that together cover the original range", () => {
    const clip = clipAt(1000, 500, 200);
    const { left, right } = splitClip(clip, 1300);
    expect(left.startFrame).toBe(1000);
    expect(left.durationFrames).toBe(300);
    expect(left.offsetFrames).toBe(200);
    expect(right.startFrame).toBe(1300);
    expect(right.durationFrames).toBe(200);
    expect(right.offsetFrames).toBe(500);
    expect(right.assetId).toBe(clip.assetId);
    expect(right.sourceDurationFrames).toBe(clip.sourceDurationFrames);
  });
});

describe("applyLeftTrim / applyRightTrim", () => {
  it("left trim shifts start and offset, shrinks duration", () => {
    const clip = clipAt(1000, 500, 200);
    const trimmed = applyLeftTrim(clip, 50);
    expect(trimmed.startFrame).toBe(1050);
    expect(trimmed.offsetFrames).toBe(250);
    expect(trimmed.durationFrames).toBe(450);
  });

  it("right trim only changes duration", () => {
    const clip = clipAt(1000, 500, 200);
    const trimmed = applyRightTrim(clip, -50);
    expect(trimmed.startFrame).toBe(1000);
    expect(trimmed.offsetFrames).toBe(200);
    expect(trimmed.durationFrames).toBe(450);
  });
});

describe("rippleShift", () => {
  it("shifts clips at or after the edit point, leaves earlier ones alone", () => {
    const a = clipAt(0, 500), b = clipAt(500, 500), c = clipAt(1000, 500);
    const [shiftedA, shiftedB, shiftedC] = rippleShift([a, b, c], 500, -300);
    expect(shiftedA!.startFrame).toBe(0);
    expect(shiftedB!.startFrame).toBe(200);
    expect(shiftedC!.startFrame).toBe(700);
  });

  it("clamps at frame 0", () => {
    const clip = clipAt(0, 500);
    const [shifted] = rippleShift([clip], 0, -1000);
    expect(shifted!.startFrame).toBe(0);
  });

  it("is a no-op copy on zero delta", () => {
    const clip = clipAt(500, 500);
    const [shifted] = rippleShift([clip], 0, 0);
    expect(shifted).not.toBe(clip);
    expect(shifted).toEqual(clip);
  });

  it("shifts a clip starting exactly at the edit point", () => {
    const clip = clipAt(500, 500);
    const [shifted] = rippleShift([clip], 500, -300);
    expect(shifted!.startFrame).toBe(200);
  });
});

describe("applyCropEdge", () => {
  it("sets one edge, clamped to [0,1]", () => {
    const clip = clipAt(0, 100);
    expect(applyCropEdge(clip, "left", 0.3).cropLeft).toBe(0.3);
    expect(applyCropEdge(clip, "left", -1).cropLeft).toBe(0);
    expect(applyCropEdge(clip, "left", 2).cropLeft).toBeLessThanOrEqual(1);
  });

  it("clamps an edge against its opposite so the source is never fully cropped away", () => {
    const clip = { ...clipAt(0, 100), cropRight: 0.8 };
    // Asking for 0.9 on the left, with 0.8 already on the right, would leave -0.7 of the source —
    // clamped so at least 1% remains instead.
    const result = applyCropEdge(clip, "left", 0.9);
    expect(result.cropLeft).toBeCloseTo(0.19, 5);
  });

  it("does not disturb the other three edges", () => {
    const clip = { ...clipAt(0, 100), cropTop: 0.1, cropBottom: 0.2 };
    const result = applyCropEdge(clip, "left", 0.3);
    expect(result.cropTop).toBe(0.1);
    expect(result.cropBottom).toBe(0.2);
  });
});

describe("snapFrame", () => {
  it("snaps to the nearest target within the threshold", () => {
    expect(snapFrame(103, [0, 100, 500], 10)).toBe(100);
  });

  it("passes the candidate through unchanged when nothing is close enough", () => {
    expect(snapFrame(250, [0, 100, 500], 10)).toBe(250);
  });

  it("picks the closer of two targets both within threshold", () => {
    expect(snapFrame(97, [90, 100], 10)).toBe(100);
  });

  it("is exact at the threshold boundary itself", () => {
    expect(snapFrame(110, [100], 10)).toBe(100);
  });
});

describe("applyTransitionCurve", () => {
  it("linear is the identity, clamped to [0,1]", () => {
    expect(applyTransitionCurve("linear", 0)).toBe(0);
    expect(applyTransitionCurve("linear", 0.5)).toBe(0.5);
    expect(applyTransitionCurve("linear", 1)).toBe(1);
    expect(applyTransitionCurve("linear", -1)).toBe(0);
    expect(applyTransitionCurve("linear", 2)).toBe(1);
  });

  it("every curve starts at 0 and ends at 1", () => {
    for (const curve of ["linear", "easeIn", "easeOut", "easeInOut"] as const) {
      expect(applyTransitionCurve(curve, 0)).toBeCloseTo(0, 10);
      expect(applyTransitionCurve(curve, 1)).toBeCloseTo(1, 10);
    }
  });

  it("easeIn starts slower than linear, easeOut starts faster", () => {
    expect(applyTransitionCurve("easeIn", 0.5)).toBeLessThan(0.5);
    expect(applyTransitionCurve("easeOut", 0.5)).toBeGreaterThan(0.5);
  });

  it("easeInOut is symmetric around the midpoint", () => {
    expect(applyTransitionCurve("easeInOut", 0.5)).toBeCloseTo(0.5, 10);
  });
});

describe("transitionBlendAt", () => {
  const transition = createVideoTransition("track-1", "left-clip", "right-clip", 30, "linear");

  it("is 0 at the very start of the overlap and 1 at the very end", () => {
    expect(transitionBlendAt(transition, 100, 130, 100)).toBe(0);
    expect(transitionBlendAt(transition, 100, 130, 130)).toBe(1);
  });

  it("is 0.5 at the midpoint for a linear curve", () => {
    expect(transitionBlendAt(transition, 100, 130, 115)).toBe(0.5);
  });

  it("honors the transition's own curve", () => {
    const eased = createVideoTransition("track-1", "left-clip", "right-clip", 30, "easeIn");
    expect(transitionBlendAt(eased, 100, 130, 115)).toBeLessThan(0.5);
  });
});
