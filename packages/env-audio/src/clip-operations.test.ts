import { describe, expect, it } from "vitest";
import { createAudioClip } from "./document";
import { applyLeftTrim, applyRightTrim, canSplitAt, constrainBoundaryTrim, constrainClipDrag, rippleShift, splitClip } from "./clip-operations";

function clipAt(start: number, duration: number, offset = 0, sourceDuration = duration + 1000): ReturnType<typeof createAudioClip> {
  return createAudioClip("asset", duration, sourceDuration, 48000, { startSample: start, offsetSamples: offset });
}

describe("constrainClipDrag", () => {
  it("allows free movement with no neighbors", () => {
    const clip = clipAt(1000, 500);
    expect(constrainClipDrag(clip, 300, [clip], 0)).toBe(300);
    expect(constrainClipDrag(clip, -300, [clip], 0)).toBe(-300);
  });

  it("clamps at sample 0", () => {
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
    // offsetSamples is large enough that the "offset can't go negative" constraint doesn't
    // also kick in here — this test isolates the "startSample can't go negative" constraint.
    const clip = clipAt(50, 500, 200);
    expect(constrainBoundaryTrim(clip, -100, "left", [clip], 0, minDuration)).toBe(-50);
  });

  it("left trim cannot push offset negative", () => {
    const clip = clipAt(1000, 500, 20);
    expect(constrainBoundaryTrim(clip, -100, "left", [clip], 0, minDuration)).toBe(-20);
  });

  it("left trim respects minimum duration", () => {
    const clip = clipAt(1000, 500, 200);
    // shrinking from the left by more than durationSamples - minDuration should clamp
    expect(constrainBoundaryTrim(clip, 450, "left", [clip], 0, minDuration)).toBe(400);
  });

  it("right trim respects minimum duration when shrinking", () => {
    const clip = clipAt(1000, 500, 0);
    expect(constrainBoundaryTrim(clip, -450, "right", [clip], 0, minDuration)).toBe(-400);
  });

  it("right trim cannot exceed the source's remaining length", () => {
    const clip = clipAt(1000, 500, 0, 600); // sourceDuration 600, offset 0, duration 500 -> 100 samples of source left
    expect(constrainBoundaryTrim(clip, 300, "right", [clip], 0, minDuration)).toBe(100);
  });

  it("right trim cannot overlap the next clip", () => {
    const clip = clipAt(0, 500, 0, 10000);
    const next = clipAt(700, 500);
    expect(constrainBoundaryTrim(clip, 400, "right", [clip, next], 0, minDuration)).toBe(200);
  });
});

describe("canSplitAt / splitClip", () => {
  it("rejects a split at or outside the clip's bounds", () => {
    const clip = clipAt(1000, 500);
    expect(canSplitAt(clip, 1000, 50)).toBe(false); // at start
    expect(canSplitAt(clip, 1500, 50)).toBe(false); // at end
    expect(canSplitAt(clip, 900, 50)).toBe(false); // before start
  });

  it("rejects a split that leaves either half under the minimum duration", () => {
    const clip = clipAt(1000, 500);
    expect(canSplitAt(clip, 1030, 50)).toBe(false); // left half would be 30
    expect(canSplitAt(clip, 1470, 50)).toBe(false); // right half would be 30
  });

  it("accepts a valid interior split", () => {
    const clip = clipAt(1000, 500);
    expect(canSplitAt(clip, 1250, 50)).toBe(true);
  });

  it("splits into two clips with the correct bounds and inherited fades", () => {
    const clip = createAudioClip("asset", 500, 5000, 48000, { startSample: 1000, offsetSamples: 100, name: "Take 1", fadeInSamples: 40, fadeOutSamples: 60 });
    const { left, right } = splitClip(clip, 1250);

    expect(left.startSample).toBe(1000);
    expect(left.durationSamples).toBe(250);
    expect(left.offsetSamples).toBe(100);
    expect(left.fadeInSamples).toBe(40);
    expect(left.fadeOutSamples).toBe(0);

    expect(right.startSample).toBe(1250);
    expect(right.durationSamples).toBe(250);
    expect(right.offsetSamples).toBe(350); // 100 + 250 (left duration)
    expect(right.fadeInSamples).toBe(0);
    expect(right.fadeOutSamples).toBe(60);

    expect(left.assetId).toBe("asset");
    expect(right.assetId).toBe("asset");
  });
});

describe("applyLeftTrim / applyRightTrim", () => {
  it("left trim shifts start+offset and shrinks duration together", () => {
    const clip = clipAt(1000, 500, 20);
    const trimmed = applyLeftTrim(clip, 100);
    expect(trimmed.startSample).toBe(1100);
    expect(trimmed.offsetSamples).toBe(120);
    expect(trimmed.durationSamples).toBe(400);
  });

  it("right trim only changes duration", () => {
    const clip = clipAt(1000, 500);
    const trimmed = applyRightTrim(clip, -100);
    expect(trimmed.startSample).toBe(1000);
    expect(trimmed.durationSamples).toBe(400);
  });
});

describe("rippleShift", () => {
  it("shifts every clip at or after the edit point by the delta, closing a gap", () => {
    const a = clipAt(0, 500), b = clipAt(500, 500), c = clipAt(1000, 500);
    const [shiftedA, shiftedB, shiftedC] = rippleShift([a, b, c], 500, -300);
    expect(shiftedA!.startSample).toBe(0); // before the edit point: untouched
    expect(shiftedB!.startSample).toBe(200); // at the edit point: shifted
    expect(shiftedC!.startSample).toBe(700); // after: shifted by the same delta
  });

  it("clamps a shift that would push a clip's start negative", () => {
    const clip = clipAt(100, 500);
    const [shifted] = rippleShift([clip], 0, -1000);
    expect(shifted!.startSample).toBe(0);
  });

  it("is a no-op copy at delta 0, never aliasing the input clips", () => {
    const clip = clipAt(500, 500);
    const [shifted] = rippleShift([clip], 0, 0);
    expect(shifted).not.toBe(clip);
    expect(shifted!.startSample).toBe(500);
  });

  it("leaves clips entirely before the edit point untouched even when they extend past it", () => {
    // A clip starting before fromSample is "before the edit" by this function's own contract
    // (checked by startSample, not by whether the clip's span crosses the point) — overlap
    // policy for a clip straddling the edit point is the caller's decision, not this one's.
    const clip = clipAt(0, 1000);
    const [shifted] = rippleShift([clip], 500, -300);
    expect(shifted!.startSample).toBe(0);
  });
});
