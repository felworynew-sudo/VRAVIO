import type { GPUContext, RenderBackend } from "./gpu-context";
import type { MLBackend } from "./model-store";

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

export interface PlatformFont { readonly family: string; readonly fullName: string; readonly style: string }
export interface FontPort { listLocalFonts(): Promise<readonly PlatformFont[]> }

export interface MLPort {
  readonly backends: readonly (RenderBackend | "native")[];
  readonly supportsLocalModels: boolean;
  /** The accelerator inference will actually run on, once probed. */
  backend(): MLBackend;
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
  readonly ml: MLPort;
  readonly gpu: GPUContext;
  readonly capabilities: PlatformCapabilities;
}

