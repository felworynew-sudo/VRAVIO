import { describe, expect, it } from "vitest";
import {
  cloneVideoState, createVideoClip, createVideoClipEffect, createVideoDocument, createVideoKeyframe, createVideoTitleClip, createVideoTrack,
  effectiveClipValue, evaluateKeyframedValue, findClip, findTrack, isVideoDocumentState, migrateVideoDocumentState, timelineDurationFrames,
} from "./document";

describe("createVideoDocument", () => {
  it("starts with one empty video track and sane defaults", () => {
    const state = createVideoDocument();
    expect(state.kind).toBe("video");
    expect(state.tracks).toHaveLength(1);
    expect(state.tracks[0]!.kind).toBe("video");
    expect(state.tracks[0]!.clips).toHaveLength(0);
    expect(state.activeTrackId).toBe(state.tracks[0]!.id);
    expect(state.frameRate).toBe(30);
    expect(state.width).toBe(1920);
    expect(state.height).toBe(1080);
    expect(isVideoDocumentState(state)).toBe(true);
  });

  it("honors explicit frame rate/dimensions", () => {
    const state = createVideoDocument({ frameRate: 24, width: 3840, height: 2160 });
    expect(state.frameRate).toBe(24);
    expect(state.width).toBe(3840);
    expect(state.height).toBe(2160);
  });
});

describe("isVideoDocumentState", () => {
  it("rejects non-video and malformed values", () => {
    expect(isVideoDocumentState(null)).toBe(false);
    expect(isVideoDocumentState({ kind: "audio" })).toBe(false);
    expect(isVideoDocumentState({ kind: "video", schemaVersion: 1 })).toBe(false); // no tracks/frameRate
  });
});

describe("track and clip creation", () => {
  it("creates tracks with unique ids and default mixer state", () => {
    const a = createVideoTrack("video"), b = createVideoTrack("audio");
    expect(a.id).not.toBe(b.id);
    expect(a.kind).toBe("video");
    expect(b.kind).toBe("audio");
    expect(a.volume).toBe(1);
    expect(a.muted).toBe(false);
    expect(a.solo).toBe(false);
    expect(a.hidden).toBe(false);
    expect(a.locked).toBe(false);
  });

  it("creates a clip referencing an asset with defaults", () => {
    const clip = createVideoClip("asset-1", 1000, 5000, 30);
    expect(clip.assetId).toBe("asset-1");
    expect(clip.durationFrames).toBe(1000);
    expect(clip.sourceDurationFrames).toBe(5000);
    expect(clip.startFrame).toBe(0);
    expect(clip.offsetFrames).toBe(0);
    expect(clip.gain).toBe(1);
    expect(clip.sourceFrameRate).toBe(30);
  });
});

describe("findTrack / findClip", () => {
  it("locates a track and clip by id", () => {
    const state = createVideoDocument();
    const track = state.tracks[0]!;
    const clip = createVideoClip("asset-1", 100, 100, 30);
    track.clips.push(clip);
    expect(findTrack(state, track.id)).toBe(track);
    expect(findClip(state, track.id, clip.id)).toBe(clip);
    expect(findClip(state, track.id, "missing")).toBeUndefined();
  });
});

describe("timelineDurationFrames", () => {
  it("is the end of the latest clip across every track", () => {
    const state = createVideoDocument();
    const [trackA] = state.tracks;
    const trackB = createVideoTrack("audio");
    state.tracks.push(trackB);
    trackA!.clips.push(createVideoClip("a", 1000, 1000, 30, { startFrame: 0 }));
    trackB.clips.push(createVideoClip("b", 500, 500, 30, { startFrame: 2000 }));
    expect(timelineDurationFrames(state)).toBe(2500);
  });

  it("is zero for an empty document", () => {
    expect(timelineDurationFrames(createVideoDocument())).toBe(0);
  });
});

describe("cloneVideoState", () => {
  it("deep-copies tracks/clips/selection so mutating the clone leaves the original untouched", () => {
    const state = createVideoDocument();
    state.tracks[0]!.clips.push(createVideoClip("a", 100, 100, 30));
    state.selection = { trackId: state.tracks[0]!.id, clipIds: [state.tracks[0]!.clips[0]!.id] };

    const clone = cloneVideoState(state);
    clone.tracks[0]!.clips[0]!.gain = 0.5;
    clone.selection!.clipIds.push("extra");
    clone.tracks.push(createVideoTrack("audio"));

    expect(state.tracks[0]!.clips[0]!.gain).toBe(1);
    expect(state.selection!.clipIds).toHaveLength(1);
    expect(state.tracks).toHaveLength(1);
  });
});

describe("migrateVideoDocumentState", () => {
  it("adds hidden=false to a track restored from before it existed", () => {
    const state = createVideoDocument();
    delete (state.tracks[0] as { hidden?: unknown }).hidden;

    migrateVideoDocumentState(state);

    expect(state.tracks[0]!.hidden).toBe(false);
  });

  it("is idempotent — running it again on an already-migrated track changes nothing", () => {
    const state = createVideoDocument();
    state.tracks[0]!.hidden = true;
    migrateVideoDocumentState(state);
    expect(state.tracks[0]!.hidden).toBe(true);
  });

  it("adds solo=false to a track saved before solo existed", () => {
    const state = createVideoDocument();
    delete (state.tracks[0] as { solo?: unknown }).solo;
    migrateVideoDocumentState(state);
    expect(state.tracks[0]!.solo).toBe(false);
  });
});

