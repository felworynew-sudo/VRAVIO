import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { Filemanager, type FilePreview, type IApi, type IParsedEntity } from "@svar-ui/react-filemanager";
import "@svar-ui/react-filemanager/all.css";
import { kernel } from "../kernel";
import { environmentMeta } from "../environment";
import type { EnvironmentKind, VravioDocument } from "@vravio/kernel";
import type { Language } from "../store";
import { resolveLabel, text } from "../i18n";
import { browserFiles, createBridgeFileSystemProvider, type BridgeEntry } from "./filesystem";
import { bridgeIcon } from "./icons";

type Props = {
  language: Language;
  requestNewDocument(kind: EnvironmentKind): void;
  openFile(file: File): Promise<void>;
  /** Every document still open in this session — home only shows while none
   * of them is active, so this is genuinely "what did I leave open", not
   * "what did I ever touch." Passed in rather than read from the kernel
   * directly, matching `requestNewDocument`/`openFile`'s own shape: this
   * file stays a plain adapter with explicit inputs, not another place that
   * reaches into shell state on its own. */
  openDocuments: readonly VravioDocument[];
  onOpenDocument(id: string): void;
  openConverter(): void;
};

/**
 * VRAVIO's home is deliberately an adapter around the upstream SVAR file manager.
 * SVAR owns navigation, search, selection, keyboard behaviour and its presentation;
 * this component only maps its requests to the platform file port and maps an opened
 * file to the already-existing VRAVIO import pipeline.
 */
export function HomeScreen({ language, requestNewDocument, openFile, openDocuments, onOpenDocument, openConverter }: Props) {
  const providerRef = useRef(createBridgeFileSystemProvider());
  const [data, setData] = useState<BridgeEntry[]>([]);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [previewRevision, setPreviewRevision] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);

  const supply = useCallback(async (path?: string, api?: IApi) => {
    const provider = providerRef.current;
    setLoading(true);
    try {
      const entries = await provider.list(path);
      if (api && path) api.exec("provide-data", { id: path, data: entries });
      else setData(entries);
      void provider.preparePreviews(entries).then(() => setPreviewRevision((value) => value + 1));
      setMessage("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    void supply();
    return () => providerRef.current.dispose();
  }, [supply]);

  const init = useCallback((api: IApi) => {
    api.on("request-data", ({ id }: { id: string }) => { void supply(id, api); });
    api.on("open-file", ({ id }: { id: string }) => {
      void (async () => {
        const file = await providerRef.current.read(id);
        if (file) await openFile(file);
      })();
    });
  }, [openFile, supply]);

  const loadBrowserSelection = async (list: FileList | null) => {
    if (!list?.length) return;
    const provider = browserFiles(providerRef.current);
    if (!provider) return;
    provider.setFiles(list);
    await supply();
  };
  const environments = kernel.environments.kinds.filter((kind): kind is EnvironmentKind => kind in environmentMeta);

  return <section className="bridge-home" aria-label={text(language, "VRAVIO home", "Главная VRAVIO")}
    onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); setDraggingFiles(true); } }}
    onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDraggingFiles(false); }}
    onDrop={(event) => { event.preventDefault(); setDraggingFiles(false); void (async () => { for (const file of Array.from(event.dataTransfer.files)) await openFile(file); })(); }}>
    <aside className="bridge-sidebar">
      <button className="bridge-primary" onClick={() => requestNewDocument("raster")}><i className="bridge-action-icon" style={{ "--icon-mask": `url("${import.meta.env.BASE_URL}НОВЫЙ-ДОКУМЕНТ.svg")` } as CSSProperties}/>{text(language, "New document", "Новый документ")}</button>
      <div className="bridge-actions">
        <button onClick={() => fileRef.current?.click()}><i className="bridge-action-icon" style={{ "--icon-mask": `url("${import.meta.env.BASE_URL}ОТКРЫТЬ-ФАЙЛ.svg")` } as CSSProperties}/>{text(language, "Open files", "Открыть файлы")}</button>
        {providerRef.current.kind === "browser" && <button onClick={() => folderRef.current?.click()}><i className="bridge-action-icon" style={{ "--icon-mask": `url("${import.meta.env.BASE_URL}ОТКРЫТЬ-ПАПКУ.svg")` } as CSSProperties}/>{text(language, "Open folder", "Открыть папку")}</button>}
        <button onClick={openConverter}>{text(language, "Convert images…", "Конвертировать изображения…")}</button>
      </div>
      <h2>{text(language, "Workspaces", "Рабочие среды")}</h2>
      <div className="bridge-environments">
        {environments.map((kind) => <button key={kind} data-kind={kind} onClick={() => requestNewDocument(kind)}>
          <img src={`${import.meta.env.BASE_URL}${environmentMeta[kind].plaqueFile}`} alt="" />
          <span>{resolveLabel(environmentMeta[kind].label, language)}</span>
        </button>)}
      </div>
      <p className="bridge-source">{providerRef.current.kind === "desktop" ? text(language, "Computer files · read-only browsing", "Файлы компьютера · просмотр без изменений") : text(language, "Choose files or a folder to browse", "Выберите файлы или папку для просмотра")}</p>
    </aside>
    <div className="bridge-browser">
      <header><h1>{text(language, "Files and recent assets", "Файлы и материалы")}</h1><span className="bridge-status">{loading ? text(language, "Loading…", "Загрузка…") : text(language, "Open a file to create a document", "Откройте файл, чтобы создать документ")}</span></header>
      {openDocuments.length > 0 && <div className="bridge-open-strip" aria-label={text(language, "Open documents", "Открытые документы")}>
        {openDocuments.map((document) => {
          const meta = document.kind in environmentMeta ? environmentMeta[document.kind as EnvironmentKind] : null;
          return <button key={document.id} className="bridge-open-item" onClick={() => onOpenDocument(document.id)} title={document.name}>
            {meta && <img src={`${import.meta.env.BASE_URL}${meta.plaqueFile}`} alt=""/>}
            <span>{document.name}</span>
            {document.dirty && <i className="bridge-open-dirty" aria-label={text(language, "Unsaved changes", "Несохранённые изменения")}/>}
          </button>;
        })}
      </div>}
      {message && <p className="bridge-error" role="alert">{message}</p>}
      <div className="bridge-filemanager" data-preview-revision={previewRevision}>
        <Filemanager data={data} init={init} readonly preview icons={bridgeIcon} previews={(item: FilePreview) => item.id ? providerRef.current.preview(item.id) : null} extraInfo={(item: IParsedEntity) => providerRef.current.extraInfo(item.id)} />
      </div>
    </div>
    {draggingFiles && <div className="bridge-drop-target" role="status"><strong>{text(language, "Open in VRAVIO", "Открыть в VRAVIO")}</strong><span>{text(language, "Release to import the files into their matching workspace", "Отпустите, чтобы импортировать файлы в подходящую среду")}</span></div>}
    <input ref={fileRef} hidden type="file" multiple onChange={(event) => { void loadBrowserSelection(event.currentTarget.files); event.currentTarget.value = ""; }} />
    <input ref={folderRef} hidden type="file" multiple {...({ webkitdirectory: "", directory: "" } as Record<string, string>)} onChange={(event) => { void loadBrowserSelection(event.currentTarget.files); event.currentTarget.value = ""; }} />
  </section>;
}
