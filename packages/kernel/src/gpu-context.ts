import type { Disposable } from "./types";

export type RenderBackend = "webgpu" | "webgl2" | "wasm-simd" | "wasm" | "cpu";

export interface RenderBackendProbe {
  readonly backend: RenderBackend;
  available(): boolean | Promise<boolean>;
}

export interface BackendChangeEvent {
  readonly previous: RenderBackend | null;
  readonly current: RenderBackend;
  readonly reason: string;
}

const backendOrder: readonly RenderBackend[] = ["webgpu", "webgl2", "wasm-simd", "wasm", "cpu"];

export class GPUContext {
  readonly #probes: readonly RenderBackendProbe[];
  readonly #listeners = new Set<(event: BackendChangeEvent) => void>();
  #available: RenderBackend[] = [];
  #active: RenderBackend | null = null;
  #initializing: Promise<RenderBackend> | null = null;

  constructor(probes: readonly RenderBackendProbe[] = browserRenderBackendProbes()) { this.#probes = probes; }

  get active(): RenderBackend | null { return this.#active; }
  get available(): readonly RenderBackend[] { return this.#available; }

  initialize(): Promise<RenderBackend> {
    if (this.#active) return Promise.resolve(this.#active);
    if (this.#initializing) return this.#initializing;
    this.#initializing = this.#detect();
    return this.#initializing;
  }

  degrade(reason: string): RenderBackend {
    if (!this.#active) throw new Error("GPUContext must be initialized before degrading");
    const currentIndex = this.#available.indexOf(this.#active), next = this.#available[currentIndex + 1];
    if (!next) return this.#active;
    const previous = this.#active;
    this.#active = next;
    this.#emit({ previous, current: next, reason });
    return next;
  }

  select(backend: RenderBackend, reason = "manual"): boolean {
    if (!this.#available.includes(backend)) return false;
    if (backend === this.#active) return true;
    const previous = this.#active;
    this.#active = backend;
    this.#emit({ previous, current: backend, reason });
    return true;
  }

  subscribe(listener: (event: BackendChangeEvent) => void): Disposable {
    this.#listeners.add(listener);
    return { dispose: () => this.#listeners.delete(listener) };
  }

  async #detect(): Promise<RenderBackend> {
    const available = new Set<RenderBackend>();
    for (const probe of this.#probes) {
      try { if (await probe.available()) available.add(probe.backend); } catch { /* An unavailable backend must not prevent fallback. */ }
    }
    available.add("cpu");
    this.#available = backendOrder.filter((backend) => available.has(backend));
    this.#active = this.#available[0] ?? "cpu";
    this.#emit({ previous: null, current: this.#active, reason: "initial-detection" });
    return this.#active;
  }

  #emit(event: BackendChangeEvent): void { for (const listener of this.#listeners) listener(event); }
}

export function browserRenderBackendProbes(): readonly RenderBackendProbe[] {
  const scope = globalThis as typeof globalThis & {
    navigator?: Navigator & { gpu?: { requestAdapter(): Promise<unknown> } };
    document?: Document;
  };
  const simdProbe = new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,10,1,8,0,65,0,253,15,11]);
  return [
    { backend: "webgpu", available: async () => Boolean(scope.navigator?.gpu && await scope.navigator.gpu.requestAdapter()) },
    { backend: "webgl2", available: () => Boolean(scope.document?.createElement("canvas").getContext("webgl2")) },
    { backend: "wasm-simd", available: () => typeof WebAssembly !== "undefined" && WebAssembly.validate(simdProbe) },
    { backend: "wasm", available: () => typeof WebAssembly !== "undefined" },
    { backend: "cpu", available: () => true },
  ];
}

