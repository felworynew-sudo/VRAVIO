import type { GPUContext, RenderBackend } from "./gpu-context";
import type { LoadModelOptions, MLBackend, ModelSpec } from "./model-store";
import type { MLSession } from "./ml";

export type PlatformKind = "web" | "desktop";

export interface PlatformFile {
  readonly name: string;
  readonly mime: string;
  readonly size: number;
  readonly lastModified: number;
  readonly data: Uint8Array;
}

export interface OpenFileOptions { readonly accept?: Record<string, readonly string[]>; readonly multiple?: boolean }
export interface SaveFileOptions { readonly name: string; readonly mime: string; readonly data: Blob | Uint8Array }
export interface SaveFileResult { readonly name: string; readonly method: "native-picker" | "download" | "desktop" }

export interface FileSystemPort {
  openFiles(options?: OpenFileOptions): Promise<readonly PlatformFile[]>;
  saveFile(options: SaveFileOptions): Promise<SaveFileResult>;
}

export interface CodecPort {
  supports(mime: string): Promise<boolean>;
  readonly preferredVideoExport: readonly string[];
  readonly preferredAudioExport: readonly string[];
}

/**
 * The system clipboard.
 *
 * A port rather than direct `navigator.clipboard` calls, for the reason every
 * other port here exists: the desktop build reaches the clipboard through the
 * operating system, not through a browser API that needs a secure context and
 * a user gesture. What differs between them is real, so it is behind an
 * interface rather than behind a branch at every call site.
 *
 * `canReadImages` is separate from writing because the two are not equally
 * available: every browser that matters can *write* an image to the clipboard,
 * and reading one back is gated behind a permission prompt in some and simply
 * absent in others. A caller that can only paste on some machines needs to
 * know which it is on before offering to.
 */
/**
 * What was on the clipboard, or why it could not be read.
 *
 * Three outcomes rather than "a blob or null", because the two failures need
 * opposite things from the user and conflating them wastes their time: an
 * empty clipboard means "copy something first", a refused permission means
 * "let the page read the clipboard". The first version of this returned null
 * for both and reported "the clipboard holds no image" — which was simply
 * untrue when the clipboard held one and the browser had said no.
 */
export type ClipboardImage =
  | { readonly kind: "image"; readonly image: Blob }
  | { readonly kind: "empty" }
  | { readonly kind: "denied" };

export interface ClipboardPort {
  /** False where reading images is unsupported — Firefox, at the time of
   * writing — so a Paste command can disable itself rather than fail. */
  readonly canReadImages: boolean;
  writeImage(image: Blob): Promise<void>;
  readImage(): Promise<ClipboardImage>;
  writeText(text: string): Promise<void>;
}

export interface PlatformFont { readonly family: string; readonly fullName: string; readonly style: string }
export interface FontPort { listLocalFonts(): Promise<readonly PlatformFont[]> }

export interface MLPort {
  readonly backends: readonly (RenderBackend | "native")[];
  readonly supportsLocalModels: boolean;
  /** The accelerator inference will actually run on, once probed. */
  backend(): MLBackend;
  /**
   * Fetches the weights if they are not cached and prepares a session.
   *
   * Consent and download progress belong to `LoadModelOptions`, because a user
   * asked to wait for tens of megabytes deserves to have been asked first and
   * to be able to change their mind.
   */
  load(spec: ModelSpec, options?: LoadModelOptions): Promise<MLSession>;
}

export interface PlatformCapabilities {
  readonly persistentFileHandles: boolean;
  readonly opfs: boolean;
  readonly localFonts: boolean;
  readonly webCodecs: boolean;
  readonly nativeFfmpeg: boolean;
  readonly nativeThreads: boolean;
}

export interface Platform {
  readonly kind: PlatformKind;
  readonly fs: FileSystemPort;
  readonly codecs: CodecPort;
  readonly fonts: FontPort;
  readonly clipboard: ClipboardPort;
  readonly ml: MLPort;
  readonly gpu: GPUContext;
  readonly capabilities: PlatformCapabilities;
}

