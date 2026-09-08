import { encodeWav } from "@vravio/env-audio";

/**
 * Decodes any format the browser's own media stack understands (MP3, OGG, WAV, FLAC, AAC,
 * whatever `AudioContext.decodeAudioData` accepts locally) and re-encodes it to WAV — VRAVIO's
 * own internal audio asset format (`packages/env-audio/src/wav.ts`). One decode at the import
 * boundary, the same shape `decodeImportedImage` already uses for pictures: whatever exotic
 * format a user drops in, what's actually stored is something this codebase can read back
 * itself without leaning on the browser a second time.
 */
/** Encodes whatever `MediaRecorder` produced (webm/opus, typically) back through the same
 * decode-then-WAV path a dropped file goes through — a recording is not a special case, it is
 * an import whose source happens to be the microphone instead of a file. */
async function decodeBlobToWav(blob: Blob): Promise<Uint8Array | null> {
  return decodeAudioFileToWav(new File([blob], "recording", { type: blob.type }));
}

export interface AudioRecorder {
  /** Stops capture and resolves with the recorded audio, re-encoded to WAV — `null` if nothing
   * was captured or the browser's own decode of its own recording failed. */
  stop(): Promise<Uint8Array | null>;
}

/**
 * Starts recording from the default microphone. Asking for the microphone (`getUserMedia`)
 * requires a user gesture and shows the browser's own permission prompt — expected and correct
 * here, unlike the native file-save dialog `kernel.platform.fs.saveFile` triggers, since a
 * permission prompt is a one-time, user-facing decision this feature genuinely needs, not an
 * artifact of implementation choice.
 */
export async function startMicrophoneRecording(): Promise<AudioRecorder> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const chunks: Blob[] = [];
  const recorder = new MediaRecorder(stream);
  recorder.ondataavailable = (event) => { if (event.data.size > 0) chunks.push(event.data); };
  const stopped = new Promise<void>((resolve) => { recorder.onstop = () => resolve(); });
  recorder.start();

  return {
    async stop(): Promise<Uint8Array | null> {
      recorder.stop();
      await stopped;
      for (const track of stream.getTracks()) track.stop();
      if (chunks.length === 0) return null;
      return decodeBlobToWav(new Blob(chunks, { type: recorder.mimeType }));
    },
  };
}

export async function decodeAudioFileToWav(file: File): Promise<Uint8Array | null> {
  let context: AudioContext | null = null;
  try {
    const bytes = await file.arrayBuffer();
    context = new AudioContext();
    const buffer = await context.decodeAudioData(bytes);
    const channelData = Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel));
    // 32-bit float: this is the asset's at-rest storage, not a delivery export — full headroom,
    // no quantization, so re-encoding losslessly is possible at any later point.
    return encodeWav(channelData, buffer.sampleRate, 32);
  } catch {
    return null;
  } finally {
    void context?.close();
  }
}
