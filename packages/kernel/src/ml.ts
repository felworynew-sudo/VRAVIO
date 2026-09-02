import type { MLBackend, ModelSpec } from "./model-store";

/** A tensor as the runtimes exchange them: flat data plus its shape. */
export interface MLTensor {
  readonly data: Float32Array;
  readonly dims: readonly number[];
}

export interface MLRunOptions {
  /**
   * Inference on a large image runs for a long time, and a user who changed
   * their mind should not have to wait for it.
   */
  readonly signal?: AbortSignal;
}

/**
 * A loaded model, ready to run.
 *
 * Deliberately thin: the environments feed it tensors and read tensors back,
 * and nothing above this interface knows whether the work happens on WebGPU, in
 * WebAssembly, or on a native runtime.
 */
export interface MLSession {
  readonly spec: ModelSpec;
  /** What the work is actually running on, which may not be the preferred one. */
  readonly backend: MLBackend;
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  run(inputs: Readonly<Record<string, MLTensor>>, options?: MLRunOptions): Promise<Record<string, MLTensor>>;
  dispose(): Promise<void>;
}

export class ModelUnavailableError extends Error {
  constructor(readonly modelId: string, message: string) {
    super(message);
    this.name = "ModelUnavailableError";
  }
}

/** Raised when a run is abandoned; distinguishable from a genuine failure. */
export class InferenceCancelledError extends Error {
  constructor(message = "Inference cancelled") {
    super(message);
    this.name = "InferenceCancelledError";
  }
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new InferenceCancelledError();
}
