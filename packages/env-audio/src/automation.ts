/**
 * Automation curves — the "Automation" third of Tracktion Engine's own `Edit -> Track ->
 * Clip/Plugins/Automation` model (the architecture donor named at the top of docs/master-plan.md
 * §9.2). The math here is deliberately parameter-agnostic (a curve is just `{time, value}`
 * points over one number) — what a curve is attached to is `AudioTrack.volumeAutomation` (one
 * fixed parameter, the first caller this ever had) or `AudioTrack.effectAutomation` (an
 * arbitrary effect instance's own parameter, generalized once a real caller for it existed —
 * `audio-commands.ts`'s `setEffectParamAutomationPoint`/`AudioWorkspace.tsx`'s automation lane
 * UI — rather than built speculatively ahead of one, CLAUDE.md section 3).
 */
import type { AutomationPoint } from "./types";

/**
 * Linear-interpolates the automation curve at `timeSample`. Before the first point or after
 * the last, the curve holds at that endpoint's value rather than extrapolating — the standard
 * automation-lane convention (Tracktion, Ableton, Logic all hold at the edges) since a curve
 * extrapolated past its own data is guessing, not automating.
 *
 * Falls back to `staticVolume` when `points` is empty — an automation lane replaces the fader
 * only where it has data; a track with no automation at all behaves exactly as it did before
 * this feature existed.
 */
export function volumeAt(points: readonly AutomationPoint[], timeSample: number, staticVolume: number): number {
  if (points.length === 0) return staticVolume;
  if (points.length === 1 || timeSample <= points[0]!.time) return points[0]!.value;
  const last = points[points.length - 1]!;
  if (timeSample >= last.time) return last.value;

  for (let i = 1; i < points.length; i += 1) {
    const point = points[i]!;
    if (timeSample > point.time) continue;
    const previous = points[i - 1]!;
    const span = point.time - previous.time;
    const t = span > 0 ? (timeSample - previous.time) / span : 0;
    return previous.value + (point.value - previous.value) * t;
  }
  return last.value;
}

/** Inserts or replaces the point at `time` (an existing point at that exact time is replaced,
 * not duplicated), keeping the array sorted — every write to `volumeAutomation` goes through
 * this so a reader (`volumeAt`, `audioPlayback.ts`'s ramp scheduler) never has to sort. */
export function setAutomationPoint(points: readonly AutomationPoint[], time: number, value: number, id: string): AutomationPoint[] {
  const filtered = points.filter((point) => point.time !== time);
  const next = [...filtered, { id, time: Math.max(0, Math.floor(time)), value }];
  next.sort((a, b) => a.time - b.time);
  return next;
}

export function removeAutomationPoint(points: readonly AutomationPoint[], id: string): AutomationPoint[] {
  return points.filter((point) => point.id !== id);
}
