import { layerOpaqueBounds, nearestVertex, puppetMesh, puppetWarpPixels, setLayerPixels, solvePuppetMesh, type PuppetMesh, type PuppetPin, type RasterRect } from "@vravio/env-raster";
import { useEffect } from "react";
import type { RasterToolDefinition, ToolContext } from "../types";

/**
 * Puppet Warp: drop pins on the artwork, drag one, and the rest follows as
 * rigidly as it can (master-plan.md §1.2).
 *
 * The deformation itself is `packages/env-raster/src/puppet.ts` — the donor's
 * ARAP solve. This file is only the session around it: where the mesh comes
 * from, what a click does, and when the result is written to the document.
 *
 * A session rather than a one-drag commit, like Crop and the Move tool's
 * transform: the whole point is placing several pins and then working them, so
 * nothing reaches the document until Enter (or the tool being put down), and
 * Escape throws the session away.
 *
 * Photoshop's three pin kinds map onto one constraint and two intentions: a
 * Position pin is one you drag, a Fixed pin is one you do not, and both are the
 * same thing to the solver. That is stated rather than faked — `mode` records
 * which a pin is, and a Fixed pin refuses to be dragged.
 */

type PinMode = "position" | "fixed";

interface Pin {
  readonly vertex: number;
  readonly at: { x: number; y: number };
  readonly mode: PinMode;
  /** Photoshop's third kind. A pin with an angle turns the artwork around itself; without one
   * it only holds the artwork down, which is all a Position or Fixed pin ever does. Kept on
   * every pin rather than making rotation a fourth mode, because that is what it is in
   * Photoshop too: any pin can be given a rotation. */
  readonly rotation?: number;
}

/** A rotation drag in progress: which pin is being turned, and from where. */
interface Rotating { readonly pin: number; readonly startAngle: number; readonly startRotation: number }

export interface PuppetWarpState {
  /** Built the first time the tool is used on a layer, from that layer's own
   * opaque extent — a mesh over the whole canvas would spend its triangles on
   * emptiness. */
  readonly session: {
    readonly layerId: string;
    readonly mesh: PuppetMesh;
    readonly basePixels: Uint8ClampedArray;
    readonly bounds: RasterRect;
  } | null;
  readonly pins: readonly Pin[];
  readonly draggingPin: number | null;
  readonly rotating: Rotating | null;
  /** The deformed vertices, kept so the overlay draws the mesh the user sees
   * rather than the one it started from. */
  readonly deformed: readonly { x: number; y: number }[] | null;
}

const empty: PuppetWarpState = { session: null, pins: [], draggingPin: null, rotating: null, deformed: null };

/** The rotation ring's drawn radius, in screen pixels. */
const ROTATE_RING_SCREEN = 18;

/** How far from a pin an Alt-press still grabs that pin's ring. A little wider than the ring
 * is drawn, because a ring is aimed at rather than hit exactly — but not much wider, or Alt
 * near a pin would stop being able to place a pin at all. */
const ROTATE_GRAB_SCREEN = ROTATE_RING_SCREEN * 1.7;

/** How close a click has to land, in document units, to grab a pin rather than
 * place a new one. Scaled by the zoom at the call site so it is a screen
 * distance, the way every other grab radius in this project is. */
const PIN_GRAB_SCREEN = 12;

const solverPins = (pins: readonly Pin[]): PuppetPin[] => pins.map((pin) => ({
  vertex: pin.vertex, at: pin.at, ...(pin.rotation ? { rotation: pin.rotation } : {}),
}));

function beginSession(context: ToolContext<PuppetWarpState>): PuppetWarpState["session"] {
  const layer = context.activeLayer;
  if (!layer) return null;
  const pixels = context.layerPixels();
  const bounds = layerOpaqueBounds(pixels, context.document.width, context.document.height);
  if (!bounds || bounds.width < 2 || bounds.height < 2) return null;
  return { layerId: layer.id, mesh: puppetMesh(bounds, 8), basePixels: pixels, bounds };
}

/** Re-solves and previews. Called on every frame of a pin drag. */
function preview(context: ToolContext<PuppetWarpState>, state: PuppetWarpState): readonly { x: number; y: number }[] | null {
  const session = state.session;
  if (!session) return null;
  const deformed = solvePuppetMesh(session.mesh, solverPins(state.pins));
  const pixels = puppetWarpPixels(session.basePixels, context.document.width, context.document.height, session.mesh, deformed, null);
  context.schedulePreview(pixels, "pixels", session.layerId, null);
  return deformed;
}

