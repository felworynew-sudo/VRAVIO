import { AdjustmentEditor } from "../AdjustmentEditor";
export default { id: "blackWhite", order: 80, name: { en: "Black & White", ru: "Чёрно-белый" }, icon: "/adjustment-black-white.svg", shortcut: "Ctrl+Alt+Shift+B", supportsAdjustmentLayer: true, Editor: AdjustmentEditor } as const;
