import type { ModelSpec } from "@vravio/kernel";
import type { LocalizedText } from "../../i18n";

/**
 * docs/master-plan.md §52.6 — "one engine, two entry points": the same model
 * and `run.ts` back both Filter → Noise → AI Denoise and Camera Raw's own
 * Detail panel, so this contract only needs what both callers share.
 *
 * Deliberately thinner than `ml/segment/types.ts`'s `SegmentModelDefinition`:
 * every model here is fully convolutional and runs at the document's own
 * resolution (no fixed square to resample to and back), and takes plain 0..1
 * RGB with no per-channel normalization — verified against the loaded graph,
 * not assumed, for each definition (see `definitions/realplksr-denoise.ts`'s
 * own comment). A model that needed either would earn its own richer fields
 * here rather than a guessed default silently applied to every entry.
 */
export interface DenoiseModelDefinition {
  readonly id: string;
  readonly label: LocalizedText;
  readonly spec: ModelSpec;
  readonly note?: LocalizedText;
}

export type DenoiseModelModule = { default: DenoiseModelDefinition };
