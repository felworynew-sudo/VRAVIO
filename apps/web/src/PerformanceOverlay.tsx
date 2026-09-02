import { useEffect, useState } from "react";
import { kernel } from "./kernel";

interface PerformanceMetrics {
  fps: number;
  frameMs: number;
  heapMb: number | null;
  quotaMb: number | null;
  usageMb: number | null;
}

const mb = (bytes: number) => bytes / 1024 / 1024;

export function PerformanceOverlay({ documentId }: { documentId: string | null }) {
  const [metrics, setMetrics] = useState<PerformanceMetrics>({ fps: 0, frameMs: 0, heapMb: null, quotaMb: null, usageMb: null });

  useEffect(() => {
    let frame = 0, frameCount = 0, previous = performance.now(), lastSample = previous, disposed = false;
    const sampleStorage = async () => {
      try {
        const estimate = await navigator.storage?.estimate?.();
        if (!disposed) setMetrics((current) => ({ ...current, usageMb: estimate?.usage === undefined ? null : mb(estimate.usage), quotaMb: estimate?.quota === undefined ? null : mb(estimate.quota) }));
      } catch { /* Storage estimates are optional. */ }
    };
    const tick = (now: number) => {
      frameCount += 1;
      if (now - lastSample >= 500) {
        const elapsed = now - lastSample;
        const memory = performance as Performance & { memory?: { usedJSHeapSize: number } };
        setMetrics((current) => ({ ...current, fps: Math.round(frameCount * 1000 / elapsed), frameMs: (now - previous), heapMb: memory.memory ? mb(memory.memory.usedJSHeapSize) : null }));
        frameCount = 0; lastSample = now;
        void sampleStorage();
      }
      previous = now;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => { disposed = true; cancelAnimationFrame(frame); };
  }, []);

  const history = documentId ? kernel.historyByDocument.get(documentId) : null;
  return <aside className="performance-overlay" aria-label="Performance monitor">
    <b>{metrics.fps} FPS</b><span>{metrics.frameMs.toFixed(1)} ms</span>
    <span>{kernel.gpu.active ?? "detecting"}</span>
    <span>History {history ? mb(history.memoryBytes).toFixed(1) : "0.0"} MB</span>
    <span>Heap {metrics.heapMb === null ? "n/a" : `${metrics.heapMb.toFixed(0)} MB`}</span>
    <span>OPFS {metrics.usageMb === null ? "n/a" : `${metrics.usageMb.toFixed(0)} / ${metrics.quotaMb?.toFixed(0) ?? "?"} MB`}</span>
  </aside>;
}

