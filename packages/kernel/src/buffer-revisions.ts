import type { AssetId, AssetStore } from "./asset-store";
import type { FreeReason, ReversibleOperation } from "./types";

export interface BufferRevisionOptions {
  readonly assets: AssetStore;
  readonly assetId: AssetId;
  readonly label: string;
  /** Which environment produced the edit, for the asset ledger. */
  readonly producedBy: string;
  /**
   * Puts a restored buffer back where the document reads it from.
   * Called on both undo and redo with the bytes of the revision being shown.
   */
  apply(bytes: Uint8Array): void;
}

/**
 * Records a destructive edit to a large buffer as an asset revision.
 *
 * The obvious way to make a pixel edit reversible is to keep the buffer before
 * and the buffer after inside the history step. For a 1920×1080 layer that is
 * 8 MB each, so twenty brush strokes hold a third of a gigabyte in memory and
 * the budget starts silently throwing away undo depth.
 *
 * Here the bytes go to storage once and the step holds two revision numbers.
 * Undo and redo move the asset head and read the buffer back, which is what
 * makes deep history affordable — and it is the same mechanism the round-trip
 * between environments needs, so a stroke and an edit made in another
 * environment are undone the same way.
 *
 * The caller must have written the new revision already; pass its number as
 * `nextRev`. `previousRev` is the head the document was showing before.
 */
export function createBufferRevisionOperation(
  options: BufferRevisionOptions,
  previousRev: number,
  nextRev: number,
): ReversibleOperation {
  const { assets, assetId, apply } = options;

  const show = async (rev: number, producedBy: string): Promise<void> => {
    await assets.setHead(assetId, rev, producedBy);
    const bytes = await assets.read(assetId, rev);
    if (bytes) apply(bytes);
  };

  return {
    label: options.label,
    // The buffers are in storage, not on the heap.
    memoryEstimate: 0,
    storageEstimate: assets.get(assetId)?.revisions.find((revision) => revision.rev === nextRev)?.bytes ?? 0,
    redo: () => show(nextRev, options.producedBy),
    undo: () => show(previousRev, "undo"),
    free: async (reason: FreeReason) => {
      // Which revision died depends on why the step was released. Guessing from
      // the current head is not possible: by the time this runs the replacing
      // step is already applied, so a guess collects the revision it stands on.
      const orphan = reason === "discarded" ? nextRev : previousRev;
      await assets.dropRevision(assetId, orphan);
    },
  };
}
