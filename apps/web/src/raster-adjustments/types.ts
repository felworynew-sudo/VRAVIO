import type { ComponentType } from "react";
import type { RasterAdjustment } from "@vravio/env-raster";
import type { Language } from "../store";

export interface AdjustmentEditorProps {
  value: RasterAdjustment;
  language: Language;
  histogram?: readonly number[] | undefined;
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
