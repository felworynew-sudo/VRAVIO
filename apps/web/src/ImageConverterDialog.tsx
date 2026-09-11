import { useCallback, useRef, useState } from "react";
import { text } from "./i18n";
import type { Language } from "./store";

/**
 * Any format to any. Common formats (PNG/JPG/WebP/BMP) decode/encode instantly through
 * `<canvas>`; everything else (TIFF, AVIF, JXL, PSD, TGA, PNM, DDS, HDR, EXR and dozens more)
 * goes through ImageMagick-wasm (`./utils/magick.ts`), loaded lazily and only when a file or
 * output format the canvas path can't handle actually shows up. Everything stays local — files
 * never leave the browser.
 */

interface ConverterFormat {
  readonly id: string;
  readonly label: string;
  readonly ext: string;
  /** A browser-native `canvas.toBlob` MIME, when one exists. */
  readonly native?: string;
  /** The `ImageMagick.MagickFormat` key for everything the canvas can't encode. */
  readonly magick: string;
  readonly lossy?: boolean;
  readonly noAlpha?: boolean;
  readonly group: "common" | "pro";
}

const FORMATS: readonly ConverterFormat[] = [
  { id: "png", label: "PNG", ext: "png", native: "image/png", magick: "Png", group: "common" },
  { id: "jpg", label: "JPG", ext: "jpg", native: "image/jpeg", magick: "Jpeg", lossy: true, noAlpha: true, group: "common" },
  { id: "webp", label: "WebP", ext: "webp", native: "image/webp", magick: "WebP", lossy: true, group: "common" },
  { id: "avif", label: "AVIF", ext: "avif", magick: "Avif", lossy: true, group: "common" },
  { id: "gif", label: "GIF", ext: "gif", magick: "Gif", group: "common" },
  { id: "bmp", label: "BMP", ext: "bmp", native: "bmp", magick: "Bmp", noAlpha: true, group: "common" },
  { id: "tiff", label: "TIFF", ext: "tiff", magick: "Tiff", group: "common" },
  { id: "ico", label: "ICO", ext: "ico", magick: "Ico", group: "common" },
  { id: "jxl", label: "JPEG XL", ext: "jxl", magick: "Jxl", lossy: true, group: "pro" },
  { id: "jp2", label: "JPEG 2000", ext: "jp2", magick: "Jp2", lossy: true, group: "pro" },
  { id: "psd", label: "PSD (Photoshop)", ext: "psd", magick: "Psd", group: "pro" },
  { id: "tga", label: "TGA", ext: "tga", magick: "Tga", group: "pro" },
  { id: "dds", label: "DDS", ext: "dds", magick: "Dds", group: "pro" },
  { id: "hdr", label: "HDR (Radiance)", ext: "hdr", magick: "Hdr", group: "pro" },
  { id: "exr", label: "OpenEXR", ext: "exr", magick: "Exr", group: "pro" },
  { id: "pnm", label: "PNM", ext: "pnm", magick: "Pnm", group: "pro" },
  { id: "ppm", label: "PPM", ext: "ppm", magick: "Ppm", group: "pro" },
  { id: "pgm", label: "PGM", ext: "pgm", magick: "Pgm", group: "pro" },
  { id: "pbm", label: "PBM", ext: "pbm", magick: "Pbm", group: "pro" },
  { id: "pcx", label: "PCX", ext: "pcx", magick: "Pcx", group: "pro" },
  { id: "sgi", label: "SGI", ext: "sgi", magick: "Sgi", group: "pro" },
  { id: "xbm", label: "XBM", ext: "xbm", magick: "Xbm", group: "pro" },
  { id: "xpm", label: "XPM", ext: "xpm", magick: "Xpm", group: "pro" },
  { id: "wbmp", label: "WBMP", ext: "wbmp", magick: "Wbmp", group: "pro" },
  { id: "pict", label: "PICT", ext: "pict", magick: "Pict", group: "pro" },
  { id: "fits", label: "FITS", ext: "fts", magick: "Fits", group: "pro" },
  { id: "pfm", label: "PFM", ext: "pfm", magick: "Pfm", group: "pro" },
];

