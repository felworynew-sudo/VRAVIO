/** The synchronous write handle Safari offers in place of `createWritable`. */
interface SyncAccessHandle {
  truncate(size: number): void;
  write(buffer: Uint8Array, options?: { at?: number }): number;
  flush(): void;
  close(): void;
}

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
    // `"storage" in navigator` is not enough: the key exists with an undefined
    // value in some engines and WebViews, and reading through it there threw
    // before the application had drawn anything.
    return typeof navigator !== "undefined" && typeof navigator.storage?.getDirectory === "function";
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
    if (typeof handle.createWritable === "function") {
      const writable = await handle.createWritable();
      await writable.write(value.slice().buffer);
      await writable.close();
      return;
    }
    // Safari shipped the origin private file system before it shipped
    // `createWritable`, offering only the synchronous access handle. Without
    // this branch every write throws there, and a browser that can read its
    // own stored documents but not save them is worse than one that stores
    // nothing.
    const access = await (handle as { createSyncAccessHandle?: () => Promise<SyncAccessHandle> }).createSyncAccessHandle?.();
    if (!access) throw new Error("This browser's origin private file system is read-only");
    try {
      access.truncate(0);
      access.write(value.slice(), { at: 0 });
      access.flush();
    } finally {
      access.close();
    }
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


/**
 * Binary storage that resolves its backing store on first use.
 *
 * Which store works cannot be decided from feature flags. The origin private
 * file system is reported as present by browsers that cannot write to it, and
 * private windows and blocked site data fail later still, so the choice is made
 * by actually writing a byte and reading it back. Everything after that point
 * simply has somewhere to put bytes.
 *
 * The probe runs once and every method waits on it, which keeps the kernel's
 * construction synchronous.
 */
export class ResilientStorageAdapter implements BinaryStorageAdapter {
  readonly #name: string;
  #resolved: Promise<BinaryStorageAdapter> | null = null;
  #chosen: string | null = null;

  constructor(name: string) { this.#name = name; }

  /** Which store the probe settled on: "opfs", "indexeddb" or "memory". */
  get backing(): string | null { return this.#chosen; }

  async get(key: string): Promise<Uint8Array | null> { return (await this.#adapter()).get(key); }
  async set(key: string, value: Uint8Array): Promise<void> { return (await this.#adapter()).set(key, value); }
  async remove(key: string): Promise<boolean> { return (await this.#adapter()).remove(key); }
  async list(prefix?: string): Promise<readonly string[]> { return (await this.#adapter()).list(prefix); }
  async clear(): Promise<void> { return (await this.#adapter()).clear(); }

  #adapter(): Promise<BinaryStorageAdapter> {
    this.#resolved ??= this.#choose();
    return this.#resolved;
  }

  async #choose(): Promise<BinaryStorageAdapter> {
    const candidates: Array<[string, () => BinaryStorageAdapter]> = [];
    if (OpfsStorageAdapter.isSupported()) candidates.push(["opfs", () => new OpfsStorageAdapter(this.#name)]);
    if (IndexedDbStorageAdapter.isSupported()) candidates.push(["indexeddb", () => new IndexedDbStorageAdapter(this.#name)]);

    for (const [label, build] of candidates) {
      const adapter = build();
      try {
        const probeKey = "capability-probe.bin", probe = new Uint8Array([1, 2, 3]);
        await adapter.set(probeKey, probe);
        const read = await adapter.get(probeKey);
        await adapter.remove(probeKey);
        if (read && read.length === probe.length && read[0] === 1 && read[2] === 3) {
          this.#chosen = label;
          return adapter;
        }
      } catch {
        // Try the next store rather than leaving the application without one.
      }
    }
    this.#chosen = "memory";
    return new MemoryStorageAdapter();
  }
}

/** Browser storage backed by IndexedDB, for engines whose OPFS cannot be written. */
export class IndexedDbStorageAdapter implements BinaryStorageAdapter {
  readonly #databaseName: string;
  #database: Promise<IDBDatabase> | null = null;

  constructor(databaseName = "vravio") { this.#databaseName = databaseName; }

  static isSupported(): boolean { return typeof indexedDB !== "undefined"; }

  async get(key: string): Promise<Uint8Array | null> {
    const value = await this.#request<ArrayBuffer | undefined>("readonly", (store) => store.get(key));
    return value ? new Uint8Array(value) : null;
  }

  async set(key: string, value: Uint8Array): Promise<void> {
    // Copied out of its buffer: the caller may own a view into a larger one.
    const bytes = value.slice();
    await this.#request("readwrite", (store) => store.put(bytes.buffer, key));
  }

  async remove(key: string): Promise<boolean> {
    if (!(await this.get(key))) return false;
    await this.#request("readwrite", (store) => store.delete(key));
    return true;
  }

  async list(prefix = ""): Promise<readonly string[]> {
    const keys = await this.#request<IDBValidKey[]>("readonly", (store) => store.getAllKeys());
    return keys.map(String).filter((key) => key.startsWith(prefix)).sort();
  }

  async clear(): Promise<void> { await this.#request("readwrite", (store) => store.clear()); }

  #open(): Promise<IDBDatabase> {
    this.#database ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(this.#databaseName, 1);
      request.onupgradeneeded = () => { request.result.createObjectStore("files"); };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    });
    return this.#database;
  }

  async #request<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<T> {
    const database = await this.#open();
    return new Promise<T>((resolve, reject) => {
      const transaction = database.transaction("files", mode);
      const request = run(transaction.objectStore("files"));
      request.onsuccess = () => resolve(request.result as T);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
      transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    });
  }
}
