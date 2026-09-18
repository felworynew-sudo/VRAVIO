import { useSyncExternalStore } from "react";
import { convertPixelsColorSpace, limitToCmykGamut, rgbToCmyk, type RasterColorSpace } from "@vravio/env-raster";

/**
 * Soft proofing — Photoshop's View ▸ Proof Setup and View ▸ Gamut Warning (master-plan §59.3).
 *
 * Proofing shows the document as some *other* device would reproduce it, without changing a single
 * stored pixel: the picture is taken into the proof destination and straight back out, so whatever
 * that destination cannot hold is visibly gone. That is the whole value — an image that looks the
 * same proofed and unproofed is an image that will print as it looks.
 *
 * It lives here, next to the display path, for the reason CLAUDE.md §4 gives: `putPixels` and
 * `putRegionPixels` are the one door every pixel takes to the screen, so a proof applied there
 * cannot be forgotten by a caller — and cannot leak into export or storage, which take other doors
 * and must keep showing the document itself.
 *
 * Gamut warning paints out-of-gamut pixels in a flat grey (Photoshop's own default, #808080),
 * because a proof tells you *that* a colour shifted while the warning tells you *which*.
 */

export type ProofDestination = RasterColorSpace | "cmyk";

export interface ProofSettings {
  readonly destination: ProofDestination;
  readonly gamutWarning: boolean;
}

let settings: ProofSettings | null = null;
const listeners = new Set<() => void>();

/** null turns proofing off — the document is shown as itself, which is the default. */
export function setSoftProof(next: ProofSettings | null): void {
  settings = next;
  for (const listener of listeners) listener();
}

export const softProof = (): ProofSettings | null => settings;

export function subscribeSoftProof(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** How far a colour may move through the proof before it counts as out of gamut. Two levels out of
 *  255 — below that, rounding through the conversion would flag half the image. */
const WARNING_THRESHOLD = 2;

/**
 * The pixels as the proof destination would reproduce them, or the same buffer when proofing is
 * off. Never mutates its input: the caller's buffer is the document's, or a tile of it.
 */
export function applySoftProof(pixels: Uint8ClampedArray, space: RasterColorSpace): Uint8ClampedArray {
  const proof = settings;
  if (!proof) return pixels;
  const proofed = proof.destination === "cmyk"
    ? cmykProof(pixels)
    // Into the destination space and back into the document's own: what survives the round trip is
    // what that device can show.
    : convertPixelsColorSpace(convertPixelsColorSpace(pixels, space, proof.destination), proof.destination, space);
  if (!proof.gamutWarning) return proofed;
  for (let index = 0; index < pixels.length; index += 4) {
    if (!pixels[index + 3]) continue;
    const moved = Math.abs(proofed[index]! - pixels[index]!) + Math.abs(proofed[index + 1]! - pixels[index + 1]!) + Math.abs(proofed[index + 2]! - pixels[index + 2]!);
    if (moved <= WARNING_THRESHOLD) continue;
    proofed[index] = 128; proofed[index + 1] = 128; proofed[index + 2] = 128;
  }
  return proofed;
}

function cmykProof(pixels: Uint8ClampedArray): Uint8ClampedArray {
  const proofed = pixels.slice();
  limitToCmykGamut(proofed);
  return proofed;
}

/** The ink percentages under a point, for a readout that means something in a CMYK proof. */
export const proofInkAt = (r: number, g: number, b: number): { c: number; m: number; y: number; k: number } => {
  const { c, m, y, k } = rgbToCmyk(r, g, b);
  return { c: Math.round(c * 100), m: Math.round(m * 100), y: Math.round(y * 100), k: Math.round(k * 100) };
};

/**
 * The current proof, as React state.
 *
 * `useSyncExternalStore` rather than a store library for the same reason the modal registry uses
 * one: this is a single module-level value that non-React code (a command) writes, and the menu
 * has to show what it says — a tick that lies about whether proofing is on is worse than no tick.
 */
export const useSoftProof = (): ProofSettings | null => useSyncExternalStore(subscribeSoftProof, softProof, () => null);
