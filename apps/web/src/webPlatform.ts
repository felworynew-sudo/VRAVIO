import type { ClipboardImage, ClipboardPort, CodecPort, FileSystemPort, FontPort, GPUContext, MLPort, OpenFileOptions, Platform, PlatformCapabilities, PlatformFile, SaveFileOptions, SaveFileResult } from "@vravio/kernel";
import { OpfsStorageAdapter, type ModelStore } from "@vravio/kernel";
import { createOnnxRuntime } from "./onnxRuntime";

interface BrowserFileHandle {
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(data: Blob | ArrayBuffer): Promise<void>; close(): Promise<void> }>;
}

interface BrowserWindow extends Window {
  showOpenFilePicker?: (options?: unknown) => Promise<BrowserFileHandle[]>;
  showSaveFilePicker?: (options?: unknown) => Promise<BrowserFileHandle>;
  queryLocalFonts?: () => Promise<Array<{ family: string; fullName: string; style: string }>>;
}

const browserWindow = globalThis as unknown as BrowserWindow;

function inputFallback(options: OpenFileOptions): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = options.multiple ?? false;
    input.accept = Object.entries(options.accept ?? {}).flatMap(([mime, extensions]) => [mime, ...extensions]).join(",");
    input.onchange = () => resolve([...input.files ?? []]);
    input.oncancel = () => resolve([]);
    input.click();
  });
}

class WebFileSystem implements FileSystemPort {
  async openFiles(options: OpenFileOptions = {}): Promise<readonly PlatformFile[]> {
    const files = browserWindow.showOpenFilePicker
      ? await browserWindow.showOpenFilePicker({ multiple: options.multiple ?? false, types: options.accept ? [{ accept: options.accept }] : undefined }).then((handles) => Promise.all(handles.map((handle) => handle.getFile())))
      : await inputFallback(options);
    return Promise.all(files.map(async (file) => ({ name: file.name, mime: file.type || "application/octet-stream", size: file.size, lastModified: file.lastModified, data: new Uint8Array(await file.arrayBuffer()) })));
  }

  async saveFile(options: SaveFileOptions): Promise<SaveFileResult> {
    const blob = options.data instanceof Blob ? options.data : new Blob([options.data.slice().buffer], { type: options.mime });
    if (browserWindow.showSaveFilePicker) {
      const handle = await browserWindow.showSaveFilePicker({ suggestedName: options.name, types: [{ description: options.mime, accept: { [options.mime]: [`.${options.name.split(".").pop() ?? "bin"}`] } }] });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return { name: options.name, method: "native-picker" };
    }
    const url = URL.createObjectURL(blob), anchor = document.createElement("a");
    anchor.href = url; anchor.download = options.name; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    return { name: options.name, method: "download" };
  }
}

class WebCodecs implements CodecPort {
  readonly preferredVideoExport = ["video/mp4;codecs=avc1.42E01E", "video/webm;codecs=vp9", "video/webm;codecs=vp8"];
  readonly preferredAudioExport = ["audio/wav", "audio/webm;codecs=opus", "audio/mp4;codecs=mp4a.40.2"];
  async supports(mime: string): Promise<boolean> {
    if (typeof MediaSource !== "undefined" && MediaSource.isTypeSupported(mime)) return true;
    const element = document.createElement(mime.startsWith("audio/") ? "audio" : "video");
    return element.canPlayType(mime) !== "";
  }
}

class WebFonts implements FontPort {
  async listLocalFonts() {
    if (!browserWindow.queryLocalFonts) return [];
    return (await browserWindow.queryLocalFonts()).map((font) => ({ family: font.family, fullName: font.fullName, style: font.style }));
  }
}

/**
 * The browser clipboard.
 *
 * Writing an image is `ClipboardItem` with a PNG blob — the one format every
 * browser agrees to accept, which is why the caller is asked for PNG rather
 * than given a choice.
 *
 * Reading is deliberately forgiving. `navigator.clipboard.read` rejects when
 * the user declines the permission prompt, when the document is not focused,
 * and when the clipboard holds nothing it will admit to — none of which is an
 * error the user wants reported. All of them mean the same thing to a Paste
 * command: there is no image to paste.
 */
class WebClipboard implements ClipboardPort {
  readonly canReadImages = typeof navigator !== "undefined" && typeof navigator.clipboard?.read === "function";

  async writeImage(image: Blob): Promise<void> {
    await navigator.clipboard.write([new ClipboardItem({ [image.type || "image/png"]: image })]);
  }

  async readImage(): Promise<ClipboardImage> {
    if (!this.canReadImages) return { kind: "denied" };
    try {
      for (const item of await navigator.clipboard.read()) {
        const type = item.types.find((candidate) => candidate.startsWith("image/"));
        if (type) return { kind: "image", image: await item.getType(type) };
      }
      return { kind: "empty" };
    } catch (error) {
      // `NotAllowedError` is the permission being refused, and it is the one
      // failure worth telling the user about — every other rejection here
      // (unfocused document, nothing readable) is indistinguishable from an
      // empty clipboard and is treated as one.
      return error instanceof Error && error.name === "NotAllowedError" ? { kind: "denied" } : { kind: "empty" };
    }
  }

  async writeText(text: string): Promise<void> {
    await navigator.clipboard.writeText(text);
  }
}

export function createWebPlatform(gpu: GPUContext, models: ModelStore): Platform {
  const capabilities: PlatformCapabilities = {
    persistentFileHandles: Boolean(browserWindow.showOpenFilePicker && browserWindow.showSaveFilePicker),
    opfs: OpfsStorageAdapter.isSupported(),
    localFonts: Boolean(browserWindow.queryLocalFonts),
    webCodecs: "VideoDecoder" in browserWindow && "VideoEncoder" in browserWindow,
    nativeFfmpeg: false,
    nativeThreads: false,
  };
  const ml: MLPort = createOnnxRuntime({ gpu, models });
  return { kind: "web", fs: new WebFileSystem(), codecs: new WebCodecs(), fonts: new WebFonts(), clipboard: new WebClipboard(), ml, gpu, capabilities };
}
