import { isDesktop } from "../desktop-window";

export type BridgeEntry = {
  id: string;
  value: string;
  type: "file" | "folder";
  date?: Date;
  size?: number;
  /** A folder whose contents are read only when it is opened — see `TauriFileSystemProvider.list`. */
  lazy?: boolean;
};

export interface BridgeFileSystemProvider {
  readonly kind: "desktop" | "browser";
  list(path?: string): Promise<BridgeEntry[]>;
  read(path: string): Promise<File | null>;
  preview(path: string): string | null;
  extraInfo(path: string): { Size: string; Count: string };
  preparePreviews(entries: readonly BridgeEntry[]): Promise<void>;
  dispose(): void;
}

const imageExtensions = new Set(["avif", "bmp", "gif", "heic", "jpeg", "jpg", "png", "svg", "tif", "tiff", "webp"]);
const mimeByExtension: Record<string, string> = {
  avif: "image/avif", gif: "image/gif", jpeg: "image/jpeg", jpg: "image/jpeg", png: "image/png", svg: "image/svg+xml", webp: "image/webp",
  mp3: "audio/mpeg", wav: "audio/wav", flac: "audio/flac", ogg: "audio/ogg", m4a: "audio/mp4",
  mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska",
};

function extensionOf(name: string): string {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

function nameFromPath(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
}

function mimeFor(name: string): string {
  return mimeByExtension[extensionOf(name)] ?? "application/octet-stream";
}

function isImage(entry: BridgeEntry): boolean {
  return entry.type === "file" && imageExtensions.has(extensionOf(entry.value));
}

abstract class BaseProvider implements BridgeFileSystemProvider {
  abstract readonly kind: "desktop" | "browser";
  protected readonly previews = new Map<string, string>();
  protected readonly info = new Map<string, { Size: string; Count: string }>();
  abstract list(path?: string): Promise<BridgeEntry[]>;
  abstract read(path: string): Promise<File | null>;

  preview(path: string): string | null { return this.previews.get(path) ?? null; }
  extraInfo(path: string): { Size: string; Count: string } { return this.info.get(path) ?? { Size: "—", Count: "—" }; }

  async preparePreviews(entries: readonly BridgeEntry[]): Promise<void> {
    // Never eagerly read a whole photo archive. The file manager is updated as the user
    // navigates, so this bounded batch makes the first screen useful while keeping directory
    // navigation responsive on external drives.
    for (const entry of entries.filter(isImage).slice(0, 48)) {
      if (this.previews.has(entry.id)) continue;
      const file = await this.read(entry.id);
      if (file) this.previews.set(entry.id, URL.createObjectURL(file));
    }
  }

  dispose(): void {
    for (const url of this.previews.values()) URL.revokeObjectURL(url);
    this.previews.clear();
  }
}

class BrowserFileSystemProvider extends BaseProvider {
  readonly kind = "browser" as const;
  private readonly files = new Map<string, File>();
  private entries: BridgeEntry[] = [];

  setFiles(files: FileList | File[]): void {
    this.files.clear();
    const folders = new Set<string>();
    const result: BridgeEntry[] = [];
    for (const file of Array.from(files)) {
      const relative = ((file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name).replaceAll("\\", "/");
      const id = `/${relative.replace(/^\/+/, "")}`;
      const parts = id.split("/").filter(Boolean);
      for (let index = 1; index < parts.length; index += 1) folders.add(`/${parts.slice(0, index).join("/")}`);
      this.files.set(id, file);
      this.info.set(id, { Size: formatSize(file.size), Count: extensionOf(file.name).toUpperCase() || "FILE" });
      result.push({ id, value: file.name, type: "file", date: new Date(file.lastModified), size: file.size });
    }
    // `lazy: true` is what makes the file manager emit `request-data` when a
    // folder is opened, the exact fix already made for `TauriFileSystemProvider`
    // below (see that provider's own comment) — missed here, so opening any
    // folder more than one level deep (a `webkitdirectory` pick always has at
    // least one) showed empty every time, even though `list()` already had
    // the right children waiting. Every entry here already sits in memory
    // (no async fetch needed the way Tauri's own disk read is), but SVAR
    // still gates the request on this flag regardless of how fast the
    // provider actually answers it.
    for (const id of folders) result.push({ id, value: nameFromPath(id), type: "folder", lazy: true });
    this.entries = result;
  }

  async list(path = "/"): Promise<BridgeEntry[]> {
    const prefix = path === "/" ? "/" : `${path.replace(/\/$/, "")}/`;
    return this.entries.filter((entry) => {
      if (!entry.id.startsWith(prefix) || entry.id === path) return false;
      return entry.id.slice(prefix.length).split("/").length === 1;
    }).sort(sortEntries);
  }

  async read(path: string): Promise<File | null> { return this.files.get(path) ?? null; }
}

/**
 * A path as the file manager wants it: rooted at `/`, separated by `/`.
 *
 * SVAR does not carry a parent field — it derives one from the id itself:
 * `parseId` takes `id.lastIndexOf("/")`, calls what is before it the parent and what is after it
 * the name, and its root node is literally `"/"` ("My files"). A native Windows path
 * (`C:\Users\...`) has no `/` in it at all, so the parent came out as the id minus its last
 * character, no node by that name existed, and every entry was dropped on the floor: the desktop
 * build showed an empty "My files" and no error, because nothing had failed — the tree simply had
 * nowhere to put anything. Found by reading the store's own `parseId`, after the packaged app
 * showed a file manager with no files in it.
 */
export function bridgeIdFor(parentId: string, name: string): string {
  return parentId === "/" ? `/${name}` : `${parentId}/${name}`;
}

class TauriFileSystemProvider extends BaseProvider {
  readonly kind = "desktop" as const;
  private homePath: string | null = null;
  /** Bridge id to the real path on disk. The two are never the same string on Windows. */
  private readonly nativePaths = new Map<string, string>([]);

  private async root(): Promise<string> {
    if (this.homePath) return this.homePath;
    const { homeDir } = await import("@tauri-apps/api/path");
    this.homePath = await homeDir();
    this.nativePaths.set("/", this.homePath);
    return this.homePath;
  }

  async list(path?: string): Promise<BridgeEntry[]> {
    const home = await this.root();
    const parentId = path || "/";
    const directory = this.nativePaths.get(parentId) ?? home;
    const [{ readDir, stat }, { join }] = await Promise.all([import("@tauri-apps/plugin-fs"), import("@tauri-apps/api/path")]);
    const entries = await readDir(directory);
    const result = await Promise.all(entries.filter((entry) => !entry.isSymlink).map(async (entry) => {
      const native = await join(directory, entry.name);
      const id = bridgeIdFor(parentId, entry.name);
      this.nativePaths.set(id, native);
      // A folder whose contents are unknown until asked for: `lazy` is what makes the file
      // manager emit `request-data` when it is opened. Without it the folder opens empty and the
      // adapter is never asked to read it, which looks exactly like an empty folder.
      const type = entry.isDirectory ? "folder" : "file";
      const metadata = await stat(native).catch(() => null);
      this.info.set(id, { Size: type === "folder" ? "—" : formatSize(metadata?.size ?? 0), Count: type === "folder" ? "Folder" : (extensionOf(entry.name).toUpperCase() || "FILE") });
      const date = metadata?.mtime ? new Date(metadata.mtime) : null;
      return {
        id, value: entry.name, type,
        ...(type === "folder" ? { lazy: true } : {}),
        ...(date ? { date } : {}),
        ...(metadata?.size !== undefined ? { size: metadata.size } : {}),
      } satisfies BridgeEntry;
    }));
    return result.sort(sortEntries);
  }

  async read(path: string): Promise<File | null> {
    try {
      const [{ readFile }, { basename }] = await Promise.all([import("@tauri-apps/plugin-fs"), import("@tauri-apps/api/path")]);
      const native = this.nativePaths.get(path) ?? path;
      const bytes = await readFile(native);
      return new File([bytes], await basename(native), { type: mimeFor(native) });
    } catch { return null; }
  }
}

function sortEntries(left: BridgeEntry, right: BridgeEntry): number {
  if (left.type !== right.type) return left.type === "folder" ? -1 : 1;
  return left.value.localeCompare(right.value, undefined, { numeric: true, sensitivity: "base" });
}

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB", "TB"];
  const unit = Math.min(units.length - 1, Math.floor(Math.log(size) / Math.log(1024)) - 1);
  return `${(size / 1024 ** (unit + 1)).toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

export function createBridgeFileSystemProvider(): BridgeFileSystemProvider {
  return isDesktop ? new TauriFileSystemProvider() : new BrowserFileSystemProvider();
}

export function browserFiles(provider: BridgeFileSystemProvider): BrowserFileSystemProvider | null {
  return provider instanceof BrowserFileSystemProvider ? provider : null;
}
