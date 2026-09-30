import { createRasterLayer, isRasterDocumentState, layerPixelsView, setLayerFramePixels, setLayerLocalPixels, type RasterDocumentState, type RasterLayer, type Scene3DLayerData } from "@vravio/env-raster";
import { kernel } from "./kernel";
import { defaultScene3DLayer, renderScene3DLayer, type Scene3DRender } from "./scene3d-render";
import { mergeableEdit } from "./history-helpers";

type LayerSnapshot = { layers: RasterLayer[]; activeLayerId: string };
function snapshotLayers(state: RasterDocumentState): LayerSnapshot {
  return { layers: state.layers.map((layer) => ({ ...layer })), activeLayerId: state.activeLayerId };
}

async function addLayer(documentId: string, label: string, build: (state: RasterDocumentState) => Promise<RasterLayer>): Promise<void> {
  const document = kernel.documents.get<RasterDocumentState>(documentId);
  if (!document || !isRasterDocumentState(document.state)) return;
  const before = snapshotLayers(document.state);
  const layer = await build(document.state);
  const after: LayerSnapshot = { layers: [...before.layers, layer], activeLayerId: layer.id };
  const assign = (snapshot: LayerSnapshot): void => { kernel.documents.update<RasterDocumentState>(documentId, (state) => { state.layers = snapshot.layers.map((item) => ({ ...item })); state.activeLayerId = snapshot.activeLayerId; }); };
  const history = kernel.historyByDocument.get(documentId);
  if (history) await history.execute({ label, redo: () => assign(after), undo: () => assign(before) });
  else assign(after);
}

/**
 * The one door a 3D bake goes through into a layer — creation, conversion and every edit. Stores
 * the render in its own frame (it may reach past the canvas; the layer keeps all of it) and
 * records `placement` from what was actually stored, so the next edit can tell a Move-tool drag
 * apart from anything else. Creation paths used to write through `setLayerPixels` at canvas size
 * and never recorded `placement` at all, which left the first edit guessing (§65.11).
 */
function applyScene3DRender(layer: RasterLayer, data: Scene3DLayerData, render: Scene3DRender, offset: { x: number; y: number }): void {
  setLayerFramePixels(layer, render.pixels, render.frame);
  layer.scene3d = {
    ...data,
    placement: {
      offsetX: Math.round(offset.x), offsetY: Math.round(offset.y),
      renderedCenterX: layer.bounds.x + layer.bounds.width / 2, renderedCenterY: layer.bounds.y + layer.bounds.height / 2,
    },
  };
}

/**
 * Where a 3D layer's object sits now, relative to the canvas centre: its committed offset plus
 * whatever the Move tool has done since. `placement` (types.ts has the contract) lets this diff
 * out only what Move contributed — `currentCenter` and `renderedCenter` are the same kind of
 * measurement of the same render, so anything but a real move cancels out.
 */
export function scene3dOffset(layer: RasterLayer, state: RasterDocumentState): { x: number; y: number } {
  const placement = layer.scene3d?.placement ?? { offsetX: 0, offsetY: 0, renderedCenterX: state.width / 2, renderedCenterY: state.height / 2 };
  return {
    x: placement.offsetX + layer.bounds.x + layer.bounds.width / 2 - placement.renderedCenterX,
    y: placement.offsetY + layer.bounds.y + layer.bounds.height / 2 - placement.renderedCenterY,
  };
}

/** Re-renders a 3D layer in place, on a document being rebuilt (Image Size). */
export async function rebakeScene3DLayer(layer: RasterLayer, data: Scene3DLayerData, state: RasterDocumentState, offset: { x: number; y: number }): Promise<void> {
  applyScene3DRender(layer, data, await renderScene3DLayer(data, state, offset), offset);
}

/** Where a layer's opaque content is centred, relative to the canvas centre — the offset that puts
 * a 3D object converted from it right where it was. */
function offsetOfLayer(layer: RasterLayer, state: RasterDocumentState): { x: number; y: number } {
  return { x: layer.bounds.x + layer.bounds.width / 2 - state.width / 2, y: layer.bounds.y + layer.bounds.height / 2 - state.height / 2 };
}

/** Adds a new persistent 3D layer with an editable text mesh — Photoshop's "New 3D Extrusion
 * from Text", except the result stays editable afterward (rotation, lighting, depth) rather than
 * baking once into flat pixels. */
