export interface BinaryStorageAdapter {
  get(key: string): Promise<Uint8Array | null>;
  set(key: string, value: Uint8Array): Promise<void>;
  remove(key: string): Promise<boolean>;
  list(prefix?: string): Promise<readonly string[]>;
  clear(): Promise<void>;
}

export class MemoryStorageAdapter implements BinaryStorageAdapter {
  readonly #entries = new Map<string, Uint8Array>();

  async get(key: string): Promise<Uint8Array | null> { return this.#entries.get(key)?.slice() ?? null; }
  async set(key: string, value: Uint8Array): Promise<void> { this.#entries.set(key, value.slice()); }
  async remove(key: string): Promise<boolean> { return this.#entries.delete(key); }
  async list(prefix = ""): Promise<readonly string[]> { return [...this.#entries.keys()].filter((key) => key.startsWith(prefix)).sort(); }
  async clear(): Promise<void> { this.#entries.clear(); }
}

/** Browser storage backed by the Origin Private File System. */
export class OpfsStorageAdapter implements BinaryStorageAdapter {
  readonly #directoryName: string;

  constructor(directoryName = "vravio") { this.#directoryName = directoryName; }

  static isSupported(): boolean {
    return typeof navigator !== "undefined" && "storage" in navigator && typeof navigator.storage.getDirectory === "function";
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      const { directory, name } = await this.#resolveParent(key, false);
      const handle = await directory.getFileHandle(name);
      return new Uint8Array(await (await handle.getFile()).arrayBuffer());
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotFoundError") return null;
      throw error;
    }
  }

  async set(key: string, value: Uint8Array): Promise<void> {
    const { directory, name } = await this.#resolveParent(key, true);
    const handle = await directory.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(value.slice().buffer);
    await writable.close();
  }

  async remove(key: string): Promise<boolean> {
    try {
      const { directory, name } = await this.#resolveParent(key, false);
      await directory.removeEntry(name);
      return true;
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotFoundError") return false;
      throw error;
    }
  }

  async list(prefix = ""): Promise<readonly string[]> {
    const root = await this.#root();
    const keys: string[] = [];
    const visit = async (directory: FileSystemDirectoryHandle, path: string): Promise<void> => {
      for await (const [name, handle] of directory.entries()) {
        const key = path ? `${path}/${name}` : name;
        if (handle.kind === "directory") await visit(handle, key);
        else if (key.startsWith(prefix)) keys.push(key);
      }
    };
    await visit(root, "");
    return keys.sort();
  }

  async clear(): Promise<void> {
    const root = await this.#root();
    for await (const [name] of root.entries()) await root.removeEntry(name, { recursive: true });
  }

  async #root(): Promise<FileSystemDirectoryHandle> {
    if (!OpfsStorageAdapter.isSupported()) throw new Error("OPFS is not supported in this runtime");
    const opfsRoot = await navigator.storage.getDirectory();
    return opfsRoot.getDirectoryHandle(this.#directoryName, { create: true });
  }

  async #resolveParent(key: string, create: boolean): Promise<{ directory: FileSystemDirectoryHandle; name: string }> {
    const parts = key.split("/").filter((part) => part && part !== "." && part !== "..");
    const name = parts.pop();
    if (!name) throw new Error(`Invalid storage key: ${key}`);
    let directory = await this.#root();
    for (const part of parts) directory = await directory.getDirectoryHandle(part, { create });
    return { directory, name };
  }
}

