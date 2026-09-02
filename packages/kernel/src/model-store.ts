import type { RenderBackend } from "./gpu-context";

export type MLBackend = RenderBackend | "webnn" | "native";

export interface ModelSpec {
  readonly id: string;
  readonly url: string;
  /** Download size, used for the consent prompt and the progress bar. */
  readonly sizeBytes: number;
  readonly inputShape: readonly number[];
  /** Large inputs are processed in overlapping tiles of this size. */
  readonly tile?: { readonly size: number; readonly overlap: number };
  /**
   * Weight licence. Model code and model weights are licensed separately and the weights are
   * frequently the restrictive half, so this is recorded per model rather than assumed.
   */
  readonly licence: string;
  /** False when the licence forbids commercial use; the UI has to say so before downloading. */
  readonly commercialUse: boolean;
}

export interface ModelDownloadProgress {
  readonly modelId: string;
  readonly receivedBytes: number;
  readonly totalBytes: number;
  /** 0..1, or null while the server has not told us the length. */
  readonly ratio: number | null;
}

export interface LoadModelOptions {
  readonly signal?: AbortSignal;
  onProgress?(progress: ModelDownloadProgress): void;
  /**
   * Called before anything is fetched when the model is not cached. Returning false aborts.
   * Downloading tens of megabytes without asking is the fastest way to annoy someone.
   */
  onConsent?(spec: ModelSpec): boolean | Promise<boolean>;
}

export class ModelConsentDeniedError extends Error {
  constructor(readonly modelId: string) {
    super(`Download of model ${modelId} was declined`);
    this.name = "ModelConsentDeniedError";
  }
}

function abortError(): Error {
  const error = new Error("Model download was cancelled");
  error.name = "AbortError";
  return error;
}

/** The subset of the Cache Storage API this needs, so tests can supply their own. */
export interface ModelCacheStorage {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
  delete(key: string): Promise<boolean>;
  keys(): Promise<readonly string[]>;
}

export interface ModelStoreOptions {
  readonly cache?: ModelCacheStorage | null;
  readonly fetch?: typeof fetch;
  /** Models at or above this size need explicit consent. */
  readonly consentThresholdBytes?: number;
}

/**
 * Downloads and caches model weights.
 *
 * Weights are large and immutable, so they are stored in Cache Storage and fetched once. Every
 * download is cancellable and reports progress, because inference-sized files take long enough
 * that a frozen dialog with no way out is not acceptable.
 */
export class ModelStore {
  readonly #cache: ModelCacheStorage | null;
  readonly #fetch: typeof fetch;
  readonly #consentThreshold: number;
  readonly #inFlight = new Map<string, Promise<ArrayBuffer>>();

  constructor(options: ModelStoreOptions = {}) {
    this.#cache = options.cache ?? null;
    this.#fetch = options.fetch ?? ((...args) => globalThis.fetch(...args));
    this.#consentThreshold = options.consentThresholdBytes ?? 8 * 1024 * 1024;
  }

  async isCached(spec: ModelSpec): Promise<boolean> {
    return Boolean(await this.#cache?.match(spec.url));
  }

  /** Frees a cached model; returns false when nothing was stored. */
  async evict(spec: ModelSpec): Promise<boolean> {
    return (await this.#cache?.delete(spec.url)) ?? false;
  }

  async cachedModelUrls(): Promise<readonly string[]> {
    return (await this.#cache?.keys()) ?? [];
  }

  async load(spec: ModelSpec, options: LoadModelOptions = {}): Promise<ArrayBuffer> {
    // Concurrent callers for the same model share one download rather than racing.
    const existing = this.#inFlight.get(spec.id);
    if (existing) return existing;
    const download = this.#load(spec, options).finally(() => this.#inFlight.delete(spec.id));
    this.#inFlight.set(spec.id, download);
    return download;
  }

  async #load(spec: ModelSpec, options: LoadModelOptions): Promise<ArrayBuffer> {
    if (options.signal?.aborted) throw abortError();

    const cached = await this.#cache?.match(spec.url);
    if (cached) {
      options.onProgress?.({ modelId: spec.id, receivedBytes: spec.sizeBytes, totalBytes: spec.sizeBytes, ratio: 1 });
      return cached.arrayBuffer();
    }

    if (spec.sizeBytes >= this.#consentThreshold && options.onConsent) {
      if (!await options.onConsent(spec)) throw new ModelConsentDeniedError(spec.id);
    }

    const requestInit = options.signal ? { signal: options.signal } : {};
    const response = await this.#fetch(spec.url, requestInit);
    if (!response.ok) throw new Error(`Model ${spec.id} failed to download: ${response.status}`);

    const buffer = await this.#readWithProgress(spec, response, options);
    // Cache Storage needs its own body; the buffer is already consumed here.
    await this.#cache?.put(spec.url, new Response(buffer.slice(0)));
    return buffer;
  }

  async #readWithProgress(spec: ModelSpec, response: Response, options: LoadModelOptions): Promise<ArrayBuffer> {
    const declared = Number(response.headers.get("content-length") ?? "");
    const totalBytes = Number.isFinite(declared) && declared > 0 ? declared : spec.sizeBytes;
    const reader = response.body?.getReader();
    if (!reader) {
      const buffer = await response.arrayBuffer();
      options.onProgress?.({ modelId: spec.id, receivedBytes: buffer.byteLength, totalBytes, ratio: 1 });
      return buffer;
    }

    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      if (options.signal?.aborted) { await reader.cancel(); throw abortError(); }
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      received += value.byteLength;
      options.onProgress?.({
        modelId: spec.id, receivedBytes: received, totalBytes,
        ratio: totalBytes > 0 ? Math.min(1, received / totalBytes) : null,
      });
    }

    const buffer = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
    return buffer.buffer;
  }
}

/** Opens the browser cache used for weights, or null when Cache Storage is unavailable. */
export async function openModelCache(name = "vravio-models"): Promise<ModelCacheStorage | null> {
  if (typeof caches === "undefined") return null;
  const cache = await caches.open(name);
  return {
    match: (key) => cache.match(key),
    put: (key, response) => cache.put(key, response),
    delete: (key) => cache.delete(key),
    keys: async () => (await cache.keys()).map((request) => request.url),
  };
}
