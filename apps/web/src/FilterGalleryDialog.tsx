import { useEffect, useMemo, useRef, useState } from "react";
import { rasterFilterCatalog, type RasterFilterDefinition, type RasterLayer } from "@vravio/env-raster";

const THUMBNAIL_EDGE = 48;

function downsampleThumbnail(pixels: Uint8ClampedArray, width: number, height: number, maxEdge: number): { pixels: Uint8ClampedArray; width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const outWidth = Math.max(1, Math.round(width * scale)), outHeight = Math.max(1, Math.round(height * scale));
  const output = new Uint8ClampedArray(outWidth * outHeight * 4);
  for (let y = 0; y < outHeight; y += 1) for (let x = 0; x < outWidth; x += 1) {
    const sourceX = Math.min(width - 1, Math.floor(x / scale)), sourceY = Math.min(height - 1, Math.floor(y / scale));
    const from = (sourceY * width + sourceX) * 4, to = (y * outWidth + x) * 4;
    output[to] = pixels[from]!; output[to + 1] = pixels[from + 1]!; output[to + 2] = pixels[from + 2]!; output[to + 3] = pixels[from + 3]!;
  }
  return { pixels: output, width: outWidth, height: outHeight };
}

function pixelsToDataUrl(pixels: Uint8ClampedArray, width: number, height: number): string {
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#3a3f47"; context.fillRect(0, 0, width, height);
  const layer = document.createElement("canvas");
  layer.width = width; layer.height = height;
  layer.getContext("2d")!.putImageData(new ImageData(pixels as Uint8ClampedArray<ArrayBuffer>, width, height), 0, 0);
  context.drawImage(layer, 0, 0);
  return canvas.toDataURL();
}

export function FilterGalleryDialog({ layer, onApply, onClose }: { layer: RasterLayer; onApply(pixels: Uint8ClampedArray, label: string): void; onClose(): void }) {
  const [filterId,setFilterId]=useState("gaussian_blur"), [settings,setSettings]=useState<Record<string,number>>({});
  const [rendered, setRendered] = useState<Uint8ClampedArray | null>(null);
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [isRendering, setIsRendering] = useState(true);
  const [renderError, setRenderError] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const canvasRef=useRef<HTMLCanvasElement>(null), filter=rasterFilterCatalog.find((item)=>item.id===filterId)!;
  const categories=useMemo(()=>[...new Set(rasterFilterCatalog.map((item)=>item.category))],[]);
  const effectiveSettings = useMemo(
    () => Object.fromEntries(filter.parameters.map((parameter) => [parameter.id, settings[parameter.id] ?? parameter.value])),
    [filter, settings],
  );
  useEffect(() => {
    const requestId = ++requestIdRef.current;
    const worker = new Worker(new URL("./filter-worker.ts", import.meta.url), { type: "module" });
    const timer = window.setTimeout(() => {
      setIsRendering(true);
      setRenderError(null);
      const pixels = layer.pixels.slice();
      worker.postMessage({ type: "render", requestId, pixels: pixels.buffer, width: layer.width, height: layer.height, filterId, settings: effectiveSettings }, [pixels.buffer]);
    }, 70);
    worker.onmessage = (event: MessageEvent<{ type: string; requestId: number; pixels?: ArrayBuffer; message?: string }>) => {
      if (event.data.requestId !== requestId) return;
      if (event.data.type === "error") {
        setRenderError(event.data.message ?? "Filter calculation failed");
        setIsRendering(false);
        return;
      }
      if (event.data.type === "rendered" && event.data.pixels) {
        setRendered(new Uint8ClampedArray(event.data.pixels));
        setIsRendering(false);
      }
    };
    worker.onerror = (event) => { setRenderError(event.message); setIsRendering(false); };
    return () => { window.clearTimeout(timer); worker.terminate(); };
  }, [layer.pixels, layer.width, layer.height, filterId, effectiveSettings]);
  useEffect(()=>{const canvas=canvasRef.current,context=canvas?.getContext("2d");if(canvas&&context&&rendered)context.putImageData(new ImageData(rendered as Uint8ClampedArray<ArrayBuffer>,layer.width,layer.height),0,0);},[rendered,layer.width,layer.height]);
  const select=(next:RasterFilterDefinition)=>{setFilterId(next.id);setSettings(Object.fromEntries(next.parameters.map((parameter)=>[parameter.id,parameter.value])));};
  const sample = useMemo(() => downsampleThumbnail(layer.pixels, layer.width, layer.height, THUMBNAIL_EDGE), [layer.pixels, layer.width, layer.height]);
  useEffect(() => {
    const requestId = ++requestIdRef.current;
    const worker = new Worker(new URL("./filter-worker.ts", import.meta.url), { type: "module" });
    const pixels = sample.pixels.slice();
    worker.postMessage({ type: "thumbnails", requestId, pixels: pixels.buffer, width: sample.width, height: sample.height, filters: rasterFilterCatalog }, [pixels.buffer]);
    worker.onmessage = (event: MessageEvent<{ type: string; requestId: number; results?: Array<{ filterId: string; pixels: ArrayBuffer }> }>) => {
      if (event.data.requestId !== requestId || event.data.type !== "thumbnails-rendered" || !event.data.results) return;
      setThumbnails(Object.fromEntries(event.data.results.map((item) => [item.filterId, pixelsToDataUrl(new Uint8ClampedArray(item.pixels), sample.width, sample.height)])));
    };
    return () => worker.terminate();
  }, [sample]);
  return <div className="dialog-backdrop filter-gallery-backdrop" onMouseDown={onClose}><section className="filter-gallery-dialog" role="dialog" aria-modal="true" aria-label="Filter Gallery (Галерея фильтров)" onMouseDown={(event)=>event.stopPropagation()}><header><strong>Filter Gallery (Галерея фильтров)</strong><button onClick={onClose}>×</button></header><div className="filter-gallery-body"><aside className="filter-browser">{categories.map((category)=><section key={category}><h3>{category}</h3>{rasterFilterCatalog.filter((item)=>item.category===category).map((item)=><button className={item.id===filterId?"active":""} key={item.id} onClick={()=>select(item)}><span className="filter-tile-preview">{thumbnails[item.id]?<img src={thumbnails[item.id]} alt="" width={30} height={24}/>:<span aria-hidden="true">…</span>}</span><span>{item.name}</span></button>)}</section>)}</aside><main className="filter-preview"><div className={isRendering?"is-rendering":""}><canvas ref={canvasRef} width={layer.width} height={layer.height}/>{isRendering&&<span className="filter-rendering-status">Rendering… (Расчёт…)</span>}{renderError&&<span className="filter-render-error">{renderError}</span>}</div><small>100% · {layer.width} × {layer.height}</small></main><aside className="filter-settings"><h2>{filter.name}</h2>{filter.parameters.length?filter.parameters.map((parameter)=>{const current=settings[parameter.id]??parameter.value;return <label key={parameter.id}>{parameter.name}<input type="range" min={parameter.min} max={parameter.max} step={parameter.step} value={current} onChange={(event)=>setSettings((values)=>({...values,[parameter.id]:event.target.valueAsNumber}))}/><output>{current}</output></label>}):<p>No parameters (Нет параметров)</p>}</aside></div><footer><button onClick={onClose}>Cancel (Отмена)</button><button className="primary" disabled={!rendered||isRendering||Boolean(renderError)} onClick={()=>{if(rendered){onApply(rendered,filter.name);onClose();}}}>OK</button></footer></section></div>;
}