const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", webp: "image/webp", avif: "image/avif",
  gif: "image/gif", bmp: "image/bmp", tiff: "image/tiff", ico: "image/x-icon",
  jxl: "image/jxl", jp2: "image/jp2",
};
/** Input-format hint for containers ImageMagick can't sniff from magic bytes alone. */
const EXT2MAGICK: Record<string, string> = {
  tga: "Tga", tif: "Tiff", tiff: "Tiff", psd: "Psd", dds: "Dds", exr: "Exr", hdr: "Hdr",
  jp2: "Jp2", jxl: "Jxl", avif: "Avif", pcx: "Pcx", ppm: "Ppm", pgm: "Pgm", pbm: "Pbm",
  pnm: "Pnm", pam: "Pam", sgi: "Sgi", xbm: "Xbm", xpm: "Xpm", wbmp: "Wbmp", pict: "Pict",
  fts: "Fits", fits: "Fits", pfm: "Pfm", png: "Png", jpg: "Jpeg", jpeg: "Jpeg", jfif: "Jpeg",
  jpe: "Jpeg", webp: "WebP", gif: "Gif", bmp: "Bmp", ico: "Ico", heic: "Heic", heif: "Heic", pcd: "Pcd",
};
const NATIVE_IN = /\.(png|jpe?g|jfif|jpe|webp|gif|bmp|avif|ico)$/i;
const ACCEPT = "image/*,.heic,.heif,.tif,.tiff,.tga,.psd,.dds,.exr,.hdr,.jp2,.jxl,.avif,.pcx,.ppm,.pgm,.pbm,.pnm,.pam,.sgi,.xbm,.xpm,.wbmp,.ico,.pict,.fts,.fits,.pfm,.pcd";
const KNOWN_EXT = /\.(png|jpe?g|jfif|jpe|webp|gif|bmp|avif|ico|heic|heif|tiff?|tga|psd|dds|exr|hdr|jp2|jxl|pcx|ppm|pgm|pbm|pnm|pam|sgi|xbm|xpm|wbmp|pict|fts|fits|pfm|pcd)$/i;

function encodeBMP(imageData: ImageData): Blob {
  const { width, height, data } = imageData;
  const rowSize = Math.floor((24 * width + 31) / 32) * 4;
  const pixelArraySize = rowSize * height;
  const fileSize = 54 + pixelArraySize;
  const buffer = new ArrayBuffer(fileSize);
  const view = new DataView(buffer);
  view.setUint16(0, 0x4d42, false); view.setUint32(2, fileSize, true); view.setUint32(10, 54, true);
  view.setUint32(14, 40, true); view.setInt32(18, width, true); view.setInt32(22, height, true);
  view.setUint16(26, 1, true); view.setUint16(28, 24, true); view.setUint32(34, pixelArraySize, true);
  for (let y = 0; y < height; y += 1) {
    let p = 54 + (height - 1 - y) * rowSize;
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      view.setUint8(p, data[i + 2]!); p += 1; view.setUint8(p, data[i + 1]!); p += 1; view.setUint8(p, data[i]!); p += 1;
    }
  }
  return new Blob([buffer], { type: "image/bmp" });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function loadImage(file: File): Promise<{ img: HTMLImageElement; revoke(): void }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, revoke: () => URL.revokeObjectURL(url) });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("load-error")); };
    img.src = url;
  });
}

interface ConverterItem {
  readonly id: string;
  readonly file: File;
  readonly name: string;
  readonly inSize: number;
  outUrl: string;
  outSize: number;
  outName: string;
  status: "idle" | "done" | "error";
}

/**
 * Under Tauri, `<a download>` is a web fiction — there is a real filesystem right there, so the
 * desktop build trades per-file downloads for the shape a native tool actually has: pick a
 * source folder, pick a destination, convert everything between them. The browser build (GitHub
 * Pages) has no filesystem access at all, so it keeps the drop-files-and-download flow below.
 */
const isDesktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function ImageConverterDialog({ language, onClose }: { language: Language; onClose(): void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<ConverterItem[]>([]);
  const [format, setFormat] = useState("webp");
  const [quality, setQuality] = useState(0.9);
  const [jpgBg, setJpgBg] = useState("#ffffff");
  const [busy, setBusy] = useState(false);
  const [engineLoading, setEngineLoading] = useState(false);
  const [sourceDir, setSourceDir] = useState<string | null>(null);
  const [outputDir, setOutputDir] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);

  const activeFormat = FORMATS.find((candidate) => candidate.id === format) ?? FORMATS[0]!;

  const pickSourceFolder = async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ directory: true });
    if (typeof picked !== "string") return;
    setSourceDir(picked);
    setScanError(null);
    try {
      const { readDir, readFile } = await import("@tauri-apps/plugin-fs");
      const { join } = await import("@tauri-apps/api/path");
      const entries = await readDir(picked);
      const imageEntries = entries.filter((entry) => !entry.isDirectory && KNOWN_EXT.test(entry.name));
      const scanned = await Promise.all(imageEntries.map(async (entry, index): Promise<ConverterItem> => {
        const bytes = await readFile(await join(picked, entry.name));
        return { id: `${Date.now()}-${index}-${entry.name}`, file: new File([bytes.buffer as ArrayBuffer], entry.name), name: entry.name, inSize: bytes.byteLength, outUrl: "", outSize: 0, outName: "", status: "idle" };
      }));
      setItems(scanned);
    } catch (cause) {
      setScanError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const pickOutputFolder = async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ directory: true });
    if (typeof picked === "string") setOutputDir(picked);
  };

  const addFiles = useCallback((fileList: FileList | null) => {
    const files = Array.from(fileList ?? []).filter((file) => file.type.startsWith("image/") || KNOWN_EXT.test(file.name));
    if (files.length === 0) return;
    setItems((previous) => [
      ...previous,
      ...files.map((file, index): ConverterItem => ({
        id: `${Date.now()}-${index}-${file.name}`, file, name: file.name,
        inSize: file.size, outUrl: "", outSize: 0, outName: "", status: "idle",
      })),
    ]);
  }, []);

  async function canvasConvert(item: ConverterItem, target: ConverterFormat) {
    const { img, revoke } = await loadImage(item.file);
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    const context = canvas.getContext("2d")!;
    if (target.noAlpha) { context.fillStyle = jpgBg; context.fillRect(0, 0, canvas.width, canvas.height); }
    context.drawImage(img, 0, 0);
    revoke();
    const blob = target.native === "bmp"
      ? encodeBMP(context.getImageData(0, 0, canvas.width, canvas.height))
      : await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, target.native, target.lossy ? quality : undefined));
    if (!blob) throw new Error("encode-error");
    const base = item.name.replace(/\.[^.]+$/, "");
    return { outUrl: URL.createObjectURL(blob), outSize: blob.size, outName: `${base}.${target.ext}` };
  }

  async function magickConvertItem(item: ConverterItem, target: ConverterFormat) {
    setEngineLoading(true);
    try {
      const { magickConvert } = await import("./utils/magick");
      const bytes = new Uint8Array(await item.file.arrayBuffer());
      const ext = (item.file.name.split(".").pop() ?? "").toLowerCase();
      const out = await magickConvert(bytes, target.magick, target.lossy ? Math.round(quality * 100) : undefined, EXT2MAGICK[ext] ?? null);
      const blob = new Blob([out.buffer as ArrayBuffer], { type: MIME[target.ext] ?? "application/octet-stream" });
      const base = item.name.replace(/\.[^.]+$/, "");
      return { outUrl: URL.createObjectURL(blob), outSize: blob.size, outName: `${base}.${target.ext}` };
    } finally {
      setEngineLoading(false);
    }
  }

  async function convertOne(item: ConverterItem) {
    const target = activeFormat;
    let work = item;
    // iPhone HEIC/HEIF: neither the browser nor the ImageMagick build here decode it — unwrap to
    // PNG first via libheif (heic-to), then the normal path handles the rest.
    const ext = (item.name.split(".").pop() ?? "").toLowerCase();
    if (ext === "heic" || ext === "heif" || /heic|heif/.test(item.file.type)) {
      setEngineLoading(true);
      try {
        const { heicTo } = await import("heic-to/csp");
        const png = await heicTo({ blob: item.file, type: "image/png" });
        work = { ...item, file: new File([png], `${item.name}.png`, { type: "image/png" }) };
      } finally {
        setEngineLoading(false);
      }
    }
    const file = work.file;
    const inNative = NATIVE_IN.test(file.name) || /(png|jpeg|webp|gif|bmp|avif|icon)/.test(file.type);
    if (target.native && inNative) {
      try { return await canvasConvert(work, target); } catch { /* fall through to ImageMagick */ }
    }
    return magickConvertItem(work, target);
  }

  async function handleConvertAll() {
    setBusy(true);
    for (const item of items) {
      try {
        const result = await convertOne(item);
        if (outputDir) {
          const { writeFile } = await import("@tauri-apps/plugin-fs");
          const { join } = await import("@tauri-apps/api/path");
          const bytes = new Uint8Array(await (await fetch(result.outUrl)).arrayBuffer());
          await writeFile(await join(outputDir, result.outName), bytes);
        }
        setItems((previous) => previous.map((candidate) => candidate.id === item.id ? { ...candidate, ...result, status: "done" as const } : candidate));
      } catch {
        setItems((previous) => previous.map((candidate) => candidate.id === item.id ? { ...candidate, status: "error" as const } : candidate));
      }
    }
    setBusy(false);
  }

  function downloadItem(item: ConverterItem) {
    if (!item.outUrl) return;
    const a = document.createElement("a");
    a.href = item.outUrl; a.download = item.outName;
    document.body.appendChild(a); a.click(); a.remove();
  }
  function downloadAll() { items.filter((item) => item.outUrl).forEach((item, index) => setTimeout(() => downloadItem(item), index * 250)); }
  function clearAll() { items.forEach((item) => item.outUrl && URL.revokeObjectURL(item.outUrl)); setItems([]); }

  const doneCount = items.filter((item) => item.status === "done").length;
  const common = FORMATS.filter((candidate) => candidate.group === "common");
  const pro = FORMATS.filter((candidate) => candidate.group === "pro");

  return <div className="dialog-backdrop" onMouseDown={onClose}>
    <section className="export-dialog converter-dialog" role="dialog" aria-modal="true" aria-labelledby="converter-title" onMouseDown={(event) => event.stopPropagation()}>
      <header>
        <div><small>{text(language, "CONVERT IMAGES", "КОНВЕРТЕР ИЗОБРАЖЕНИЙ")}</small><h2 id="converter-title">{text(language, "Convert images", "Конвертировать изображения")}</h2></div>
        <button onClick={onClose} aria-label={text(language, "Close", "Закрыть")}>×</button>
      </header>

      <div className="converter-body">
        <div className="converter-controls">
          <label className="export-field">
            <span>{text(language, "Format", "Формат")}</span>
            <select value={format} onChange={(event) => setFormat(event.target.value)}>
              <optgroup label={text(language, "Common", "Обычные")}>
                {common.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}
              </optgroup>
              <optgroup label={text(language, "Professional & rare", "Профессиональные и редкие")}>
                {pro.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}
              </optgroup>
            </select>
          </label>

          {activeFormat.lossy && <label className="export-field export-slider">
            <span>{text(language, "Quality", "Качество")}</span>
            <input type="range" min={10} max={100} value={Math.round(quality * 100)} onChange={(event) => setQuality(event.target.valueAsNumber / 100)} />
            <output>{Math.round(quality * 100)}</output>
          </label>}

          {activeFormat.noAlpha && <label className="export-field">
            <span>{text(language, "Background", "Фон")}</span>
            <input type="color" value={jpgBg} onChange={(event) => setJpgBg(event.target.value)} />
          </label>}
        </div>

        {isDesktop && <div className="converter-folders">
          <button type="button" onClick={() => void pickSourceFolder()}>{text(language, "Source folder…", "Папка-источник…")}</button>
          <span className="converter-folder-path" title={sourceDir ?? undefined}>{sourceDir ?? text(language, "Not chosen", "Не выбрана")}</span>
          <button type="button" onClick={() => void pickOutputFolder()}>{text(language, "Destination folder…", "Папка назначения…")}</button>
          <span className="converter-folder-path" title={outputDir ?? undefined}>{outputDir ?? text(language, "Same as source files (download)", "Как у исходных файлов (скачивание)")}</span>
        </div>}
        {scanError && <p className="converter-scan-error" role="alert">{scanError}</p>}

        <button type="button" className="converter-dropzone"
          onClick={() => inputRef.current?.click()}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => { event.preventDefault(); addFiles(event.dataTransfer.files); }}>
          <span className="converter-dropzone-title">{text(language, "Drop images here or click to choose", "Перетащите картинки сюда или нажмите, чтобы выбрать")}</span>
          <span className="converter-dropzone-hint">{text(language, "Any format to any: PNG, JPG, WebP, AVIF, TIFF, GIF, BMP, ICO, PSD, TGA and dozens more. Even iPhone HEIC on input", "Любой формат в любой: PNG, JPG, WebP, AVIF, TIFF, GIF, BMP, ICO, PSD, TGA и десятки других. На входе — даже HEIC с айфона")}</span>
          <input ref={inputRef} type="file" accept={ACCEPT} multiple hidden onChange={(event) => { addFiles(event.target.files); event.target.value = ""; }} />
        </button>

        {items.length > 0 && <div className="converter-actions">
          <button type="button" className="converter-primary" disabled={busy} onClick={() => void handleConvertAll()}>
            {busy ? text(language, "Processing…", "Обработка…") : text(language, "Convert all", "Конвертировать всё")}
          </button>
          {doneCount > 0 && !outputDir && <button type="button" onClick={downloadAll}>{text(language, "Download all", "Скачать всё")} ({doneCount})</button>}
          <button type="button" disabled={busy} onClick={clearAll}>{text(language, "Clear", "Очистить")}</button>
        </div>}

        {engineLoading && <p className="converter-engine-note">{text(language, "Loading the format engine (one time)…", "Загрузка движка форматов (один раз)…")}</p>}

        <ul className="converter-list">
          {items.length === 0 && <li className="converter-empty">{text(language, "No files yet", "Пока нет файлов")}</li>}
          {items.map((item) => <li key={item.id} className={`converter-row converter-row-${item.status}`}>
            <span className="converter-name" title={item.name}>{item.name}</span>
            <span className="converter-sizes">
              {formatBytes(item.inSize)}
              {item.status === "done" && <>
                <span className="converter-arrow"> → </span>
                <strong>{formatBytes(item.outSize)}</strong>
                {item.inSize > 0 && <span className="converter-delta"> ({Math.round((1 - item.outSize / item.inSize) * 100)}%)</span>}
              </>}
            </span>
            {item.status === "done"
              ? outputDir ? <span className="converter-saved">{text(language, "Saved", "Сохранено")}</span> : <button type="button" onClick={() => downloadItem(item)}>{text(language, "Download", "Скачать")}</button>
              : item.status === "error" ? <span className="converter-error" aria-label={text(language, "Failed", "Ошибка")}>⚠</span> : <span className="converter-pending">•</span>}
          </li>)}
        </ul>

        <p className="converter-local-note">{text(language, "Files are processed right in your browser and never uploaded anywhere.", "Файлы обрабатываются прямо в вашем браузере и никуда не передаются.")}</p>
      </div>
    </section>
  </div>;
}
