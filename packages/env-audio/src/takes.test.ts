import { describe, expect, it } from "vitest";
import { createAudioClip } from "./document";
import { addTake, canPunchIn, cycleTake, punchInClip, setActiveTake } from "./takes";

describe("addTake", () => {
  it("appends a new take and makes it active without losing the original", () => {
    const clip = createAudioClip("asset-a", 1000, 1000, 48000, { startSample: 0 });
    const withTake = addTake(clip, { assetId: "asset-b", sourceDurationSamples: 900, sourceSampleRate: 48000 });
    expect(withTake.takes).toHaveLength(2);
    expect(withTake.takes[0]!.assetId).toBe("asset-a");
    expect(withTake.takes[1]!.assetId).toBe("asset-b");
    expect(withTake.activeTakeIndex).toBe(1);
    expect(withTake.assetId).toBe("asset-b");
  });
});

describe("setActiveTake / cycleTake", () => {
  function twoTakeClip() {
    const clip = createAudioClip("asset-a", 1000, 5000, 48000, { startSample: 0, offsetSamples: 200 });
    return addTake(clip, { assetId: "asset-b", sourceDurationSamples: 5000, sourceSampleRate: 48000 });
  }

  it("switches the active take and its resolved fields", () => {
    const clip = twoTakeClip();
    const back = setActiveTake(clip, 0);
    expect(back.activeTakeIndex).toBe(0);
    expect(back.assetId).toBe("asset-a");
  });

  it("clamps offset/duration against a shorter take", () => {
    const clip = createAudioClip("asset-a", 1000, 5000, 48000, { startSample: 0, offsetSamples: 400 });
    const short = addTake(clip, { assetId: "short", sourceDurationSamples: 500, sourceSampleRate: 48000 });
    // offset 400, duration was 1000 -> new source only has 500 samples total
    expect(short.offsetSamples).toBeLessThanOrEqual(500);
    expect(short.offsetSamples + short.durationSamples).toBeLessThanOrEqual(500);
  });

  it("does nothing for an out-of-range index", () => {
    const clip = twoTakeClip();
    expect(setActiveTake(clip, 5)).toBe(clip);
    expect(setActiveTake(clip, -1)).toBe(clip);
  });

  it("cycleTake wraps forward and backward", () => {
    const clip = twoTakeClip(); // active index 1
    const wrappedForward = cycleTake(clip, 1);
    expect(wrappedForward.activeTakeIndex).toBe(0);
    const wrappedBackward = cycleTake(clip, -1);
    expect(wrappedBackward.activeTakeIndex).toBe(0);
  });

  it("cycleTake is a no-op with only one take", () => {
    const clip = createAudioClip("asset-a", 1000, 1000, 48000);
    expect(cycleTake(clip, 1)).toBe(clip);
  });
});

describe("canPunchIn", () => {
  it("accepts a range strictly inside the clip", () => {
    const clip = createAudioClip("asset-a", 1000, 5000, 48000, { startSample: 1000 });
    expect(canPunchIn(clip, 1200, 1400)).toBe(true);
  });

  it("rejects a range touching or crossing either edge", () => {
    const clip = createAudioClip("asset-a", 1000, 5000, 48000, { startSample: 1000 });
    expect(canPunchIn(clip, 900, 1400)).toBe(false); // before start
    expect(canPunchIn(clip, 1800, 2200)).toBe(false); // past end
    expect(canPunchIn(clip, 1400, 1400)).toBe(false); // empty range
  });
});

describe("punchInClip", () => {
  it("splits into before/punched/after when the range is in the interior", () => {
    const clip = createAudioClip("asset-a", 1000, 5000, 48000, { startSample: 1000, offsetSamples: 200, name: "Take (Дубль)" });
    const { before, punched, after } = punchInClip(clip, 1300, 1600, { assetId: "punch-take", sourceDurationSamples: 400, sourceSampleRate: 48000 });

    expect(before).not.toBeNull();
    expect(before!.startSample).toBe(1000);
    expect(before!.durationSamples).toBe(300); // 1300 - 1000
    expect(before!.assetId).toBe("asset-a"); // untouched, original take

    expect(punched.startSample).toBe(1300);
    expect(punched.durationSamples).toBe(300); // 1600 - 1300
    expect(punched.assetId).toBe("punch-take");
    expect(punched.offsetSamples).toBe(0); // fresh recording, starts at its own beginning

    expect(after).not.toBeNull();
    expect(after!.startSample).toBe(1600);
    expect(after!.durationSamples).toBe(400); // (1000+1000) - 1600
    expect(after!.offsetSamples).toBe(200 + 600); // original offset + how far into the clip 1600 is
    expect(after!.assetId).toBe("asset-a");
  });

  it("has no before piece when the punch starts exactly at the clip's own start", () => {
    const clip = createAudioClip("asset-a", 1000, 5000, 48000, { startSample: 1000 });
    const { before, after } = punchInClip(clip, 1000, 1300, { assetId: "p", sourceDurationSamples: 300, sourceSampleRate: 48000 });
    expect(before).toBeNull();
    expect(after).not.toBeNull();
  });

  it("has no after piece when the punch ends exactly at the clip's own end", () => {
    const clip = createAudioClip("asset-a", 1000, 5000, 48000, { startSample: 1000 });
    const { before, after } = punchInClip(clip, 1700, 2000, { assetId: "p", sourceDurationSamples: 300, sourceSampleRate: 48000 });
    expect(after).toBeNull();
    expect(before).not.toBeNull();
  });

  it("replacing the whole clip's own span leaves neither before nor after", () => {
    const clip = createAudioClip("asset-a", 1000, 5000, 48000, { startSample: 1000 });
    const { before, after, punched } = punchInClip(clip, 1000, 2000, { assetId: "p", sourceDurationSamples: 1000, sourceSampleRate: 48000 });
    expect(before).toBeNull();
    expect(after).toBeNull();
    expect(punched.durationSamples).toBe(1000);
  });
});
