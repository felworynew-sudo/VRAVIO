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
    if (options.target && isBrowserFileHandle(options.target)) {
      const writable = await options.target.createWritable();
      await writable.write(blob);
      await writable.close();
      return { name: options.name, method: "native-picker", target: options.target };
    }
    if (browserWindow.showSaveFilePicker) {
      let handle: BrowserFileHandle;
      try { handle = await browserWindow.showSaveFilePicker({ suggestedName: options.name, types: [{ description: options.mime, accept: { [options.mime]: [`.${options.name.split(".").pop() ?? "bin"}`] } }] }); }
      catch (error) { if (error instanceof DOMException && error.name === "AbortError") return { name: options.name, method: "native-picker", cancelled: true }; throw error; }
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return { name: options.name, method: "native-picker", target: handle };
    }
    const url = URL.createObjectURL(blob), anchor = document.createElement("a");
    anchor.href = url; anchor.download = options.name; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    return { name: options.name, method: "download" };
  }
}

function isBrowserFileHandle(value: unknown): value is BrowserFileHandle {
  // `typeof value === "object"` is true for `null` too, so the previous
  // `Boolean(value)` check — a plain truthiness test, not a type guard TS's
  // control-flow analysis narrows on — left `value` still possibly `null`
  // at the `in` check below. An explicit `!== null` is what actually narrows it.
  return value !== null && typeof value === "object" && "createWritable" in value && typeof (value as BrowserFileHandle).createWritable === "function";
}

const isTauriDesktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

class DesktopFileSystem implements FileSystemPort {
  async openFiles(options: OpenFileOptions = {}): Promise<readonly PlatformFile[]> { return new WebFileSystem().openFiles(options); }

  async saveFile(options: SaveFileOptions): Promise<SaveFileResult> {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeFile } = await import("@tauri-apps/plugin-fs");
    let path = typeof options.target === "string" ? options.target : null;
    if (!path) {
      const extension = options.name.split(".").pop() ?? "bin";
      path = await save({ defaultPath: options.name, filters: [{ name: options.mime === "application/vnd.vravio+json" ? "VRAVIO project" : extension.toUpperCase(), extensions: [extension] }] });
    }
    if (!path) return { name: options.name, method: "desktop", cancelled: true };
    const bytes = options.data instanceof Blob ? new Uint8Array(await options.data.arrayBuffer()) : options.data;
    await writeFile(path, bytes);
    return { name: path.split(/[\\/]/).pop() || options.name, method: "desktop", target: path };
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

/**
 * Reads Settings' "Worker threads" straight from storage rather than importing `store.ts`'s
 * preferences — `store.ts` already imports `kernel.ts`, which imports this module, so importing
 * the store back here would be circular. `createWebPlatform` runs once at module load, before
 * any store subscriber could react to a later change, so the value has to be read this way or
 * not at all: this was the actual bug (the setting was read by nothing, anywhere, ever).
 */
export function storedWorkerCount(): number | undefined {
  if (typeof localStorage === "undefined") return undefined;
  try {
    const value = (JSON.parse(localStorage.getItem("vravio.preferences") ?? "{}") as { workerCount?: unknown }).workerCount;
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
  } catch {
    return undefined;
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
  const workerCount = storedWorkerCount();
  const ml: MLPort = createOnnxRuntime({ gpu, models, ...(workerCount !== undefined ? { workerCount } : {}) });
  return { kind: isTauriDesktop ? "desktop" : "web", fs: isTauriDesktop ? new DesktopFileSystem() : new WebFileSystem(), codecs: new WebCodecs(), fonts: new WebFonts(), clipboard: new WebClipboard(), ml, gpu, capabilities };
}
