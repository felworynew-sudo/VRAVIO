import { AdjustmentEditor } from "../AdjustmentEditor";
export default { id: "channelMixer", order: 100, name: { en: "Channel Mixer", ru: "Микширование каналов" }, icon: "/adjustment-channel-mixer.svg", supportsAdjustmentLayer: true, Editor: AdjustmentEditor } as const;