describe("isVideoDocumentState migrates on the way in", () => {
  it("recognizes and repairs a pre-hidden-field document as valid", () => {
    const state = createVideoDocument();
    delete (state.tracks[0] as { hidden?: unknown }).hidden;
    expect(isVideoDocumentState(state)).toBe(true);
    expect(state.tracks[0]!.hidden).toBe(false);
  });
});

describe("evaluateKeyframedValue", () => {
  it("falls back to the static value when there are no keyframes", () => {
    expect(evaluateKeyframedValue(undefined, 50, 42)).toBe(42);
    expect(evaluateKeyframedValue([], 50, 42)).toBe(42);
  });

  it("holds the first keyframe's value before it", () => {
    const keyframes = [createVideoKeyframe(10, 100), createVideoKeyframe(20, 200)];
    expect(evaluateKeyframedValue(keyframes, 0, -1)).toBe(100);
    expect(evaluateKeyframedValue(keyframes, 10, -1)).toBe(100);
  });

  it("holds the last keyframe's value after it", () => {
    const keyframes = [createVideoKeyframe(10, 100), createVideoKeyframe(20, 200)];
    expect(evaluateKeyframedValue(keyframes, 20, -1)).toBe(200);
    expect(evaluateKeyframedValue(keyframes, 999, -1)).toBe(200);
  });

  it("interpolates linearly between two keyframes", () => {
    const keyframes = [createVideoKeyframe(0, 0), createVideoKeyframe(10, 100)];
    expect(evaluateKeyframedValue(keyframes, 5, -1)).toBe(50);
    expect(evaluateKeyframedValue(keyframes, 2, -1)).toBe(20);
  });

  it("interpolates correctly regardless of input order", () => {
    const keyframes = [createVideoKeyframe(10, 100), createVideoKeyframe(0, 0)];
    expect(evaluateKeyframedValue(keyframes, 5, -1)).toBe(50);
  });

  it("picks the right segment across three or more keyframes", () => {
    const keyframes = [createVideoKeyframe(0, 0), createVideoKeyframe(10, 100), createVideoKeyframe(20, 0)];
    expect(evaluateKeyframedValue(keyframes, 5, -1)).toBe(50);
    expect(evaluateKeyframedValue(keyframes, 15, -1)).toBe(50);
    expect(evaluateKeyframedValue(keyframes, 10, -1)).toBe(100);
  });
});

describe("effectiveClipValue", () => {
  it("uses the flat field when the parameter has no keyframes", () => {
    const clip = createVideoClip("asset-1", 100, 100, 30, {});
    clip.opacity = 0.5;
    expect(effectiveClipValue(clip, "opacity", 999)).toBe(0.5);
  });

  it("uses keyframed interpolation when the parameter has keyframes", () => {
    const clip = createVideoClip("asset-1", 100, 100, 30, {});
    clip.opacity = 1; // flat value ignored once keyframed
    clip.keyframes.opacity = [createVideoKeyframe(0, 0), createVideoKeyframe(100, 1)];
    expect(effectiveClipValue(clip, "opacity", 50)).toBe(0.5);
  });
});

describe("createVideoClipEffect", () => {
  it("seeds params from the catalog's own defaults and starts enabled", () => {
    const effect = createVideoClipEffect("brightness");
    expect(effect.effectId).toBe("brightness");
    expect(effect.enabled).toBe(true);
    expect(effect.params.amount).toBe(100);
  });
});

describe("cloneVideoState deep-clones effects and keyframes", () => {
  it("mutating a clone's clip effects/keyframes does not bleed into the original", () => {
    const state = createVideoDocument();
    const clip = createVideoClip("asset-1", 100, 100, 30, {});
    clip.effects.push(createVideoClipEffect("blur"));
    clip.keyframes.x = [createVideoKeyframe(0, 0)];
    state.tracks[0]!.clips.push(clip);

    const clone = cloneVideoState(state);
    clone.tracks[0]!.clips[0]!.effects[0]!.params.pixels = 99;
    clone.tracks[0]!.clips[0]!.keyframes.x![0]!.value = 999;

    expect(state.tracks[0]!.clips[0]!.effects[0]!.params.pixels).not.toBe(99);
    expect(state.tracks[0]!.clips[0]!.keyframes.x![0]!.value).not.toBe(999);
  });
});

describe("createVideoTitleClip", () => {
  it("has no assetId and carries its own text content", () => {
    const clip = createVideoTitleClip("Hello", 90, { startFrame: 30 });
    expect(clip.assetId).toBe("");
    expect(clip.startFrame).toBe(30);
    expect(clip.durationFrames).toBe(90);
    expect(clip.title).toBeDefined();
    expect(clip.title!.text).toBe("Hello");
    expect(clip.title!.align).toBe("center");
  });

  it("honors style overrides", () => {
    const clip = createVideoTitleClip("Hi", 30, { fontSize: 32, color: "#ff0000", align: "left" });
    expect(clip.title!.fontSize).toBe(32);
    expect(clip.title!.color).toBe("#ff0000");
    expect(clip.title!.align).toBe("left");
  });
});

describe("cloneVideoState deep-clones title content", () => {
  it("mutating a clone's title does not bleed into the original", () => {
    const state = createVideoDocument();
    const titleClip = createVideoTitleClip("Original", 90);
    state.tracks[0]!.clips.push(titleClip);

    const clone = cloneVideoState(state);
    clone.tracks[0]!.clips[0]!.title!.text = "Changed";

    expect(state.tracks[0]!.clips[0]!.title!.text).toBe("Original");
  });
});
