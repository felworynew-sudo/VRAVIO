import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { FontLoader } from "three/addons/loaders/FontLoader.js";
import { TextGeometry } from "three/addons/geometries/TextGeometry.js";
import { applyLighting, centerAndFit, createScene3D, defaultLighting, readPixelsRgba, type LightingSettings, type Scene3D } from "./three3d";
import { text as t } from "./i18n";
import type { Language } from "./store";

interface Text3DSettings {
  value: string;
  font: "helvetiker_regular" | "helvetiker_bold";
  size: number;
  depth: number;
  bevelEnabled: boolean;
  bevelThickness: number;
  bevelSize: number;
  bevelSegments: number;
  curveSegments: number;
  color: string;
  metalness: number;
  roughness: number;
  rotationX: number;
  rotationY: number;
  rotationZ: number;
}

const defaultSettings: Text3DSettings = { value: "VRAVIO", font: "helvetiker_bold", size: 60, depth: 24, bevelEnabled: true, bevelThickness: 3, bevelSize: 2, bevelSegments: 4, curveSegments: 6, color: "#c9cfda", metalness: 0.25, roughness: 0.4, rotationX: -12, rotationY: 22, rotationZ: 0 };

const fontCache = new Map<string, Promise<InstanceType<typeof FontLoader> extends never ? never : Awaited<ReturnType<FontLoader["loadAsync"]>>>>();
function loadFont(name: string) {
  if (!fontCache.has(name)) fontCache.set(name, new FontLoader().loadAsync(`/fonts/${name}.typeface.json`));
  return fontCache.get(name)!;
}

