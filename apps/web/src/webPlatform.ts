import type { CodecPort, FileSystemPort, FontPort, GPUContext, MLPort, OpenFileOptions, Platform, PlatformCapabilities, PlatformFile, SaveFileOptions, SaveFileResult } from "@vravio/kernel";
import { OpfsStorageAdapter } from "@vravio/kernel";

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

export function createWebPlatform(gpu: GPUContext): Platform {
  const capabilities: PlatformCapabilities = {
    persistentFileHandles: Boolean(browserWindow.showOpenFilePicker && browserWindow.showSaveFilePicker),
    opfs: OpfsStorageAdapter.isSupported(),
    localFonts: Boolean(browserWindow.queryLocalFonts),
    webCodecs: "VideoDecoder" in browserWindow && "VideoEncoder" in browserWindow,
    nativeFfmpeg: false,
    nativeThreads: false,
  };
  const ml: MLPort = {
    backends: gpu.available.length ? gpu.available : ["wasm"],
    supportsLocalModels: true,
    // Inference follows the render ladder, with WebNN preferred when the browser exposes it.
    backend: () => ("ml" in navigator ? "webnn" : gpu.active ?? gpu.available[0] ?? "wasm"),
  };
  return { kind: "web", fs: new WebFileSystem(), codecs: new WebCodecs(), fonts: new WebFonts(), ml, gpu, capabilities };
}
