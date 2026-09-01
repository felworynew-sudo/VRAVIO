export interface AssetRecord {
  readonly id: string;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly createdAt: number;
  readonly data: Uint8Array;
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class AssetStore {
  readonly #assets = new Map<string, AssetRecord>();

  async put(data: Uint8Array, mimeType = "application/octet-stream"): Promise<AssetRecord> {
    const ownedBytes = Uint8Array.from(data);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", ownedBytes.buffer));
    const id = `sha256:${toHex(digest)}`;
    const existing = this.#assets.get(id);
    if (existing) return existing;
    const record: AssetRecord = { id, mimeType, byteLength: ownedBytes.byteLength, createdAt: Date.now(), data: ownedBytes };
    this.#assets.set(id, record);
    return record;
  }

  get(id: string): AssetRecord | undefined { return this.#assets.get(id); }
  has(id: string): boolean { return this.#assets.has(id); }
  delete(id: string): boolean { return this.#assets.delete(id); }
  get size(): number { return this.#assets.size; }
}
