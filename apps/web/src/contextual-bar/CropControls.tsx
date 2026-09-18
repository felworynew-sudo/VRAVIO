import { text as bilingual } from "../i18n";
import { useShellStore } from "../store";

/**
 * The crop session's own "fill the exposed border with AI" toggle — Photoshop
 * puts Generative Expand on the bar when a crop reaches outside the image.
 * VRAVIO's equivalent already exists as the crop tool's `aiBorderFill` option
 * (the local MI-GAN/LaMa fill, master-plan §52.8); this is the same option,
 * written through the same `setToolOption` the options bar uses, not a second
 * switch of its own.
 */
export function CropAiFillToggle() {
  const language = useShellStore((store) => store.language);
  const active = Boolean(useShellStore((store) => store.toolOptions["raster.crop"]?.aiBorderFill));
  const setToolOption = useShellStore((store) => store.setToolOption);
  const label = bilingual(language, "Fill expanded area with AI", "ИИ заливка границ");
  return <button
    type="button"
    className={`contextual-bar-icon-button${active ? " active" : ""}`}
    data-action="crop.aiBorderFill"
    aria-pressed={active}
    title={label}
    aria-label={label}
    onClick={() => setToolOption("raster.crop", "aiBorderFill", !active)}
  ><i className="contextual-bar-icon" style={{ "--icon-mask": `url("${import.meta.env.BASE_URL}${encodeURIComponent("ИИ.svg")}")` } as React.CSSProperties} aria-hidden="true" /></button>;
}
