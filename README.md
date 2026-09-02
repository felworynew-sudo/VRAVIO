# VRAVIO

Local-first media authoring environment combining Raster + 3D (Растр + 3D), Vector (Вектор), Audio (Аудио), and Video (Видео) workspaces over one document, asset, history, and command kernel.

## Development

```powershell
pnpm install
pnpm test
pnpm build
pnpm dev
```

The implementation requirements are tracked in `docs/requirements.md`. A row is complete only when its implementation and automated verification are both linked.

## Round-trip between environments

Opening part of a document in another editor and taking the result back is the
mechanism the whole architecture rests on, and it is entirely asset revisions.
A layer refers to its bytes by asset rather than holding them, so extracting is
handing over that reference and applying is a revision arriving on it. The
kernel notifies every document holding the asset; environments never call each
other. `Mod+E` opens the active layer in its own tab, `Mod+Alt+E` opens a copy
that relinks on apply, `Mod+Shift+Return` applies.

Decisions taken where the specification left room, and the questions still open:

- **`exportAsAsset` returns `Uint8Array`, not `Blob`.** A Blob would put a
  browser type in code that has to run under a test runner. Callers that need
  a Blob wrap the bytes.
- **Layer buffers carry their own dimensions** (`raster-asset.ts`, a 16-byte
  header before raw RGBA). An asset handed to an editor that never saw the
  source document has to be readable from its bytes alone, and dimensions kept
  in asset metadata are lost the moment the bytes are written to a file or
  passed to a worker. It is lossless because intermediate revisions must not
  accumulate compression damage; delivery formats remain the business of
  export. Assets bound before this existed are upgraded on first extraction.
- **`onAssetRevised` returns void but has to read bytes**, so the work outlives
  the call. `RasterEnvironment.whenSettled()` exposes it for tests and for any
  caller that needs to look at the result.
- **A round-trip that comes back a different size is placed, not stretched.**
  Scaling would be a silent edit nobody asked for.
- **Open question: undoing in the parent currently moves the child too**, since
  both hold the same asset reference and the head moves for both. Photoshop
  leaves an open smart-object editor alone. Which is right here is a product
  decision that has not been made.