function commit(context: ToolContext<PuppetWarpState>, state: PuppetWarpState): void {
  const session = state.session;
  if (!session || !state.pins.length) return;
  const deformed = solvePuppetMesh(session.mesh, solverPins(state.pins));
  const pixels = puppetWarpPixels(session.basePixels, context.document.width, context.document.height, session.mesh, deformed, null);
  const before = context.document;
  const after = structuredClone(before);
  const layer = after.layers.find((item) => item.id === session.layerId);
  if (!layer) return;
  // Through `setLayerPixels`, which is the one function that keeps a layer's
  // buffer and its bounds agreed — CLAUDE.md §2 records what writing
  // `layer.pixels` directly costs.
  setLayerPixels(layer, pixels, after.width, after.height);
  void context.commitDocument(before, after, "Puppet Warp (Марионеточная деформация)", null);
}

const puppetWarp: RasterToolDefinition<PuppetWarpState> = {
  id: "raster.puppetWarp",
  requiresRasterized: true,
  createState: () => empty,

  onPointerDown(context, pointer) {
    const state = context.state;
    const session = state.session ?? beginSession(context);
    if (!session) return;
    context.capturePointer(pointer.pointerId);

    const grab = PIN_GRAB_SCREEN / context.viewport.zoom;
    const existing = state.pins.findIndex((pin) => Math.hypot(pin.at.x - pointer.point.x, pin.at.y - pointer.point.y) <= grab);

    if (existing >= 0) {
      // Alt removes a pin, as it does in Photoshop; a Fixed pin is grabbed but
      // never moves, which is the whole of what makes it fixed.
      if (pointer.altKey) {
        const pins = state.pins.filter((_, index) => index !== existing);
        const next = { ...state, session, pins, draggingPin: null };
        context.setState({ ...next, deformed: preview(context, next) });
        return;
      }
      context.setState({ ...state, session, draggingPin: existing });
      return;
    }

    // Alt away from any pin, but near one, turns that pin instead of placing a new one —
    // Photoshop's own gesture: "press Alt, put the pointer near (not over) a pin, and a
    // circle appears; drag to rotate". Alt *over* a pin is the delete above, which is the
    // same key doing the same two things it does there.
    if (pointer.altKey) {
      const ring = ROTATE_GRAB_SCREEN / context.viewport.zoom;
      let nearest = -1, nearestDistance = Infinity;
      state.pins.forEach((pin, index) => {
        const distance = Math.hypot(pin.at.x - pointer.point.x, pin.at.y - pointer.point.y);
        if (distance <= ring && distance < nearestDistance) { nearest = index; nearestDistance = distance; }
      });
      if (nearest >= 0) {
        const pin = state.pins[nearest]!;
        const startAngle = Math.atan2(pointer.point.y - pin.at.y, pointer.point.x - pin.at.x);
        context.setState({ ...state, session, draggingPin: null, rotating: { pin: nearest, startAngle, startRotation: pin.rotation ?? 0 } });
        return;
      }
    }

    // A click on the artwork drops a pin at the mesh vertex nearest it. Holding
    // Shift makes it a Fixed pin — one that holds the picture down without ever
    // being dragged.
    const vertex = nearestVertex(session.mesh, pointer.point);
    if (state.pins.some((pin) => pin.vertex === vertex)) { context.setState({ ...state, session }); return; }
    const pins = [...state.pins, { vertex, at: session.mesh.vertices[vertex]!, mode: pointer.shiftKey ? "fixed" as const : "position" as const }];
    const next = { ...state, session, pins, draggingPin: null };
    context.setState({ ...next, deformed: preview(context, next) });
  },

  onPointerMove(context, pointer) {
    const state = context.state;
    if (state.rotating && state.session) {
      const pin = state.pins[state.rotating.pin];
      if (!pin) return;
      const angle = Math.atan2(pointer.point.y - pin.at.y, pointer.point.x - pin.at.x);
      const rotation = state.rotating.startRotation + (angle - state.rotating.startAngle);
      const pins = state.pins.map((item, index) => index === state.rotating!.pin ? { ...item, rotation } : item);
      const next = { ...state, pins };
      context.setState({ ...next, deformed: preview(context, next) });
      return;
    }
    if (state.draggingPin === null || !state.session) return;
    const pin = state.pins[state.draggingPin];
    if (!pin || pin.mode === "fixed") return;
    const pins = state.pins.map((item, index) => index === state.draggingPin ? { ...item, at: pointer.point } : item);
    const next = { ...state, pins };
    // Solved and previewed synchronously, not through `scheduleWork`. Deferring
    // it to the next frame put the release ahead of the work: `onGestureEnd`
    // wrote its own state from the snapshot it had, and the deferred frame
    // either lost the drag or was undone by it — measured live, the pin simply
    // did not move. The solve is a 162-unknown Cholesky, about a millisecond,
    // so there is nothing here worth deferring for.
    context.setState({ ...next, deformed: preview(context, next) });
  },

  onGestureEnd(context) {
    if (context.state.draggingPin === null && !context.state.rotating) return;
    context.setState({ ...context.state, draggingPin: null, rotating: null });
  },

  onDeactivate(context) {
    // Putting the tool down applies the work, the same contract the Move tool's
    // pending transform has: leaving a session open would strand it.
    const state = context.state;
    if (state.session && state.pins.length) commit(context, state);
    context.setState(empty);
  },

  Overlay({ state, context }) {
    const session = state.session;
    if (!session) return null;
    const zoom = context.viewport.zoom;
    const vertices = state.deformed ?? session.mesh.vertices;
    const lines: string[] = [];
    for (let t = 0; t < session.mesh.triangles.length; t += 3) {
      const a = vertices[session.mesh.triangles[t]!]!, b = vertices[session.mesh.triangles[t + 1]!]!, c = vertices[session.mesh.triangles[t + 2]!]!;
      lines.push(`M${a.x} ${a.y}L${b.x} ${b.y}L${c.x} ${c.y}Z`);
    }
    // Screen measurements divided by the zoom, the rule this project enforces
    // with a test (zoom-invariant-ui.test.ts).
    return <svg className="puppet-overlay" viewBox={`0 0 ${context.document.width} ${context.document.height}`} preserveAspectRatio="none" aria-hidden="true">
      <path className="puppet-mesh" d={lines.join("")} strokeWidth={0.6 / zoom}/>
      {state.pins.map((pin, index) => {
        // A pin carrying an angle wears its ring, so a rotation is visible as a state of the
        // pin and not only as its effect on the artwork — the same reason Photoshop leaves the
        // ring drawn on a rotated pin. The tick marks which way the pin faces now.
        const ring = pin.rotation || state.rotating?.pin === index
          ? <g className="puppet-pin-ring" key={`ring-${index}`}>
              <circle cx={pin.at.x} cy={pin.at.y} r={ROTATE_RING_SCREEN / zoom} strokeWidth={1 / zoom} strokeDasharray={`${3 / zoom} ${3 / zoom}`}/>
              <line x1={pin.at.x} y1={pin.at.y}
                x2={pin.at.x + Math.cos(pin.rotation ?? 0) * (ROTATE_RING_SCREEN / zoom)}
                y2={pin.at.y + Math.sin(pin.rotation ?? 0) * (ROTATE_RING_SCREEN / zoom)} strokeWidth={1.5 / zoom}/>
            </g>
          : null;
        return <g key={index}>
          {ring}
          <circle className={pin.mode === "fixed" ? "puppet-pin fixed" : "puppet-pin"}
            cx={pin.at.x} cy={pin.at.y} r={5 / zoom} strokeWidth={1.5 / zoom}/>
        </g>;
      })}
    </svg>;
  },

  ScreenOverlay({ state, context }) {
    // Enter applies, Escape throws the session away — the same two keys the
    // Move tool's transform answers to, owned by the tool that opened the
    // session rather than by a global listener.
    const session = state.session;
    useEffect(() => {
      if (!session) return;
      const onKeyDown = (event: KeyboardEvent) => {
        const target = event.target as HTMLElement | null;
        if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable) return;
        if (event.key === "Enter") {
          event.preventDefault();
          commit(context, state);
          context.setState(empty);
        } else if (event.key === "Escape") {
          event.preventDefault();
          context.setState(empty);
          // Nothing has reached the document, but the canvas is still showing
          // the last previewed frame; a cancel has to put it back itself
          // (the contract note in CLAUDE.md §2).
          context.previewWithLayerHidden(null);
        }
      };
      window.addEventListener("keydown", onKeyDown);
      return () => window.removeEventListener("keydown", onKeyDown);
    }, [session, state, context]);
    return null;
  },
};

export default puppetWarp;
