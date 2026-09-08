import { activeRasterLayer, isRasterDocumentState, layerDocumentPixels } from "@vravio/env-raster";
import type { PluginPayload, PluginSurface } from "../../../plugins/types";

/**
 * How the raster environment lets a plugin see and change a document.
 *
 * Everything raster-shaped about the plugin system now lives here: the word
 * "pixels", the width × height × 4 arithmetic, and the door an accepted result
 * goes through. `plugins/host.ts` used to hold all three and therefore could
 * only ever serve raster.
 *
 * The environment is not declared anywhere in this file — it is the directory
 * this file sits in (`environments/raster/plugins/surface.ts`), so a raster
 * surface cannot claim to be anything else.
 */

/** What a raster workspace hands over: its own commit path. `commitPixels` is
 * bound to a hook inside `RasterWorkspace.tsx` and cannot be reached from
 * module scope, so the workspace passes it in rather than this file importing
 * something that would only be a second door beside it. */
export interface RasterPluginDoor {
  readonly layerId: string;
  readonly before: Uint8ClampedArray;
  commitPixels(before: Uint8ClampedArray, after: Uint8ClampedArray, label: string, kind: "pixels", layerId: string): void;
}

const surface: PluginSurface = {
  payloadKind: "pixels",

  read(state) {
    if (!isRasterDocumentState(state)) return null;
    const layer = activeRasterLayer(state);
    const pixels = layerDocumentPixels(layer, state.width, state.height);
    // Copied into its own buffer: what goes to the plugin is transferred, and
    // transferring the layer's live buffer would detach it from the document.
    const copy = pixels.slice();
    return { kind: "pixels", buffer: copy.buffer as ArrayBuffer, meta: { width: state.width, height: state.height } };
  },

  accept(returned, sent) {
    if (returned.kind !== sent.kind) return `returned "${returned.kind}" where this environment expects "${sent.kind}"`;
    if (!returned.buffer) return null;
    // A buffer of the wrong size would be written into the layer as garbage,
    // or throw far from here. The plugin was told the dimensions; returning
    // something else is a plugin bug, and it is caught rather than trusted.
    const expected = Number(sent.meta.width) * Number(sent.meta.height) * 4;
    if (returned.buffer.byteLength !== expected) return `returned ${returned.buffer.byteLength} bytes, expected ${expected}`;
    return null;
  },

  commit(returned, _sent, _state, door) {
    if (!returned.buffer) return;
    const { layerId, before, commitPixels } = door as RasterPluginDoor;
    commitPixels(before, new Uint8ClampedArray(returned.buffer), "Plugin", "pixels", layerId);
  },
};

export default surface;
