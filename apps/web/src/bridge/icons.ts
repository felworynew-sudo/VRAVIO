/**
 * File-type icons for Bridge, handed to `@svar-ui/react-filemanager`'s own
 * `icons` prop.
 *
 * That prop's contract (confirmed by reading the library's own bundled
 * source, `dist/index.es.js`, and its docs page for the prop) is a plain
 * image URL, not a CSS class — SVAR's own default resolver already covers a
 * fixed allow-list of common extensions (zip/css/html/js/md/xml/sql/mp3/
 * doc/txt/mp4/pdf/xls/png/psd/svg and a few more) by pointing at its own
 * CDN; anything outside that list falls back to a generic "unknown" glyph
 * regardless of what the file actually is. Returning `false` here for
 * anything SVAR's own list already recognizes lets its (perfectly fine)
 * built-in icon show — this only fills the gap for everything VRAVIO's own
 * users actually work with that SVAR has never heard of: `.vravio` itself,
 * RAW camera formats, and the wider raster/print formats the image
 * converter also targets (EXR, HDR, DDS, TGA, JXL, ICO, and so on).
 *
 * Real per-application-icon extraction from the OS (what Explorer shows for
 * an unregistered extension) has no cross-platform browser or Tauri API —
 * confirmed while researching this — so unknown types get a clean, flat
 * category badge instead of a fabricated file-specific icon, which is
 * honest about what it actually knows: "this is a picture", not "this is a
 * Photoshop file", when the format is one this build cannot even open.
 */

// SVAR's own coverage (`fe` in its bundled source) — do not shadow these
// with a lower-fidelity generic badge.
const SVAR_COVERED = new Set([
  "7z", "rar", "zip", "css", "html", "js", "php", "md", "xml", "sql",
  "aif", "mid", "mp3", "doc", "docx", "txt",
  "avi", "mov", "mp4", "mpeg", "mpg",
  "pdf", "xls", "xlsx",
  "gif", "jpg", "jpeg", "png", "psd", "tiff", "svg",
]);

type Category = "vravio" | "image" | "audio" | "video" | "raw" | "archive" | "code" | "font" | "generic";

const EXTENSION_CATEGORY: Record<string, Category> = {
  vravio: "vravio",
  // The wider image formats this project's own converter and Camera Raw
  // pipeline actually handle, beyond SVAR's own list above.
  avif: "image", bmp: "image", heic: "image", heif: "image", webp: "image", ico: "image",
  tif: "image", jxl: "image", jp2: "image", tga: "image", dds: "image", hdr: "image",
  exr: "image", pnm: "image", ppm: "image", pgm: "image", pbm: "image", pcx: "image",
  sgi: "image", xbm: "image", xpm: "image", wbmp: "image", pict: "image", fts: "image",
  fits: "image", pfm: "image",
  cr2: "raw", cr3: "raw", nef: "raw", arw: "raw", dng: "raw", orf: "raw", rw2: "raw", raf: "raw",
  wav: "audio", flac: "audio", ogg: "audio", m4a: "audio", aac: "audio",
  webm: "video", mkv: "video",
  gz: "archive", tar: "archive", "7zip": "archive",
  ts: "code", tsx: "code", jsx: "code", json: "code", py: "code", rs: "code", go: "code", c: "code", cpp: "code", java: "code",
  ttf: "font", otf: "font", woff: "font", woff2: "font",
};

const CATEGORY_ICON: Record<Category, string> = {
  // The app's own mark — a `.vravio` file is this app's native project, the
  // one type worth naming instead of categorizing.
  vravio: `${import.meta.env.BASE_URL}логотип цветная плашка.svg`,
  image: dataIcon("#2f8fd6", "M4 6h16v12H4z", "M7 15l3.2-4 2.4 3 1.9-2.6L18 15", "8", "8.4"),
  audio: dataIcon("#e0a13a", null, "M9 6v9.2a2.6 2.6 0 1 1-1.4-2.32V8h6V6z"),
  video: dataIcon("#d86161", "M3 6h13v12H3z", "M16 10.5l5-2.5v8l-5-2.5z"),
  raw: dataIcon("#78c995", "M4 6h16v12H4z", "M7 15l3.2-4 2.4 3 1.9-2.6L18 15", "8", "8.4", true),
  archive: dataIcon("#a98b5c", "M4 4h16v16H4z", "M11 4v16M9 7h4M9 10h4M9 13h4"),
  code: dataIcon("#5b9dd9", null, "M8 8l-4 4 4 4M16 8l4 4-4 4M13.5 6l-3 12"),
  font: dataIcon("#9b7bd6", null, "M6 17l4.5-11h1l4.5 11M8 13h6"),
  generic: dataIcon("#8a93a3", "M6 3h9l3 3v15H6z", "M15 3v3h3"),
};

/** A small flat "file card" glyph — a rounded page silhouette with a
 * coloured accent shape inside, drawn once here rather than traced from any
 * OS or donor icon set (this project's own rule against copying icon
 * assets it has no licence to repeat — see CLAUDE.md §1). `frame`, when
 * given, is the picture-frame outline; `mark`/`mark2` are the accent
 * strokes; `cornerX`/`cornerY` place a small circle (used for the RAW
 * badge's "R"-suggestive dot) only when supplied. */
function dataIcon(color: string, frame: string | null, mark: string, cornerX?: string, cornerY?: string, dashed = false): string {
  const page = `M5 2h9l5 5v15H5z`;
  const fold = `M14 2v5h5`;
  const frameShape = frame ? `<path d="${frame}" fill="none" stroke="${color}" stroke-width="1.3" ${dashed ? 'stroke-dasharray="2 1.4"' : ""}/>` : "";
  const corner = cornerX && cornerY ? `<circle cx="${cornerX}" cy="${cornerY}" r="1.1" fill="${color}"/>` : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">` +
    `<path d="${page}" fill="#242832" stroke="#3a4150" stroke-width="1"/>` +
    `<path d="${fold}" fill="none" stroke="#3a4150" stroke-width="1"/>` +
    frameShape +
    `<path d="${mark}" fill="none" stroke="${color}" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>` +
    corner +
    `</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/** Handed straight to `<Filemanager icons={...}>`. SVAR's own parsed entity
 * (`IParsedEntity` in `@svar-ui/filemanager-store`) already carries `.ext`
 * directly — no need to re-derive it from a filename. Returns `false` for
 * folders and anything SVAR's own built-in set already draws correctly, so
 * this only ever narrows what falls into the generic bucket — never
 * replaces an icon that was already right. */
export function bridgeIcon(entry: { type?: string; ext?: string }): string | false {
  if (entry.type !== "file") return false;
  const ext = (entry.ext ?? "").toLowerCase();
  if (SVAR_COVERED.has(ext)) return false;
  const category = EXTENSION_CATEGORY[ext];
  return CATEGORY_ICON[category ?? "generic"];
}
