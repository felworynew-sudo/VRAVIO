import { AdjustmentEditor } from "../AdjustmentEditor";
export default { id: "photoFilter", order: 90, name: { en: "Photo Filter", ru: "Фотофильтр" }, icon: "/adjustment-photo-filter.svg", supportsAdjustmentLayer: true, Editor: AdjustmentEditor } as const;
