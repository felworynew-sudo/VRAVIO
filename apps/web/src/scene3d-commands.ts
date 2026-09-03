import { createRasterLayer, isRasterDocumentState, layerDocumentPixels, setLayerPixels, type RasterDocumentState, type RasterLayer, type Scene3DLayerData } from "@vravio/env-raster";
import type { ReversibleOperation } from "@vravio/kernel";
import { kernel } from "./kernel";
import { defaultScene3DLayer, renderScene3DLayerPixels } from "./scene3d-render";

function mergeableEdit(label: string, undo: () => void, redo: () => void): ReversibleOperation {
  return { label, undo, redo, mergeWith: (next) => next.label === label ? mergeableEdit(label, undo, next.redo) : null };
}

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

/** Adds a new persistent 3D layer with an editable text mesh — Photoshop's "New 3D Extrusion
 * from Text", except the result stays editable afterward (rotation, lighting, depth) rather than
 * baking once into flat pixels. */
export async function createScene3DTextLayer(documentId: string): Promise<void> {
  await addLayer(documentId, "New 3D Text Layer (Новый объёмный текстовый слой)", async (state) => {
    const layer = createRasterLayer(state.width, state.height, `3D Text ${state.layers.length + 1} (Объёмный текст ${state.layers.length + 1})`);
    layer.kind = "3d";
    layer.scene3d = defaultScene3DLayer(layer);
    setLayerPixels(layer, await renderScene3DLayerPixels(layer.scene3d, state), state.width, state.height);
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
    layer.scene3d = { ...base, source: { kind: "extrude", sourceLayerId, depth: 40 }, size: 200 };
    setLayerPixels(layer, await renderScene3DLayerPixels(layer.scene3d, state), state.width, state.height);
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
    layer.scene3d = { source: { kind: "model", assetId, fileName: file.name }, size: 100, color: "#ffffff", metalness: 0, roughness: 1, rotationX: -12, rotationY: 22, rotationZ: 0, lighting };
    setLayerPixels(layer, await renderScene3DLayerPixels(layer.scene3d, state), state.width, state.height);
    return layer;
  });
  kernel.documents.addAssetRef(documentId, assetId);
}

/** Applies a patch to a 3D layer's scene data and re-renders it — the non-destructive edit path
 * every control in the Properties panel goes through. Re-renders (not just re-composites) because
 * a 3D layer's stored pixels are its only representation on screen; there is no live WebGL canvas
 * sitting behind it the way there is while a dialog is open. */
export async function updateScene3DLayer(documentId: string, layerId: string, patch: Partial<Scene3DLayerData>): Promise<void> {
  const document = kernel.documents.get<RasterDocumentState>(documentId);
  if (!document || !isRasterDocumentState(document.state)) return;
  const state = document.state;
  const layer = state.layers.find((item) => item.id === layerId);
  if (!layer?.scene3d) return;
  // layer.pixels is stored trimmed to its opaque bounds, not full-canvas-sized — setLayerPixels
  // needs a full document-sized buffer to trim from, so the "before" snapshot has to go through
  // layerDocumentPixels rather than reusing the trimmed buffer directly (that silently corrupted
  // the restored image on undo: the trimmed bytes got reinterpreted at the wrong stride).
  const before = layer.scene3d, beforePixels = layerDocumentPixels(layer, state.width, state.height);
  const next: Scene3DLayerData = { ...before, ...patch };
  const nextPixels = await renderScene3DLayerPixels(next, state);
  const write = (data: Scene3DLayerData, pixels: Uint8ClampedArray) => kernel.documents.update<RasterDocumentState>(documentId, (current) => {
    const target = current.layers.find((item) => item.id === layerId);
    if (target) { target.scene3d = data; setLayerPixels(target, pixels, current.width, current.height); }
  });
  write(next, nextPixels);
  const history = kernel.historyByDocument.get(documentId);
  if (history) void history.record(mergeableEdit("3D Layer (3D-слой)", () => write(before, beforePixels), () => write(next, nextPixels)), true);
}
