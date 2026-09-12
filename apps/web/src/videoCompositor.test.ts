import { describe, expect, it } from "vitest";
import { createVideoClip, createVideoTrack } from "@vravio/env-video";
import { audioHitsAt } from "./videoCompositor";

describe("audioHitsAt", () => {
  it("uses solo as a real mix gate while preserving the normal mute path", () => {
    const music = createVideoTrack("audio", "Music");
    const voice = createVideoTrack("audio", "Voice");
    music.clips.push(createVideoClip("music", 120, 120, 30));
    voice.clips.push(createVideoClip("voice", 120, 120, 30));

    expect(audioHitsAt([music, voice], 0).map((hit) => hit.clip.assetId)).toEqual(["music", "voice"]);
    voice.solo = true;
    expect(audioHitsAt([music, voice], 0).map((hit) => hit.clip.assetId)).toEqual(["voice"]);
    voice.muted = true;
    expect(audioHitsAt([music, voice], 0)).toEqual([]);
  });
});
