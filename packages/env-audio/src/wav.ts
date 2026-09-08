/**
 * Minimal PCM WAV (RIFF/WAVE) codec — no compressed formats, no exotic extension chunks, just
 * the canonical 44-byte-header shape every decoder (including the browser's own) reads without
 * a fallback path. 16/24-bit integer PCM or 32-bit IEEE float, interleaved.
 *
 * This doubles as VRAVIO's own internal "audio asset" format: rather than inventing a bespoke
 * binary layout the way `raster-asset.ts` does for pixels (VRAVIO's own layers have no
 * existing universal file format to piggyback on), audio already has one — WAV is lossless,
 * self-describing, and every non-WAV import (MP3, OGG, …) gets decoded once at import time
 * (via the browser's `AudioContext.decodeAudioData`, in `apps/web`) and re-encoded to WAV for
 * storage, the same "decode once at the boundary" shape `decodeImportedImage` already uses for
 * pictures. What's stored is a real, standard WAV file — nothing bespoke to keep readable.
 */

function clamp(value: number): number { return Math.max(-1, Math.min(1, value)); }

function writeString(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
}

export type WavBitDepth = 16 | 24 | 32;

export interface DecodedWav {
  readonly channelData: Float32Array[];
  readonly sampleRate: number;
}

/** `bitDepth: 32` writes IEEE-float PCM (format tag 3); 16/24 write signed integer PCM
 * (format tag 1) — a float-tagged file played back as integer PCM is audible noise, not just
 * quieter audio, so the tag has to match what was actually written. */
export function encodeWav(channels: readonly Float32Array[], sampleRate: number, bitDepth: WavBitDepth = 16): Uint8Array {
  if (channels.length === 0) throw new RangeError("encodeWav needs at least one channel");
  const numChannels = channels.length;
  const numFrames = channels[0]!.length;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = numFrames * blockAlign;
  const isFloat = bitDepth === 32;

  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, isFloat ? 3 : 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeString(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let frame = 0; frame < numFrames; frame += 1) {
    for (let c = 0; c < numChannels; c += 1) {
      const sample = clamp(channels[c]![frame] ?? 0);
      if (isFloat) {
        view.setFloat32(offset, sample, true);
      } else if (bitDepth === 16) {
        view.setInt16(offset, Math.round(sample * (sample < 0 ? 0x8000 : 0x7fff)), true);
      } else {
        const value = Math.round(sample * (sample < 0 ? 0x800000 : 0x7fffff));
        view.setUint8(offset, value & 0xff);
        view.setUint8(offset + 1, (value >> 8) & 0xff);
        view.setUint8(offset + 2, (value >> 16) & 0xff);
      }
      offset += bytesPerSample;
    }
  }
  return new Uint8Array(buffer);
}

/** Whether these bytes look like a RIFF/WAVE file, without throwing to find out. */
export function isWav(bytes: Uint8Array): boolean {
  if (bytes.length < 44) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(0, false) === 0x52494646 /* "RIFF" */ && view.getUint32(8, false) === 0x57415645 /* "WAVE" */;
}

/**
 * Decodes a canonical PCM WAV file. Walks chunks rather than assuming the 44-byte fixed layout
 * `encodeWav` writes — a WAV from another tool routinely carries a `LIST`/`fact`/`JUNK` chunk
 * before `data`, and trusting a fixed offset there silently reads garbage as audio instead of
 * failing loudly.
 */
export function decodeWav(bytes: Uint8Array): DecodedWav {
  if (!isWav(bytes)) throw new RangeError("Not a RIFF/WAVE file");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let numChannels = 0, sampleRate = 0, bitsPerSample = 0, formatTag = 1;
  let dataOffset = -1, dataSize = 0;

  let offset = 12; // past "RIFF" size "WAVE"
  while (offset + 8 <= bytes.length) {
    const id = view.getUint32(offset, false);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 0x666d7420 /* "fmt " */) {
      formatTag = view.getUint16(body, true);
      numChannels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
    } else if (id === 0x64617461 /* "data" */) {
      dataOffset = body;
      dataSize = Math.min(size, bytes.length - body);
    }
    offset = body + size + (size % 2); // chunks are word-aligned
  }

  if (dataOffset < 0) throw new RangeError("WAV file has no data chunk");
  if (numChannels < 1 || sampleRate <= 0) throw new RangeError("WAV file has an invalid fmt chunk");
  if (bitsPerSample !== 16 && bitsPerSample !== 24 && bitsPerSample !== 32) throw new RangeError(`Unsupported WAV bit depth: ${bitsPerSample}`);

  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const numFrames = Math.floor(dataSize / blockAlign);
  const channelData = Array.from({ length: numChannels }, () => new Float32Array(numFrames));
  const isFloat = formatTag === 3;

  let cursor = dataOffset;
  for (let frame = 0; frame < numFrames; frame += 1) {
    for (let c = 0; c < numChannels; c += 1) {
      let sample: number;
      if (isFloat) sample = view.getFloat32(cursor, true);
      else if (bitsPerSample === 16) sample = view.getInt16(cursor, true) / 0x8000;
      else {
        const raw = bytes[cursor]! | (bytes[cursor + 1]! << 8) | (bytes[cursor + 2]! << 16);
        const signed = raw & 0x800000 ? raw - 0x1000000 : raw;
        sample = signed / 0x800000;
      }
      channelData[c]![frame] = sample;
      cursor += bytesPerSample;
    }
  }
  return { channelData, sampleRate };
}
