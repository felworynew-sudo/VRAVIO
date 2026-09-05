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
 */
const REGISTERED_BEFORE_STAGE_7: readonly string[] = [
  "app.settings|||Edit",
  "edit.freeTransform|Mod+T||Edit",
  "edit.redo|Mod+Shift+Z||Edit",
  "edit.undo|Mod+Z||Edit",
  "file.close|Mod+W||File",
  "file.export|Mod+Shift+Alt+W||File",
  "file.new.audio|||File",
  "file.new.raster|Mod+N||File",
  "file.new.vector|||File",
  "file.new.video|||File",
  "file.open|Mod+O||File",
  "file.saveAs|Mod+Shift+S||File",
  "file.saveCopy|Mod+Alt+S||File",
  "file.save|Mod+S||File",
  "filter.liquify|Mod+Shift+X||Filter",
  "image.adjustment.colorBalance|Mod+B||Image",
  "image.adjustment.curves|Mod+M||Image",
  "image.adjustment.hueSaturation|Mod+U||Image",
  "image.adjustment.invert|Mod+I||Image",
  "image.adjustment.levels|Mod+L||Image",
  "image.openElsewhereBranch|||Object",
  "image.openElsewhere|||Object",
  "layer.bringForward|Mod+]||Layer",
  "layer.bringToFront|Mod+Shift+]||Layer",
  "layer.delete|||Layer",
  "layer.duplicate|Mod+J||Layer",
  "layer.group|Mod+G||Layer",
  "layer.mergeDown|Mod+E||Layer",
  "layer.mergeVisible|Mod+Shift+E||Layer",
  "layer.new3DExtrude|||3D",
  "layer.new3DText|||3D",
  "layer.new|Mod+Shift+N||Layer",
  "layer.openElsewhereBranch|||Layer",
  "layer.openElsewhere|||Layer",
  "layer.sendBackward|Mod+[||Layer",
  "layer.sendToBack|Mod+Shift+[||Layer",
  "layer.stampVisible|Mod+Shift+Alt+E||Layer",
  "layer.ungroup|Mod+Shift+G||Layer",
  "layer.viaCut|Mod+Shift+J||Layer",
  "roundtrip.apply|Mod+Shift+Enter||File",
  "roundtrip.detach|||File",
  "select.all|Mod+A||Select",
  "select.feather|Shift+F6||Select",
  "select.hideEdges|Mod+H||View",
  "select.invert|Mod+Shift+I||Select",
  "select.none|Mod+D||Select",
  "select.opaque|||Select",
  "select.reselect|Mod+Shift+D||Select",
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
  "tool.raster.r|R|raster|Tools",
  "tool.raster.s|S|raster|Tools",
  "tool.raster.t|T|raster|Tools",
  "tool.raster.u|U|raster|Tools",
  "tool.raster.v|V|raster|Tools",
  "tool.raster.w|W|raster|Tools",
  "tool.raster.z|Z|raster|Tools",
  "tool.vector.a|A|vector|Tools",
  "tool.vector.o|O|vector|Tools",
  "tool.vector.p|P|vector|Tools",
  "tool.vector.r|R|vector|Tools",
  "tool.vector.t|T|vector|Tools",
  "tool.vector.v|V|vector|Tools",
  "view.actual|Mod+1||View",
  "view.commandPalette|Mod+F||Edit",
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
