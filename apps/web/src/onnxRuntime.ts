import type { GPUContext, LoadModelOptions, MLBackend, MLPort, MLRunOptions, MLSession, MLTensor, ModelSpec, ModelStore } from "@vravio/kernel";
import { InferenceCancelledError, ModelUnavailableError, throwIfAborted } from "@vravio/kernel";

/** The slice of onnxruntime-web this file uses, so the import stays typed without pulling it in eagerly. */
interface OrtTensorConstructor {
  new (type: "float32", data: Float32Array, dims: readonly number[]): OrtTensor;
}
interface OrtTensor { readonly data: Float32Array; readonly dims: readonly number[] }
interface OrtSession {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
  release(): Promise<void>;
}
interface OrtModule {
  Tensor: OrtTensorConstructor;
  InferenceSession: { create(model: ArrayBuffer, options: { executionProviders: string[] }): Promise<OrtSession> };
  env: { wasm: { numThreads?: number } };
}

/**
 * Loads the runtime the first time a model is asked for.
 *
 * onnxruntime-web is several megabytes of JavaScript and WebAssembly. Most
 * sessions never touch a model, and paying for it at startup would slow the
 * first paint for everyone to benefit the few who do.
 */
let runtime: Promise<OrtModule> | null = null;
const loadRuntime = (preferWebGpu: boolean): Promise<OrtModule> => {
  runtime ??= (preferWebGpu
    ? import("onnxruntime-web/webgpu")
    : import("onnxruntime-web")) as unknown as Promise<OrtModule>;
  return runtime;
};

class OnnxSession implements MLSession {
  readonly #session: OrtSession;
  readonly #tensor: OrtTensorConstructor;

  constructor(readonly spec: ModelSpec, readonly backend: MLBackend, session: OrtSession, tensor: OrtTensorConstructor) {
    this.#session = session;
    this.#tensor = tensor;
  }

  get inputNames(): readonly string[] { return this.#session.inputNames; }
  get outputNames(): readonly string[] { return this.#session.outputNames; }

  async run(inputs: Readonly<Record<string, MLTensor>>, options: MLRunOptions = {}): Promise<Record<string, MLTensor>> {
    throwIfAborted(options.signal);
    const feeds: Record<string, OrtTensor> = {};
    for (const [name, tensor] of Object.entries(inputs)) feeds[name] = new this.#tensor("float32", tensor.data, tensor.dims);

    const outputs = await this.#session.run(feeds);
    // The runtime has no cancellation of its own, so a run already in flight
    // finishes; what abort buys is that its result is discarded and the caller
    // is not left waiting on the tiles that would have followed.
    throwIfAborted(options.signal);

    const result: Record<string, MLTensor> = {};
    for (const [name, tensor] of Object.entries(outputs)) result[name] = { data: tensor.data, dims: [...tensor.dims] };
    return result;
  }

  async dispose(): Promise<void> { await this.#session.release(); }
}

export interface OnnxRuntimeOptions {
  readonly gpu: GPUContext;
  readonly models: ModelStore;
  /** Threads for the WebAssembly backend; ignored on WebGPU. */
  readonly workerCount?: number;
}

/**
 * MLPort backed by onnxruntime-web.
 *
 * The choice of accelerator is made once and reported honestly: a session that
 * asked for WebGPU and got WebAssembly says so, because a caller deciding
 * whether an operation is worth offering needs to know it will be twenty times
 * slower rather than discovering it from a stalled progress bar.
 */
export function createOnnxRuntime(options: OnnxRuntimeOptions): MLPort {
  const { gpu, models } = options;
  const preferred = (): MLBackend => {
    if (gpu.active === "webgpu" || gpu.available.includes("webgpu")) return "webgpu";
    return "wasm";
  };

  return {
    get backends() { return gpu.available; },
    supportsLocalModels: true,
    backend: preferred,

    async load(spec: ModelSpec, loadOptions: LoadModelOptions = {}): Promise<MLSession> {
      const weights = await models.load(spec, loadOptions);
      throwIfAborted(loadOptions.signal);

      const wanted = preferred();
      const module = await loadRuntime(wanted === "webgpu");
      if (options.workerCount && module.env?.wasm) module.env.wasm.numThreads = options.workerCount;

      // Falling back rather than failing: a machine without WebGPU can still
      // run this, just slowly, and refusing would be worse than being slow.
      const providers = wanted === "webgpu" ? ["webgpu", "wasm"] : ["wasm"];
      for (const provider of providers) {
        try {
          const session = await module.InferenceSession.create(weights, { executionProviders: [provider] });
          return new OnnxSession(spec, provider === "webgpu" ? "webgpu" : "wasm", session, module.Tensor);
        } catch (error) {
          if (provider === providers[providers.length - 1]) {
            throw new ModelUnavailableError(spec.id, `Could not start ${spec.id} on any backend: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
      throw new ModelUnavailableError(spec.id, `No execution provider available for ${spec.id}`);
    },
  };
}

export { InferenceCancelledError };
