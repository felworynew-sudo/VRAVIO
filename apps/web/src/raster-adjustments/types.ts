import type { ComponentType } from "react";
import type { RasterAdjustment } from "@vravio/env-raster";
import type { Language } from "../store";

export interface AdjustmentEditorProps {
  value: RasterAdjustment;
  language: Language;
  histogram?: readonly number[] | undefined;
  /** The layer's own raw pixels, materialised to document size — Levels' own
   *  histogram-with-handles and its Auto button (auto-levels.ts) need the
   *  real per-channel byte values, not the 64-bin display-only luminance
   *  `histogram` above. Every other adjustment editor ignores this. */
  pixels?: Uint8ClampedArray | undefined;
  onChange(value: RasterAdjustment): void;
}

export interface RasterAdjustmentDefinition {
  id: RasterAdjustment["kind"];
  order: number;
  name: { en: string; ru: string };
  icon: string;
  shortcut?: string;
  supportsAdjustmentLayer: boolean;
  Editor: ComponentType<AdjustmentEditorProps>;
}

export interface RasterAdjustmentModule {
  default: RasterAdjustmentDefinition;
}
