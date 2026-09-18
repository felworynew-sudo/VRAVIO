import { describe, expect, it } from "vitest";
import { ensureCommandsRegistered } from "../commands";
import { kernel } from "../kernel";
import { localized } from "../i18n";

/**
 * Stage 7 of docs/migration-plan.md moves all eighty command registrations out
 * of one 327-line `ensureCommandsRegistered` into per-environment catalogue
 * files. This is the net underneath that move.
 *
 * Recorded from the running application *before* the move, so it describes the
 * behaviour being preserved rather than the code that replaced it. Id, shortcut
 * and scope are the fields a mechanical re-typing breaks invisibly — a dropped
 * `Mod+`, a shortcut bound in the wrong scope and a command that quietly stops
 * appearing all look like nothing at all until someone presses the key. The
 * category comes along because it is what decides which menu a command lands
 * in, and a command in the wrong menu is just as silent.
 *
 * Deliberately not a snapshot file: a snapshot that regenerates itself on
 * `-u` would have recorded whatever the refactor produced, which is precisely
 * the thing under test.
 *
 * A deliberate addition is edited in by hand, with a line saying why — which
 * is the point. The list is meant to be tedious to change, so that changing it
 * is always a decision rather than a keystroke.
 */
const REGISTERED_BEFORE_STAGE_7: readonly string[] = [
  "app.settings|||Edit",
  // docs/master-plan.md §49 point 2: every AudioMass menu command (File/Edit/Effects/View, all
  // dispatching the same "vravio-audiomass-command" event the menu items already use) also
  // reachable from the Command Palette — added deliberately after the palette's own catalogue
  // was found to have zero entries for audio at all.
  "audio.edit.deselectAll|||Edit",
  "audio.edit.play|||Edit",
  "audio.edit.redo|||Edit",
  "audio.edit.selectAll|||Edit",
  "audio.edit.stop|||Edit",
  "audio.edit.undo|||Edit",
  "audio.effect.compressor|||Audio Effects",
  "audio.effect.delay|||Audio Effects",
  "audio.effect.fadeIn|||Audio Effects",
  "audio.effect.fadeOut|||Audio Effects",
  "audio.effect.gain|||Audio Effects",
  "audio.effect.graphicEq|||Audio Effects",
  "audio.effect.hardLimiter|||Audio Effects",
  "audio.effect.normalize|||Audio Effects",
  "audio.effect.removeSilence|||Audio Effects",
  "audio.effect.reverb|||Audio Effects",
  "audio.effect.reverse|||Audio Effects",
  "audio.file.export|||File",
  "audio.file.newRecording|||File",
  "audio.file.openDrafts|||File",
  "audio.file.open|||File",
  "audio.file.saveDraft|||File",
  "audio.view.centerToCursor|||View",
  "audio.view.frequencyAnalyser|||View",
  "audio.view.id3Tags|||View",
  "audio.view.multitrackMixer|||View",
  "audio.view.resetZoom|||View",
  "audio.view.spectrumAnalyser|||View",
  "audio.view.tempoTools|||View",
  // Stage 11: copy/cut/paste, the first users of the platform's clipboard port.
  "edit.contentAwareFill|||Edit", // master-plan §11: the selection filled by the existing inpainting model
  "edit.copy|Mod+C||Edit",
  "edit.cut|Mod+X||Edit",
  // Photoshop's Fill hotkeys, reported live by the owner: Alt/Ctrl+Delete
  // painting Foreground/Background over a selection, mask-aware when a mask
  // is being edited (fill-shortcuts.ts).
  "edit.fillBackground|Mod+Delete||Edit",
  "edit.fillForeground|Alt+Delete||Edit",
  "edit.freeTransform|Mod+T||Edit",
  "edit.pasteInPlace|Mod+Shift+V||Edit",
  "edit.paste|Mod+V||Edit",
  "edit.redo|Mod+Shift+Z||Edit",
  "edit.undo|Mod+Z||Edit",
  "file.close|Mod+W||File",
  "file.export|Mod+Shift+Alt+W||File",
  "file.new.audio|||File",
  "file.new.raster|Mod+N||File",
  "file.new.vector|||File",
  "file.new.video|||File",
  "file.open|Mod+O||File",
  // Print used to be a bare `window.print()` wired straight into the menu item's onClick,
  // with no command definition and no real keyboard binding — added alongside the actual
  // print pipeline (docs/master-plan.md §7.2) so Ctrl+P works the same way Ctrl+Shift+E does.
  "file.print|Mod+P||File",
  "file.saveAs|Mod+Shift+S||File",
  "file.saveCopy|Mod+Alt+S||File",
  "file.save|Mod+S||File",
  "filter.cameraRawFilter|Mod+Shift+A||Filter",
  "filter.liquify|Mod+Shift+X||Filter",
  "filter.repeatLast|Mod+Alt+F||Filter",
  "image.adjustment.colorBalance|Mod+B||Image",
  "image.adjustment.curves|Mod+M||Image",
  "image.adjustment.hueSaturation|Mod+U||Image",
  "image.adjustment.invert|Mod+I||Image",
  "image.adjustment.levels|Mod+L||Image",
  "image.adjustment.quickHarmonize|||Image",
  // master-plan §59: the document's working colour space — Photoshop's own two operations, one
  // that changes what the numbers mean and one that rewrites them.
  "image.assignColorSpace|||Image",
  "image.convertColorSpace|||Image",
  // master-plan §59: Image ▸ Mode's two colour models — the modes this engine can actually be in.
  "image.mode.grayscale|||Image",
  "image.mode.rgb|||Image",
  "image.openElsewhereBranch|||Object",
  "image.openElsewhere|||Object",
  // Added deliberately in stage 9: three hard-coded Smart Crop menu entries
  // became one command with a `ratio` argument — the first command in the
  // application to take one, and what stopped `args` being a field nobody read.
  "image.smartCrop|||Image",
  // master-plan §11: Add Layer Mask was a Layers-panel closure; the Contextual Task Bar needed
  // it too, so it became one command both call.
  "layer.addMask|||Layer",
  "layer.applyMask|||Layer", // master-plan §11: the Layers panel mask closures, made commands
  "layer.bringForward|Mod+]||Layer",
  "layer.bringToFront|Mod+Shift+]||Layer",
  "layer.clear|Delete||Layer",
  "layer.convertToSmartObject|||Layer",
  "layer.deleteMask|||Layer",
  "layer.delete|||Layer",
  "layer.duplicate|Mod+J||Layer",
  "layer.editSmartObjectContents|||Layer",
  "layer.embedLinkedSmartObject|||Layer",
  "layer.group|Mod+G||Layer",
  "layer.mergeDown|Mod+E||Layer",
  "layer.mergeVisible|Mod+Shift+E||Layer",
  "layer.new3DExtrude|||3D",
  "layer.new3DText|||3D",
  "layer.newSmartObjectViaCopy|||Layer",
  "layer.new|Mod+Shift+N||Layer",
  "layer.openElsewhereBranch|||Layer",
  "layer.openElsewhere|||Layer",
  "layer.placeLinkedSmartObject|||Layer",
  "layer.relinkSmartObject|||Layer",
  // master-plan §11: the Properties Quick Actions pair, made commands for the Contextual Task Bar.
  "layer.removeBackground|||Layer",
  "layer.replaceSmartObjectContents|||Layer",
  "layer.sendBackward|Mod+[||Layer",
  "layer.sendToBack|Mod+Shift+[||Layer",
  "layer.stampVisible|Mod+Shift+Alt+E||Layer",
  "layer.toggleClippingMask|Mod+Alt+G||Layer",
  "layer.toggleMaskEnabled|||Layer",
  "layer.ungroup|Mod+Shift+G||Layer",
  "layer.updateLinkedSmartObject|||Layer",
  "layer.viaCut|Mod+Shift+J||Layer",
  "roundtrip.apply|Mod+Shift+Enter||File",
  "roundtrip.detach|||File",
  // Stage 9's four script commands, added deliberately.
  "script.delete|||Scripts",
  "script.play|||Scripts",
  "script.record|||Scripts",
  "script.stop|||Scripts",
  "select.all|Mod+A||Select",
  "select.contract|||Select", // master-plan §11: Select ▸ Modify, engine in env-raster/selection-modify.ts
  "select.expand|||Select",
  "select.feather|Shift+F6||Select",
  "select.hideEdges|Mod+H||View",
  "select.invert|Mod+Shift+I||Select",
  "select.none|Mod+D||Select",
  "select.opaque|||Select",
  "select.reselect|Mod+Shift+D||Select",
  "select.smooth|||Select",
  "select.subject|||Select", // master-plan §11, see layer.removeBackground
  "select.transform|||Select", // master-plan §11: Transform Selection, outline only
  "tool.raster.b|B|raster|Tools",
  "tool.raster.c|C|raster|Tools",
  "tool.raster.e|E|raster|Tools",
  "tool.raster.g|G|raster|Tools",
  "tool.raster.h|H|raster|Tools",
  "tool.raster.i|I|raster|Tools",
  "tool.raster.j|J|raster|Tools",
  "tool.raster.l|L|raster|Tools",
  "tool.raster.m|M|raster|Tools",
  "tool.raster.o|O|raster|Tools",
  // Puppet Warp has no shortcut letter — Photoshop reaches its own from a menu rather than a key — so it is
  // named in the palette instead of pressed. Without this entry the tool was reachable only from a toolbar
  // flyout: searching the palette for "марионеточная" found nothing at all.
  "tool.raster.puppetWarp|||Tools",
  "tool.raster.r|R|raster|Tools",
  // Object Selection (MobileSAM) has no shortcut letter either — same reasoning as Puppet Warp's
  // own entry above, and same fix: without this, the palette could not find it by name at all.
  "tool.raster.selectObject|||Tools",
  "tool.raster.s|S|raster|Tools",
  "tool.raster.t|T|raster|Tools",
  "tool.raster.u|U|raster|Tools",
  "tool.raster.v|V|raster|Tools",
  "tool.raster.w|W|raster|Tools",
  "tool.raster.z|Z|raster|Tools",
  "tool.vector.\\|\\|vector|Tools", // the Line tool (vector.line) — Illustrator's own bare "\" shortcut for the Line Segment Tool, no remap needed.
  "tool.vector.a|A|vector|Tools",
  "tool.vector.b|B|vector|Tools", // stage 15 of docs/vector-plan.md: the Artboard tool, added after this list's own stage-7 snapshot — a real new command, not a migration artifact, so it belongs here too.
  "tool.vector.c|C|vector|Tools", // the Curvature Tool (vector.curvature) — Illustrator's own Shift+~, remapped to a free single-letter shortcut this project's tool shortcuts all use.
  "tool.vector.h|H|vector|Tools", // the vector Hand tool — raster always had one (raster.hand, below), vector never did; added alongside vector.zoom off a live bug report that vector had no dedicated pan/zoom tools at all.
  "tool.vector.o|O|vector|Tools",
  "tool.vector.p|P|vector|Tools",
  "tool.vector.r|R|vector|Tools",
  "tool.vector.t|T|vector|Tools",
  "tool.vector.v|V|vector|Tools",
  "tool.vector.x|X|vector|Tools", // Shape Builder (vector.shape-builder) — Inkscape's own bare "X" shortcut for the same tool, no remap needed.
  "tool.vector.z|Z|vector|Tools", // the vector Zoom tool — same addition as vector.hand just above.
  "view.actual|Mod+1||View",
  "view.commandPalette|Mod+K||Edit", // was Mod+F — collided with the browser's own find-in-page and didn't match the shell's own menu label ("Ctrl+K"), so the shortcut was silently unreachable either way; see edit.ts's own note.
  "view.contextualTaskBar|||View", // master-plan §11: Photoshop's Window ▸ Contextual Task Bar
  "view.fit|Mod+0||View",
  "view.resetRotation|||View",
  "view.theme|||View",
  "view.toggleGuides|Mod+;||View",
  "view.toggleRulers|Mod+R||View",
  "view.zoomIn|Mod++||View",
  "view.zoomOut|Mod+-||View",
];

const rowsNow = () => {
  ensureCommandsRegistered();
  return kernel.commands.list().map((command) => `${command.id}|${command.shortcut ?? ""}|${command.scope ?? ""}|${localized(command.category, "en")}`).sort();
};

describe("the command set survives being split into catalogue files", () => {
  it("registers exactly the commands it registered before the split", () => {
    expect(rowsNow()).toEqual([...REGISTERED_BEFORE_STAGE_7]);
  });

  it("gives every command a label and a category in both languages", () => {
    ensureCommandsRegistered();
    for (const command of kernel.commands.list()) {
      for (const language of ["en", "ru"] as const) {
        expect(localized(command.label, language), `${command.id} label (${language})`).toBeTruthy();
        expect(localized(command.category, language), `${command.id} category (${language})`).toBeTruthy();
      }
    }
  });
});
