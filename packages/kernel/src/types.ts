export type EnvironmentKind = "raster" | "vector" | "audio" | "video";
import type { AssetId } from "./asset-store";

export type DocumentOrigin =
  | { readonly kind: "file"; readonly name: string; readonly path?: string; readonly lastModified?: number }
  | { readonly kind: "asset"; readonly assetId: AssetId; readonly rev: number | null; readonly name: string }
  | { readonly kind: "generated"; readonly generator: string };

export type ParentTarget =
  | { readonly kind: "raster-layer"; readonly layerId: string }
  | { readonly kind: "vector-node"; readonly nodeId: string }
  | { readonly kind: "audio-clip" | "video-clip" | "video-clip-audio"; readonly trackId: string; readonly clipId: string }
  | { readonly kind: "video-frame"; readonly trackId: string; readonly clipId: string; readonly time: number }
  | { readonly kind: "time-range"; readonly trackIds: readonly string[]; readonly from: number; readonly to: number };

export interface Provenance {
  readonly parentDocId: string;
  readonly parentTarget: ParentTarget;
  readonly sourceAssetId: AssetId;
  readonly writeBack: "replace-asset" | "new-asset-relink" | "manual";
}

export interface VravioDocument<TState = unknown> {
  readonly id: string;
  name: string;
  readonly kind: EnvironmentKind;
  origin: DocumentOrigin | null;
  state: TState;
  readonly assetRefs: Set<AssetId>;
  provenance: Provenance | null;
  revision: number;
  dirty: boolean;
  readonly createdAt: number;
  updatedAt: number;
}

export interface Disposable {
  dispose(): void;
}

export interface CommandContext {
  readonly activeDocumentId: string | null;
}

export interface Command {
  readonly id: string;
  readonly label: string;
  readonly category: string;
  readonly shortcut?: string;
  isEnabled?(context: CommandContext): boolean;
  execute(context: CommandContext): void | Promise<void>;
}

/**
 * Why the history is releasing a step.
 *
 * The difference matters to anything holding an external resource. When the
 * redo branch is discarded the step's *result* becomes unreachable; when the
 * step is evicted from the front, the state *before* it does. Guessing from
 * the current state is not possible: by the time `free` runs the replacing
 * step is already applied, so a guess would collect the very revision it
 * stands on.
 */
export type FreeReason =
  /** The redo branch was thrown away; this step will never be applied again. */
  | "discarded"
  /** Evicted from the front of the timeline; there is no way back past it. */
  | "evicted";

export interface ReversibleOperation {
  readonly label: string;
  readonly memoryEstimate?: number;
  readonly storageEstimate?: number;
  redo(): void | Promise<void>;
  undo(): void | Promise<void>;
  free?(reason: FreeReason): void | Promise<void>;
  mergeWith?(next: ReversibleOperation): ReversibleOperation | null;
}
