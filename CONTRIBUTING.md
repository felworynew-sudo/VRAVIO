# Contributing

This is a decision record, not a style guide. It exists so the next change in this
codebase — by a person or an agent — extends what's here instead of growing a second,
slightly different way of doing the same thing next to it.

## Write it once, extend by registering, not by branching

`raster-adjustments/registry.ts` and `raster-core-panels/registry.ts` both use
`import.meta.glob("./definitions/*.{tsx,ts}", { eager: true })` to auto-collect
definition modules instead of a hand-maintained list. `commands.ts`'s
`registerToolShortcuts()` does the equivalent at runtime: it derives one command per
shared-letter tool group straight from `tools.ts`, so a new tool with a shared letter
needs no second place to register its shortcut.

A new adjustment, panel, or tool group is a new file matched by an existing glob, or a
loop over existing data — not a new `if`/`case` arm bolted onto a switch that already
has fifteen. If you catch yourself writing the sixteenth arm, that's the signal to turn
the switch into a lookup instead.

## Environment-scoped catalogs: panels, tools, presets

VRAVIO is one shell over four environments (raster/vector/audio/video, more later). The
rule that keeps them from turning into copy-pasted forks of each other: **a catalog is
environment-scoped and lives in its own files; a component is shared and branches
internally on document kind.** Getting these backwards is the single easiest way to
regress "vector shows raster's adjustment menu" or "audio has no panels at all."

### Panel catalogs — one directory per environment, same three files

`raster-core-panels/` and `vector-core-panels/` are siblings, and every environment that
gets its own panel set (audio/video, when built) is a third sibling with the identical
shape:

- `types.ts` — the `<Env>CorePanelDefinition`/`<Env>CorePanelModule` types and
  `corePanelTitle` helper. Copy from an existing one; the shape doesn't change per
  environment.
- `registry.ts` — `import.meta.glob<T>("./definitions/*.ts", { eager: true })` over
  `definitions/*.ts`, exporting `<env>CorePanels` and `<env>CorePanelById`. A new panel
  *for that environment* is a new file under its own `definitions/`, matched
  automatically — never a new `if` arm in a switch.
- `runtime.ts` — its own `STORAGE_KEY`, `PANEL_REQUEST_EVENT`, `PANEL_CHANGED_EVENT`, and
  the read/persist/request functions. Environment-scoped storage keys are what let a
  user's raster layout and vector layout differ and both survive reload independently.

What each environment's `definitions/` directory *contains* is where they genuinely
differ, and that's the point: vector's directory has no `assets`/`navigator`/`effects`
panel definitions because vector has no use for them, and that absence is real — nothing
elsewhere has to remember to hide them.

`DockLayout.tsx` wires a new environment's catalog into the shell the same way vector's
was wired onto raster's pattern: import its `registry`/`runtime` exports (aliasing the
event/function names, e.g. `PANEL_REQUEST_EVENT as VECTOR_PANEL_REQUEST_EVENT`), add its
branch to the panel-request-event listener, and add its `persist*(...)` call alongside
the others in `onDidLayoutChange`. `App.tsx`'s Window menu picks the right catalog with
one ternary keyed on `active?.kind` — extend the ternary, don't duplicate the menu.

### Panel *components* are shared, not duplicated

The panel a user sees for "Properties" or "Layers" is **one component**, registered
under the same id (`inspector`, `layers`, `history`, `color`, ...) in every catalog that
offers it. `InspectorPanel` in `DockLayout.tsx` is the reference: it checks
`isRasterDocumentState(document.state)` first, `isVectorDocumentState(document.state)`
second, and renders the shape appropriate to whichever is true. A raster-only concept
(adjustment-layer editing, layer effects) is a branch *inside* that shared component,
gated on document kind — never a second `VectorInspectorPanel` component copy-pasted
from the raster one with the raster-only parts stripped out by hand. If a genuinely
raster-only or vector-only panel doesn't make sense to share at all (there is no vector
equivalent of Channels), it simply isn't registered in the other environment's catalog —
that's what keeps it invisible there, not a runtime `disabled` check.

### The tool catalog

