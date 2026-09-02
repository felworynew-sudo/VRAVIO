import type { AssetId, AssetKind } from "./asset-store";
import type { EnvironmentKind, ParentTarget, VravioDocument } from "./types";

/** What a parent handed over for editing elsewhere. */
export interface ExtractedAsset {
  readonly assetId: AssetId;
  /** Shown on the child tab: "Layer 3 — sky", "Track 2 — narrator". */
  readonly title: string;
  /**
   * Where the extracted material starts relative to the target, in the units of
   * the parent's timeline. Non-zero when handles were asked for and the parent
   * could give them; always zero for a raster layer, which has no time.
   */
  readonly handleOffset: number;
}

export interface ExtractOptions {
  /** Extra material either side of the target, for editors that need context. */
  readonly handles: number;
  /** Never reuse an existing asset: the caller wants the original untouched. */
  readonly forceNew: boolean;
}

export interface ExportOptions {
  readonly kind: AssetKind;
  /** Intermediate revisions must not accumulate compression damage. */
  readonly lossless: boolean;
}

/**
 * What an editing environment has to provide to take part in the shell.
 *
 * These are the only methods the kernel calls, and environments never call each
 * other: a raster editor knows nothing about audio, and the round-trip between
 * them is the kernel moving an asset from one to the other and back. Adding an
 * environment is implementing this interface and registering it.
 */
export interface Environment<TState = unknown> {
  readonly kind: EnvironmentKind;

  createEmpty(options?: unknown): Promise<VravioDocument<TState>>;

  createFromAsset(assetId: AssetId, options?: { title?: string }): Promise<VravioDocument<TState>>;

  /** Hand a piece of the document over as an asset, for round-trip or copying. */
  extractAsset(document: VravioDocument<TState>, target: ParentTarget, options: ExtractOptions): Promise<ExtractedAsset>;

  /**
   * Render the whole document into the bytes of an asset of the given kind.
   *
   * The specification says Blob; the kernel deals in Uint8Array everywhere else
   * and a Blob would put a browser type in code that has to run under a test
   * runner, so this returns bytes and the caller wraps them if it needs to.
   */
  exportAsAsset(document: VravioDocument<TState>, options: ExportOptions): Promise<Uint8Array>;

  /** An asset this document references has a new revision; take it up. */
  onAssetRevised(document: VravioDocument<TState>, assetId: AssetId, rev: number, note?: string): void;

  /** Point a target at a different asset, for a branching round-trip. */
  relinkTarget(document: VravioDocument<TState>, target: ParentTarget, newAssetId: AssetId): Promise<void>;

  /** One line about what changed, to land in the parent's history. */
  describeChanges(document: VravioDocument<TState>): string;
}

/** The environments this build knows how to open. */
export class EnvironmentRegistry {
  readonly #environments = new Map<EnvironmentKind, Environment<never>>();

  register<TState>(environment: Environment<TState>): void {
    this.#environments.set(environment.kind, environment as Environment<never>);
  }

  has(kind: EnvironmentKind): boolean { return this.#environments.has(kind); }

  get<TState = unknown>(kind: EnvironmentKind): Environment<TState> {
    const environment = this.#environments.get(kind);
    // A missing environment is a wiring mistake, not a user-facing condition:
    // the shell only offers kinds it has registered.
    if (!environment) throw new Error(`No environment registered for "${kind}"`);
    return environment as unknown as Environment<TState>;
  }

  find<TState = unknown>(kind: EnvironmentKind): Environment<TState> | undefined {
    return this.#environments.get(kind) as unknown as Environment<TState> | undefined;
  }

  get kinds(): readonly EnvironmentKind[] { return [...this.#environments.keys()]; }
}