export async function createScene3DTextLayer(documentId: string): Promise<void> {
  await addLayer(documentId, "New 3D Text Layer (Новый объёмный текстовый слой)", async (state) => {
    const layer = createRasterLayer(state.width, state.height, `3D Text ${state.layers.length + 1} (Объёмный текст ${state.layers.length + 1})`);
    layer.kind = "3d";
    const data = defaultScene3DLayer(layer);
    applyScene3DRender(layer, data, await renderScene3DLayer(data, state), { x: 0, y: 0 });
    return layer;
  });
}

/** Adds a new persistent 3D layer that extrudes another layer's opaque silhouette — the "объект
 * из другого слоя" source, so a flat logo or shape becomes a real solid to light and rotate. */
export async function createScene3DExtrudeLayer(documentId: string, sourceLayerId: string): Promise<void> {
  await addLayer(documentId, "New 3D Extrusion Layer (Новый слой экструзии)", async (state) => {
    const source = state.layers.find((item) => item.id === sourceLayerId);
    const layer = createRasterLayer(state.width, state.height, `${source?.name ?? "Layer"} 3D (${source?.name ?? "Слой"} 3D)`);
    layer.kind = "3d";
    const base = defaultScene3DLayer(layer);
    // The solid takes its source's own size and place (§65.11); a missing source still gets a
    // sensible default rather than nothing.
    const data: Scene3DLayerData = { ...base, source: { kind: "extrude", sourceLayerId, depth: 40 }, size: source ? Math.max(source.bounds.width, source.bounds.height) : 200 };
    const offset = source ? offsetOfLayer(source, state) : { x: 0, y: 0 };
    applyScene3DRender(layer, data, await renderScene3DLayer(data, state, offset), offset);
    return layer;
  });
}

/** Imports a dropped .obj/.glb/.gltf file as a new 3D layer. The model's bytes go into the shared
 * asset store — the same "reference, not a copy" rule as every other imported picture — so a
 * later re-import of a revised file could relink it the way round-trip does for raster/vector. */
export async function importModelAsLayer(documentId: string, file: File): Promise<void> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const assetId = await kernel.assets.importAsset(bytes, { kind: "model3d", mime: file.type || "model/gltf-binary", name: file.name, producedBy: "scene3d" });
  await addLayer(documentId, `Import Model: ${file.name} (Импорт модели: ${file.name})`, async (state) => {
    const layer = createRasterLayer(state.width, state.height, file.name.replace(/\.[a-z0-9]+$/i, ""));
    layer.kind = "3d";
    const lighting = defaultScene3DLayer(layer).lighting;
    // Sized to half the canvas's shorter side — a model file's own units carry no pixel size.
    const data: Scene3DLayerData = { source: { kind: "model", assetId, fileName: file.name }, size: Math.round(Math.min(state.width, state.height) / 2), color: "#ffffff", metalness: 0, roughness: 1, rotationX: -12, rotationY: 22, rotationZ: 0, lighting };
    applyScene3DRender(layer, data, await renderScene3DLayer(data, state), { x: 0, y: 0 });
    return layer;
  });
  kernel.documents.addAssetRef(documentId, assetId);
}

/**
 * Photoshop's own "Convert to 3D": the owner's request for a text layer, generalized to any
 * layer since nothing about it is text-specific. Extrudes the layer's own opaque silhouette
 * (`createScene3DExtrudeLayer`'s own "extrude" source, reusing `traceAlphaOutlines` and its
 * Chaikin smoothing pass rather than rebuilding `TextGeometry` from the string — deliberately:
 * `TextGeometry` only has the bundled Latin-only helvetiker typeface behind it (see
 * `scene3d-render.ts`'s own doc comment on `defaultScene3DLayer`), and this project is
 * bilingual — a Cyrillic caption run through it would come out as tofu boxes or nothing at all.
 * Silhouette extrusion has no such limitation: it reads pixels, not glyphs.
 *
 * Unlike `createScene3DExtrudeLayer` (which leaves the source layer exactly as it was, visible,
 * for "extrude this other logo too"), this hides it instead of leaving two copies of the same
 * content in the stack — closer to what "convert" implies. It cannot be deleted outright: the
 * new layer's `extrude` source is a *live* reference (`sourceLayerId`), re-traced from that
 * layer's own pixels on every future re-render (rotating it, changing depth, anything that calls
 * `updateScene3DLayer`) — the same "no persistent WebGL scene behind a baked 3D layer" limitation
 * `docs/master-plan.md` §23.2 already names as the reason a full Spatial rewrite is on the
 * roadmap. Deleting the source would silently turn every future edit into an empty mesh.
 */