`tools.ts` is one flat array covering every environment, each entry carrying a `kind`
field (`"raster" | "vector" | "audio" | "video"`). Every UI surface that lists tools —
the toolbar, the options bar, shortcut registration — filters that one array by
`tool.kind === active.kind` rather than importing a separate per-environment tool list.
Adding a tool is one new array entry with the right `kind`, in the file every other tool
already lives in. If two environments need the literal same tool (a shared selection or
transform behavior), it is **one tool definition reused across the environments that
apply it**, not two definitions that happen to look alike today and drift apart the
first time one of them gets a bug fix the other doesn't.

### New Document presets follow the same rule

`NewDocumentDialog.tsx`'s preset list is one array; each preset carries a
`documentKind` field, and the dialog filters presets, categories and even which input
fields render (`Color mode`/`Pixel aspect` only for `documentKind === "raster"`,
`Background` for `"raster" | "video"`, etc.) by that field. A new environment's presets
are new entries in the same array with their own `documentKind`, not a parallel preset
list.

### Environments never call each other

An environment (`RasterEnvironment`, `VectorEnvironment`, ...) implements the
`Environment` interface from `packages/kernel/src/environment.ts` and is registered once
in `kernel.ts`. The only channel between two environments is the kernel's
`RoundTripManager`, moving an *asset reference* — never pixels or shape data directly —
from one document to another (see `VectorShape`'s `image` kind, which holds a
`pixelAssetId`, not a copy of the picture). Adding a new environment means implementing
that interface; it never means importing raster code into vector's package or vice
versa. `packages/env-vector` depending on `@vravio/env-raster` only for the raster asset
byte format (`encodeRasterAsset`/`decodeRasterAsset` — the shared, environment-agnostic
"what a picture asset's bytes look like" contract) is the one sanctioned exception, and
even that stays one-directional.

## Commands and keyboard shortcuts

`kernel.commands` (`CommandRegistry`) and `kernel.keymap` (`KeymapManager`) are the only
source of truth for anything triggered by a key. **Never add a second `if (key === ...)`
branch in `App.tsx`'s keydown handler for something a command could express.** The
handler's job is exactly two things: resolve the event to a command id via
`kernel.keymap.resolve(event, scopes)`, and execute it. Everything else — brush-size
brackets, opacity digit shortcuts, foreground/background swap — lives there only because
it isn't a document-level action, it's transient tool-option state with no undo step.

- A command's `shortcut` binds under `scope` (default `"global"`). Two environments that
  each want a tool on the same letter (raster's Move and vector's Selection both sit on
  `V`) get their own scope — bind tool commands under `"raster"`/`"vector"`, not
  `"global"`, and resolve with `["global", active.kind]` so only the active document
  kind's tools are reachable.
- Shift-cycling within a shared-letter tool group (Photoshop's own convention: a bare
  letter always selects the first tool sharing it, Shift steps to the next one, wrapping)
  is **one command per letter group**, not one per tool. Read `context.shiftKey` inside
  `execute()` rather than registering a second shortcut — `KeymapManager` binds exactly
  one shortcut per command id, and `resolve()` already falls back from `Shift+<letter>`
  to a bare-letter binding when nothing Ctrl/Alt-qualified matches it.
- A command that needs local React state (opening a dialog, focusing a hidden file
  input) does not reach into a component. It does
  `window.dispatchEvent(new Event("vravio-thing-open"))`, and the component that owns
  the state listens for it in a `useEffect`. This is the established idiom — see
  `file.open`, `filter.liquify`, `image.adjustment.*` in `commands.ts` and their
  listeners in `App.tsx`.
- Register a command's default shortcut through `rememberDefaultShortcut` and let
  `applyShortcutOverrides` re-apply user rebinds at the end of
  `ensureCommandsRegistered()` — this is what makes a command's shortcut show up
  correctly in Settings and survive a rebind-then-reset round trip.

## Every document edit goes through history

