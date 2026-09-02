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