export async function convertLayerToScene3D(documentId: string, sourceLayerId: string): Promise<void> {
  const document = kernel.documents.get<RasterDocumentState>(documentId);
  if (!document || !isRasterDocumentState(document.state)) return;
  const state = document.state;
  const source = state.layers.find((item) => item.id === sourceLayerId);
  if (!source) return;
  const before = snapshotLayers(state);
  const layer = createRasterLayer(state.width, state.height, `${source.name} 3D (${source.name} 3D)`);
  layer.kind = "3d";
  const base = defaultScene3DLayer(layer);
  // Converted in place: the solid is as large as the layer's own content and centred on it, the
  // way Photoshop's conversion leaves the object where the layer was (§65.11) — it used to be
  // re-framed to a fixed size in the middle of the canvas.
  const data: Scene3DLayerData = { ...base, source: { kind: "extrude", sourceLayerId, depth: 40 }, size: Math.max(source.bounds.width, source.bounds.height) };
  const offset = offsetOfLayer(source, state);
  applyScene3DRender(layer, data, await renderScene3DLayer(data, state, offset), offset);

  const sourceIndex = before.layers.findIndex((item) => item.id === sourceLayerId);
  const afterLayers = before.layers.map((item) => item.id === sourceLayerId ? { ...item, visible: false } : item);
  afterLayers.splice(sourceIndex + 1, 0, layer);
  const after: LayerSnapshot = { layers: afterLayers, activeLayerId: layer.id };
  const assign = (snapshot: LayerSnapshot): void => { kernel.documents.update<RasterDocumentState>(documentId, (current) => { current.layers = snapshot.layers.map((item) => ({ ...item })); current.activeLayerId = snapshot.activeLayerId; }); };
  const history = kernel.historyByDocument.get(documentId);
  const label = "Convert to 3D (Преобразовать в 3D)";
  if (history) await history.execute({ label, redo: () => assign(after), undo: () => assign(before) });
  else assign(after);
}

/** Applies a patch to a 3D layer's scene data and re-renders it — the non-destructive edit path
 * every control in the Properties panel goes through. Re-renders (not just re-composites) because
 * a 3D layer's stored pixels are its only representation on screen; there is no live WebGL canvas
 * sitting behind it the way there is while a dialog is open. */
export async function updateScene3DLayer(documentId: string, layerId: string, patch: Partial<Scene3DLayerData>, moveBy: { x: number; y: number } = { x: 0, y: 0 }): Promise<void> {
  const document = kernel.documents.get<RasterDocumentState>(documentId);
  if (!document || !isRasterDocumentState(document.state)) return;
  const state = document.state;
  const layer = state.layers.find((item) => item.id === layerId);
  if (!layer?.scene3d) return;
  // The layer's own frame, not a canvas-sized copy: a 3D layer can reach past the canvas now, and
  // an undo through `layerDocumentPixels` would have cut that part off (§65.11).
  const before = { data: layer.scene3d, pixels: layerPixelsView(layer).slice(), bounds: { ...layer.bounds } };
  const next: Scene3DLayerData = { ...before.data, ...patch };
  // A property edit never moves the object — see `scene3dOffset`.
  const current = scene3dOffset(layer, state);
  const offset = { x: current.x + moveBy.x, y: current.y + moveBy.y };
  const render = await renderScene3DLayer(next, state, offset);
  const write = (apply: (target: RasterLayer) => void) => kernel.documents.update<RasterDocumentState>(documentId, (current) => {
    const target = current.layers.find((item) => item.id === layerId);
    if (target) apply(target);
  });
  const redo = () => write((target) => applyScene3DRender(target, next, render, offset));
  const undo = () => write((target) => { target.scene3d = before.data; setLayerLocalPixels(target, before.pixels, before.bounds); });
  redo();
  const history = kernel.historyByDocument.get(documentId);
  if (history) void history.record(mergeableEdit("3D Layer (3D-слой)", undo, redo), true);
}