Never call `kernel.documents.update(...)` directly for something the user did. It
mutates the document but records no undo step — silently. Route raster edits through a
wrapper that snapshots before/after and calls `history.execute({ label, redo, undo })`;
`changeRasterDocument`/`editLayers` in `commands.ts` is that wrapper for the layer tree,
and every `layer.*` command goes through it. If you're adding a new kind of document
mutation, add the primitive to `packages/env-raster/src/layer-ops.ts` next to
`duplicateLayer`/`mergeLayerDown`/`removeLayer`, then wire a thin command around it —
don't inline tree-splicing logic in the web layer, and don't reimplement something
`layer-ops.ts` already has (check there first).

A menu button and its matching keyboard shortcut must call the *same* command. Two
separate implementations of "duplicate the active layer" is exactly how you end up with
one path that's undo-tracked and one that silently isn't.

## The subscribe/Disposable pattern

Anything that owns listeners (`HistoryManager`, `GPUContext`, `KeymapManager`) exposes
`subscribe(listener): Disposable` backed by a private `Set`, and a React panel that needs
to stay live re-reads the live object on every notification rather than keeping its own
copy. `DockLayout.tsx`'s `HistoryPanel` is the reference example. Don't invent a second
pub/sub shape for a new kernel piece — copy this one.

## Bilingual naming

User-facing strings are `"English (Русский)"` — command labels, categories, layer names,
menu items. `localized(label, language)` (`i18n.ts`) parses the trailing
`(...)` group back out. This means: never construct a label by string-concatenating an
already-bilingual string with a suffix (`` `${name} copy` `` on a name that's already
`"Layer 1 (Слой 1)"` produces `"Layer 1 (Слой 1) copy"`, which `localized()` cannot
parse sanely). Build the bilingual pair fresh, in both halves, at the point you have
both languages' words for it — see `duplicateLayer`'s `` `${source.name} copy (копия)` ``
for the shape to follow when the source name itself might already be bilingual.

## Look at GIMP and Patchy before inventing something

Both are checked out locally for exactly this reason. Before designing a new panel,
tool, or optimization from scratch, check whether GIMP (`gimpcurvestool.c`,
`gimplevelstool.c`, one file per adjustment tool subclassing shared machinery) or Patchy
(`adjustment_dialogs.cpp`, `main_window_docks.cpp`, centralized-dialog + `QDockWidget`
docking) already solved it, and adapt rather than re-derive. A good open-source solution
already carries the edge cases you haven't hit yet.

## Testing a change before calling it done

1. `tsc --noEmit` on all three packages (`packages/kernel`, `packages/env-raster`,
   `apps/web`) — a change in `kernel` or `env-raster` can break `apps/web` silently.
2. `vitest run` for the whole workspace, not just the package you touched.
3. If the change is reachable in the UI, actually reach it in a browser: create a
   document, trigger the thing by keyboard *and* by menu, check the Layers and History
   panels agree with each other, undo, redo. A change that only compiles and passes unit
   tests has not been tested against the one thing unit tests don't cover: whether the
   real event pipeline (keydown → `resolve` → `execute` → history → re-render) actually
   fires end to end.

### A gotcha worth knowing before it bites you again

**Never spread a native DOM `Event`.** `{ ...event }` on a real `KeyboardEvent` produces
an object missing every field (`code`, `key`, `shiftKey`, ...) — DOM event properties are
non-enumerable accessors on the prototype, not own enumerable properties, so spread
silently drops them all. This shipped once in `KeymapManager.resolve()`'s Shift-fallback
path and passed every test, because the unit tests passed plain object literals (whose
properties *are* own and enumerable) instead of real events. If you write a test for
anything that touches a keyboard/mouse event, use a `Object.create({ get code() {...},
... })` shape (or a real `KeyboardEvent`, where the test environment has DOM) — a plain
object literal will not catch this class of bug.

## Where things live

- `packages/kernel` — `DocumentStore`, `HistoryManager`, `CommandRegistry`,
  `KeymapManager`, `GPUContext`, `AssetStore`, `ModelStore`, `RoundtripManager`. Nothing
  here imports React.
- `packages/env-raster` — pure pixel-math and the raster document/layer-tree model. No
  DOM, no React; testable headless.
- `apps/web` — React shell, one `commands.ts` registering everything, one `App.tsx` tying
  kernel state to components via the dispatch-event bridge above.

`docs/requirements.md` tracks what's implemented and verified; a row there isn't done
until both are true.
