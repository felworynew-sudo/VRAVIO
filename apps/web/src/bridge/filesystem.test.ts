import { describe, expect, it } from "vitest";
import { DataStore } from "@svar-ui/filemanager-store";
import { bridgeIdFor, browserFiles, createBridgeFileSystemProvider, type BridgeEntry } from "./filesystem";

/**
 * The file manager is upstream code, so the only honest test of "will it show our entries" is to
 * hand them to its own store and look.
 *
 * The desktop build shipped a Bridge with an empty "My files" and no error: `readDir` succeeded,
 * the entries were handed over, and the store dropped every one of them. It derives a parent from
 * the id string — `id.lastIndexOf("/")` — and a native Windows path has no `/` in it, so the
 * parent it computed named a node that does not exist. This is that, pinned down.
 */
function childrenOf(store: InstanceType<typeof DataStore>, id: string): string[] {
  const tree = (store.getState() as { data: { byId(id: string): { data?: { id: string }[] } | undefined } }).data;
  return (tree.byId(id)?.data ?? []).map((entry) => entry.id);
}

function storeWith(entries: readonly BridgeEntry[]): InstanceType<typeof DataStore> {
  const store = new DataStore();
  // A copy: the store takes ownership of the array it is handed and mutates the entries in place.
  store.init({ data: entries.map((entry) => ({ ...entry })) });
  return store;
}

describe("what the file manager makes of the entries Bridge hands it", () => {
  const listing = (parentId: string): BridgeEntry[] => [
    { id: bridgeIdFor(parentId, "Desktop"), value: "Desktop", type: "folder", lazy: true },
    { id: bridgeIdFor(parentId, "Documents"), value: "Documents", type: "folder", lazy: true },
    { id: bridgeIdFor(parentId, "portrait.png"), value: "portrait.png", type: "file", size: 2048 },
  ];

  it("puts a home listing under the root, where the user can see it", () => {
    expect(childrenOf(storeWith(listing("/")), "/")).toEqual(["/Desktop", "/Documents", "/portrait.png"]);
  });

  it("keeps a native path out of the id, because the store cannot place one", () => {
    // The shape the desktop build shipped with. Nothing throws — the entries simply never appear.
    const native: BridgeEntry[] = [
      { id: "C:\\Users\\shika\\Desktop", value: "Desktop", type: "folder" },
      { id: "C:\\Users\\shika\\portrait.png", value: "portrait.png", type: "file" },
    ];
    expect(childrenOf(storeWith(native), "/")).toEqual([]);
    // And what the adapter builds instead does land.
    expect(bridgeIdFor("/", "Desktop")).toBe("/Desktop");
    expect(bridgeIdFor("/Desktop", "shot.png")).toBe("/Desktop/shot.png");
  });

  it("nests a folder's own listing under that folder", () => {
    const store = storeWith(listing("/"));
    store.in.exec("provide-data", { id: "/Desktop", data: listing("/Desktop") });
    expect(childrenOf(store, "/Desktop")).toEqual(["/Desktop/Desktop", "/Desktop/Documents", "/Desktop/portrait.png"]);
  });

  /**
   * The web build's own version of the exact same bug the comment above
   * documents for desktop — found live, "Открыть папку" on the web build's
   * own home screen: picking a folder showed it in the tree, but opening it
   * always showed empty, at every depth. `TauriFileSystemProvider.list`
   * marks every folder entry `lazy: true`, which is what tells the file
   * manager to actually ask for a folder's children when it is opened
   * (`request-data`) instead of treating "no children handed over yet" as
   * "this folder has none" — `BrowserFileSystemProvider.setFiles` built its
   * own folder entries without that flag, so a folder more than one level
   * deep (any `webkitdirectory` pick has at least one) was silently
   * unopenable, even though `list()` already had the right children ready
   * the moment they were asked for.
   */
  describe("BrowserFileSystemProvider — a real webkitdirectory pick", () => {
    function pickedFolder(): File[] {
      const bytes = new Uint8Array([1, 2, 3]);
      const make = (relativePath: string): File => {
        const file = new File([bytes], relativePath.split("/").pop()!, { type: "image/png" });
        Object.defineProperty(file, "webkitRelativePath", { value: relativePath });
        return file;
      };
      return [make("MyFolder/a.png"), make("MyFolder/sub/b.png")];
    }

    it("marks a folder from a real picked file list as lazy — the exact flag missing before this fix", async () => {
      const provider = browserFiles(createBridgeFileSystemProvider())!;
      provider.setFiles(pickedFolder());
      const root = await provider.list("/");
      const folderEntry = root.find((entry) => entry.type === "folder");
      expect(folderEntry?.lazy).toBe(true);
    });

    it("opening a picked folder actually shows its children, not an empty listing", async () => {
      const provider = browserFiles(createBridgeFileSystemProvider())!;
      provider.setFiles(pickedFolder());
      const store = new DataStore();
      const root = await provider.list("/");
      store.init({ data: root.map((entry) => ({ ...entry })) });
      const folderEntry = root.find((entry) => entry.type === "folder")!;
      expect(folderEntry.lazy).toBe(true);
      const children = await provider.list(folderEntry.id);
      store.in.exec("provide-data", { id: folderEntry.id, data: children.map((entry) => ({ ...entry })) });
      expect(childrenOf(store, folderEntry.id).sort()).toEqual(["/MyFolder/a.png", "/MyFolder/sub"]);
    });

    it("goes two levels deep just as cleanly", async () => {
      const provider = browserFiles(createBridgeFileSystemProvider())!;
      provider.setFiles(pickedFolder());
      const sub = await provider.list("/MyFolder/sub");
      expect(sub.map((entry) => entry.id)).toEqual(["/MyFolder/sub/b.png"]);
    });
  });
});
