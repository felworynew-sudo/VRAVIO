import { isAudioDocumentState } from "@vravio/env-audio";
import { readClipAudioWindow, replaceClipAudio } from "../../../audio-commands";
import type { PluginPayload, PluginSurface } from "../../../plugins/types";

/**
 * How the audio environment lets a plugin see and change a document — and the
 * proof that the plugin system is no longer raster-shaped: nothing in
 * `plugins/` changed to make this work, because nothing in `plugins/` knows
 * what any environment's payload is.
 *
 * A plugin operates on the *selected clip's audible window*, the same scope a
 * destructive effect applies at, and the result goes back through the same
 * `replaceClipAudio` those effects use. Audio's door is module-level (unlike
 * raster's hook-bound `commitPixels`), so this surface needs nothing from the
 * workspace beyond which clip is selected.
 *
 * The payload is interleaved 32-bit float, the one layout that survives
 * `postMessage` as a single transferable buffer without inventing a container:
 * `meta.channels` and `meta.frames` say how to read it back, and a plugin that
 * only wants the first channel can stride past the rest.
 */

export interface AudioPluginDoor {
  readonly documentId: string;
  readonly trackId: string;
  readonly clipId: string;
}

function interleave(channels: readonly Float32Array[]): Float32Array {
  const count = channels.length, frames = channels[0]?.length ?? 0;
  const out = new Float32Array(frames * count);
  for (let channel = 0; channel < count; channel += 1) {
    const source = channels[channel]!;
    for (let frame = 0; frame < frames; frame += 1) out[frame * count + channel] = source[frame]!;
  }
  return out;
}

function deinterleave(interleaved: Float32Array, count: number): Float32Array[] {
  const frames = Math.floor(interleaved.length / Math.max(1, count));
  return Array.from({ length: count }, (_unused, channel) => {
    const out = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame += 1) out[frame] = interleaved[frame * count + channel]!;
    return out;
  });
}

const surface: PluginSurface = {
  payloadKind: "samples",

  async read(state, door) {
    if (!isAudioDocumentState(state)) return null;
    const { documentId, trackId, clipId } = door as AudioPluginDoor;
    const window = await readClipAudioWindow(documentId, trackId, clipId);
    if (!window) return null;
    const interleaved = interleave(window.channels);
    return {
      kind: "samples",
      buffer: interleaved.buffer as ArrayBuffer,
      meta: { sampleRate: window.sampleRate, channels: window.channels.length, frames: window.channels[0]?.length ?? 0 },
    };
  },

  accept(returned, sent) {
    if (returned.kind !== sent.kind) return `returned "${returned.kind}" where this environment expects "${sent.kind}"`;
    if (!returned.buffer) return null;
    // Unlike a picture, audio may legitimately come back a different length — a
    // plugin that stretches or trims is doing its job — so only the things that
    // would make the buffer unreadable are refused: a channel count that does
    // not divide it, or a count that disagrees with what was sent (a plugin
    // that turns stereo into mono has changed a property of the clip that this
    // path does not carry).
    const channels = Number(returned.meta.channels ?? sent.meta.channels);
    if (!Number.isInteger(channels) || channels < 1) return `returned an invalid channel count: ${String(returned.meta.channels)}`;
    if (channels !== Number(sent.meta.channels)) return `returned ${channels} channels, expected ${String(sent.meta.channels)}`;
    if (returned.buffer.byteLength % (channels * Float32Array.BYTES_PER_ELEMENT) !== 0) {
      return `returned ${returned.buffer.byteLength} bytes, which is not whole frames of ${channels} channels`;
    }
    return null;
  },

  async commit(returned, sent, _state, door) {
    if (!returned.buffer) return;
    const { documentId, trackId, clipId } = door as AudioPluginDoor;
    const channels = deinterleave(new Float32Array(returned.buffer), Number(sent.meta.channels));
    await replaceClipAudio(documentId, trackId, clipId, channels, Number(sent.meta.sampleRate), "Plugin");
  },
};

export default surface;
