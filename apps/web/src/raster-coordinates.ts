import type { Point } from "@vravio/env-raster";
import type { DocumentViewport } from "./store";

/**
 * Pure coordinate/zoom math shared across `RasterWorkspace.tsx`'s pointer
 * bridge, canvas navigation and brush cursor — split out purely to bring the
 * host component's own line count down (docs/migration-plan.md §8), not
 * because any of this changed. No React, no state: every function here reads
 * only its own arguments.
 */

export function clampZoom(zoom: number): number {
  return Math.max(0.01, Math.min(64, zoom));
}

export function rulerStep(zoom: number): number {
  const desiredDocumentPixels = 72 / Math.max(.0001, zoom), power = 10 ** Math.floor(Math.log10(desiredDocumentPixels)), normalized = desiredDocumentPixels / power;
  return (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * power;
}

/**
 * How hard the pointer is pressing, on a scale the brush can use.
 *
 * The Pointer Events specification says a device with no pressure sensor must
 * report 0.5 while a button is held, and 0 only when nothing is touching.
 * Safari reports a hard 0 throughout a stroke for pens and touches it has no
 * pressure for, and taking that at face value scales the brush to nothing: a
 * 24-pixel tip becomes 0.6 of a pixel, so the stroke is committed and saved and
 * simply cannot be seen.
 *
 * A zero arriving mid-stroke therefore means "this device is not telling me",
 * not "the user is not pressing".
 */
export function strokePressure(event: { pointerType: string; pressure: number; buttons: number }): number {
  if (event.pointerType === "mouse") return 1;
  if (event.pressure > 0) return Math.max(0.05, event.pressure);
  // Down but reporting nothing: fall back to the value the specification
  // reserves for a device without a sensor.
  return event.buttons === 0 ? 0.05 : 0.5;
}

/**
 * Which way the space bar zooms, given the modifiers held with it.
 *
 * Photoshop makes space plus the platform key a temporary Zoom In, and zooms
 * out with Option and space on macOS or Ctrl+Alt and space on Windows. Both
 * spellings of "out" are accepted rather than sniffing the platform, since they
 * do not collide with anything else here. Space alone stays the Hand tool.
 *
 * On macOS the system claims Cmd+Space for Spotlight, and it wins; zooming out
 * with Option is unaffected.
 */
export function spaceZoomFrom(event: { metaKey: boolean; ctrlKey: boolean; altKey: boolean }): "in" | "out" | null {
  if (event.altKey) return "out";
  return event.metaKey || event.ctrlKey ? "in" : null;
}

export function pointFromNativeEvent(workspace: HTMLDivElement, viewport: DocumentViewport, width: number, height: number, event: PointerEvent): Point {
  const rect = workspace.getBoundingClientRect();
  const dx = event.clientX - rect.left - rect.width / 2 - viewport.panX;
  const dy = event.clientY - rect.top - rect.height / 2 - viewport.panY;
  const radians = viewport.rotation * Math.PI / 180;
  const cosine = Math.cos(radians), sine = Math.sin(radians);
  return { x: (cosine * dx + sine * dy) / viewport.zoom + width / 2, y: (-sine * dx + cosine * dy) / viewport.zoom + height / 2, pressure: strokePressure(event) };
}

export function zoomAroundClient(workspace: HTMLDivElement, viewport: DocumentViewport, zoom: number, clientX: number, clientY: number): Partial<DocumentViewport> {
  const rect = workspace.getBoundingClientRect();
  const x = clientX - rect.left - rect.width / 2, y = clientY - rect.top - rect.height / 2;
  const ratio = zoom / viewport.zoom;
  return { zoom, panX: x - (x - viewport.panX) * ratio, panY: y - (y - viewport.panY) * ratio, mode: "custom" };
}