export function Text3DDialog({ documentWidth, documentHeight, language, onCancel, onConfirm }: { documentWidth: number; documentHeight: number; language: Language; onCancel(): void; onConfirm(pixels: Uint8ClampedArray): void }) {
  const [settings, setSettings] = useState(defaultSettings);
  const [lighting, setLighting] = useState<LightingSettings>(defaultLighting);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<Scene3D | null>(null);
  const meshRef = useRef<THREE.Mesh | null>(null);
  const set = <K extends keyof Text3DSettings>(key: K, value: Text3DSettings[K]) => setSettings((current) => ({ ...current, [key]: value }));
  const setLight = <K extends keyof LightingSettings>(key: K, value: LightingSettings[K]) => setLighting((current) => ({ ...current, [key]: value }));

  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const scene3d = createScene3D(canvas, 520, 420);
    sceneRef.current = scene3d;
    return () => { scene3d.dispose(); sceneRef.current = null; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadFont(settings.font).then((font) => {
      if (cancelled) return;
      const scene3d = sceneRef.current; if (!scene3d) return;
      if (meshRef.current) { scene3d.scene.remove(meshRef.current); meshRef.current.geometry.dispose(); }
      const geometry = new TextGeometry(settings.value || " ", { font, size: settings.size, depth: settings.depth, curveSegments: settings.curveSegments, bevelEnabled: settings.bevelEnabled, bevelThickness: settings.bevelThickness, bevelSize: settings.bevelSize, bevelSegments: settings.bevelSegments });
      const material = new THREE.MeshStandardMaterial({ color: settings.color, metalness: settings.metalness, roughness: settings.roughness });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.rotation.set(settings.rotationX * Math.PI / 180, settings.rotationY * Math.PI / 180, settings.rotationZ * Math.PI / 180);
      scene3d.scene.add(mesh);
      centerAndFit(mesh, scene3d.camera);
      meshRef.current = mesh;
      applyLighting(scene3d, lighting, 500);
      scene3d.renderer.render(scene3d.scene, scene3d.camera);
    });
    return () => { cancelled = true; };
  }, [settings, lighting]);

  const confirm = () => {
    const scene3d = sceneRef.current; if (!scene3d || !meshRef.current) return;
    const full = createScene3D(document.createElement("canvas"), documentWidth, documentHeight);
    full.scene.add(meshRef.current.clone());
    full.camera.copy(scene3d.camera); full.camera.aspect = documentWidth / documentHeight; full.camera.updateProjectionMatrix();
    applyLighting(full, lighting, 500);
    const pixels = readPixelsRgba(full.renderer, full.scene, full.camera, documentWidth, documentHeight);
    full.dispose();
    onConfirm(pixels);
  };

  return <div className="dialog-backdrop text3d-backdrop" onMouseDown={onCancel}>
    <section className="text3d-dialog" role="dialog" aria-modal="true" aria-label="3D Text" onMouseDown={(event) => event.stopPropagation()}>
      <header><strong>{t(language, "3D Text", "Объёмный текст")}</strong><button onClick={onCancel}>×</button></header>
      <div className="text3d-body">
        <div className="text3d-preview"><canvas ref={canvasRef} width={520} height={420}/></div>
        <aside className="text3d-settings">
          <label>{t(language, "Text", "Текст")}<input value={settings.value} onChange={(event) => set("value", event.target.value)}/></label>
          <label>{t(language, "Font weight", "Начертание")}<select value={settings.font} onChange={(event) => set("font", event.target.value as Text3DSettings["font"])}><option value="helvetiker_regular">Regular</option><option value="helvetiker_bold">Bold</option></select></label>
          <label>{t(language, "Size", "Размер")}<input type="range" min={10} max={140} value={settings.size} onChange={(event) => set("size", event.target.valueAsNumber)}/><output>{settings.size}</output></label>
          <label>{t(language, "Extrusion Depth", "Глубина экструзии")}<input type="range" min={0} max={80} value={settings.depth} onChange={(event) => set("depth", event.target.valueAsNumber)}/><output>{settings.depth}</output></label>
          <label className="text3d-check"><input type="checkbox" checked={settings.bevelEnabled} onChange={(event) => set("bevelEnabled", event.target.checked)}/>{t(language, "Bevel", "Фаска")}</label>
          <label>{t(language, "Bevel Thickness", "Толщина фаски")}<input type="range" min={0} max={12} step={0.5} value={settings.bevelThickness} onChange={(event) => set("bevelThickness", event.target.valueAsNumber)}/><output>{settings.bevelThickness}</output></label>
          <label>{t(language, "Bevel Size", "Размер фаски")}<input type="range" min={0} max={10} step={0.5} value={settings.bevelSize} onChange={(event) => set("bevelSize", event.target.valueAsNumber)}/><output>{settings.bevelSize}</output></label>
          <label>{t(language, "Bevel Segments", "Сегменты фаски")}<input type="range" min={1} max={10} value={settings.bevelSegments} onChange={(event) => set("bevelSegments", event.target.valueAsNumber)}/><output>{settings.bevelSegments}</output></label>
          <label>{t(language, "Color", "Цвет")}<input type="color" value={settings.color} onChange={(event) => set("color", event.target.value)}/></label>
          <label>{t(language, "Metalness", "Металличность")}<input type="range" min={0} max={1} step={0.05} value={settings.metalness} onChange={(event) => set("metalness", event.target.valueAsNumber)}/><output>{settings.metalness}</output></label>
          <label>{t(language, "Roughness", "Шероховатость")}<input type="range" min={0} max={1} step={0.05} value={settings.roughness} onChange={(event) => set("roughness", event.target.valueAsNumber)}/><output>{settings.roughness}</output></label>
          <label>{t(language, "Rotate X", "Вращение X")}<input type="range" min={-180} max={180} value={settings.rotationX} onChange={(event) => set("rotationX", event.target.valueAsNumber)}/><output>{settings.rotationX}°</output></label>
          <label>{t(language, "Rotate Y", "Вращение Y")}<input type="range" min={-180} max={180} value={settings.rotationY} onChange={(event) => set("rotationY", event.target.valueAsNumber)}/><output>{settings.rotationY}°</output></label>
          <label>{t(language, "Light Azimuth", "Свет: азимут")}<input type="range" min={-180} max={180} value={lighting.azimuth} onChange={(event) => setLight("azimuth", event.target.valueAsNumber)}/><output>{lighting.azimuth}°</output></label>
          <label>{t(language, "Light Elevation", "Свет: высота")}<input type="range" min={0} max={90} value={lighting.elevation} onChange={(event) => setLight("elevation", event.target.valueAsNumber)}/><output>{lighting.elevation}°</output></label>
          <label>{t(language, "Light Intensity", "Яркость света")}<input type="range" min={0} max={4} step={0.1} value={lighting.directionalIntensity} onChange={(event) => setLight("directionalIntensity", event.target.valueAsNumber)}/><output>{lighting.directionalIntensity}</output></label>
        </aside>
      </div>
      <footer><button onClick={onCancel}>{t(language, "Cancel", "Отмена")}</button><button className="primary" onClick={confirm}>{t(language, "Add Layer", "Добавить слой")}</button></footer>
    </section>
  </div>;
}
