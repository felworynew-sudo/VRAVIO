import * as THREE from "three";

export interface LightingSettings {
  ambientIntensity: number;
  ambientColor: string;
  directionalIntensity: number;
  directionalColor: string;
  /** degrees around Y (azimuth) and above the horizon (elevation) */
  azimuth: number;
  elevation: number;
}

export const defaultLighting: LightingSettings = {
  ambientIntensity: 0.55,
  ambientColor: "#ffffff",
  directionalIntensity: 1.4,
  directionalColor: "#ffffff",
  azimuth: -35,
  elevation: 45,
}

export interface Scene3D {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  ambient: THREE.AmbientLight;
  directional: THREE.DirectionalLight;
  dispose(): void;
}

/** Sets up a transparent-background WebGL scene sized to a <canvas>, with an ambient + directional light rig the caller can retune live. */
export function createScene3D(canvas: HTMLCanvasElement, width: number, height: number): Scene3D {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setClearColor(0x000000, 0);
  renderer.setSize(width, height, false);
  renderer.setPixelRatio(1);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 5000);
  camera.position.set(0, 0, 300);
  const ambient = new THREE.AmbientLight(0xffffff, defaultLighting.ambientIntensity);
  const directional = new THREE.DirectionalLight(0xffffff, defaultLighting.directionalIntensity);
  scene.add(ambient, directional);
  return { renderer, scene, camera, ambient, directional, dispose: () => renderer.dispose() };
}

export function applyLighting(target: Pick<Scene3D, "ambient" | "directional">, lighting: LightingSettings, distance = 400): void {
  target.ambient.intensity = lighting.ambientIntensity;
  target.ambient.color.set(lighting.ambientColor);
  target.directional.intensity = lighting.directionalIntensity;
  target.directional.color.set(lighting.directionalColor);
  const azimuth = lighting.azimuth * Math.PI / 180, elevation = lighting.elevation * Math.PI / 180;
  target.directional.position.set(Math.cos(elevation) * Math.sin(azimuth) * distance, Math.sin(elevation) * distance, Math.cos(elevation) * Math.cos(azimuth) * distance);
}

/** Renders one frame and reads it back as top-to-bottom RGBA, matching our document pixel buffer convention (WebGL reads bottom-up). */
export function readPixelsRgba(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, width: number, height: number): Uint8ClampedArray {
  renderer.render(scene, camera);
  const gl = renderer.getContext();
  const flipped = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, flipped);
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) out.set(flipped.subarray(y * width * 4, (y + 1) * width * 4), (height - 1 - y) * width * 4);
  return out;
}

export function centerAndFit(object: THREE.Object3D, camera: THREE.PerspectiveCamera, targetFraction = 0.62): void {
  const box = new THREE.Box3().setFromObject(object), size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
  object.position.sub(center);
  const radius = Math.max(size.x, size.y, size.z) / 2 || 1;
  const distance = (radius / targetFraction) / Math.tan((camera.fov * Math.PI / 180) / 2);
  camera.position.set(0, 0, distance);
  camera.near = Math.max(0.01, distance / 100); camera.far = distance * 10; camera.updateProjectionMatrix();
}
