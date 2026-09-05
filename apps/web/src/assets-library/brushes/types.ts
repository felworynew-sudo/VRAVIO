import type { LocalizedText } from "../../i18n";

/**
 * A named set of brush settings.
 *
 * Stage 10 of docs/migration-plan.md. These were three buttons written into
 * `RasterBrushTipPopup.tsx`, each with its own `setToolOption` calls — so a
 * fourth preset meant editing the popup, and a preset could set an option that
 * no longer existed without anything noticing.
 *
 * `options` names tool options by id, the same ids `tools.ts` declares for the
 * brush family. The contract test holds them to that: a preset that sets an
 * option the brush does not have is a preset that silently does nothing.
 */
export interface BrushPreset {
  readonly id: string;
  readonly label: LocalizedText;
  /** The glyph shown on the preset's button. */
  readonly glyph: string;
  readonly order: number;
  readonly options: Readonly<Record<string, number | string | boolean>>;
}

export type BrushPresetModule = { default: BrushPreset };
