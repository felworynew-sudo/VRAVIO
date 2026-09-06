# vector-color

Stage 14 of `docs/vector-plan.md`: real, ICC-based colour management, via
[`qcms`](https://crates.io/crates/qcms) — Mozilla's own pure-Rust colour
management library (used in Firefox) — for CMYK→sRGB, and
[`moxcms`](https://github.com/awxkee/moxcms) for the reverse direction.
Both compile to `wasm32-unknown-unknown`.

## What's here

`cmyk_to_srgb` converts one CMYK colour through a real ICC CMYK profile's
**A2B** tag into sRGB — not the naive `(1-c)(1-k)` formula
`packages/kernel/src/color.ts`'s `colorToCss` uses when no profile is
available.

`srgb_to_cmyk` converts one sRGB colour through a real ICC CMYK profile's
**B2A** tag into CMYK ink percentages — real gamut mapping and black
generation from the profile itself, added 6 September 2026. `qcms` cannot
do this direction at all (its own `transform_create` only builds a
`(CMYK, RGB8)` transform, never the reverse — it was built to *display* a
CMYK-encoded image correctly, not to turn an arbitrary RGB colour into
press-ready ink percentages), and this was recorded as an open,
unworkaroundable gap after a first search found no pure-Rust,
`wasm32-unknown-unknown`-compatible alternative. A second search, after
the project owner asked for the direction explicitly rather than leaving
it a documented gap, found `moxcms`: BSD-3-Clause OR Apache-2.0, pure
Rust (two dependencies, `num-traits` and `pxfm`, both pure Rust, no
C/FFI), and — unlike qcms — a general ICC engine that reads a profile's
B2A tag (`Lut3x4`/`transform_lut3_to_4.rs`, a real 3-in/4-out CLUT reader)
as well as its A2B. Little CMS remains the industry-standard answer and
remains out of reach on this target (a C library — the same
`wasm32-unknown-unknown` wall `crates/vector-geometry` hit with Clipper2
in stage 7) — but "no pure-Rust option exists at all" is no longer true
for this direction.

**A non-obvious pitfall, found the hard way and left as a comment on
`srgb_to_cmyk` itself:** the CMYK side of `create_transform_8bit` needs
`moxcms::Layout::Rgba`, not the seemingly-obvious `Layout::Cmyka` — the
latter type-checks fine and fails at runtime with `InvalidLayout`
(confirmed via a native, non-wasm `cargo test` probe against the exact
profile shape this crate builds, not assumed from the enum's name or its
own doc comment, which says the opposite).

`validate_icc_profile` is a real parse-and-check
(`qcms::Profile::new_from_slice`), for the asset store's ICC import path
to reject a file that isn't actually a profile qcms can read, rather than
storing it and failing later at conversion time. (It only checks against
qcms's parser, not moxcms's — the two disagree on stricter header fields;
see the next section.)

`build_test_cmyk_profile`/`build_test_cmyk_profile_a2b_only` are **test-
fixture builders only**, not used by `cmyk_to_srgb`/`srgb_to_cmyk`
themselves — see their own doc comments and
`apps/web/src/vector-color.test.ts`'s file-level comment for why they
exist and, importantly, why the qcms-side tests do *not* use them (a
profile `moxcms` encodes and `qcms` then reads was found to disagree on
CLUT corner ordering — a genuine cross-library incompatibility between
two independently-implemented CMMs, not a bug in either library's own
read/write round trip).

## Rebuilding

```
wasm-pack build --target web --out-dir pkg
```

`pkg/` is committed (see `crates/vector-geometry/README.md` for why) —
every `wasm-pack build` regenerates a `pkg/.gitignore` containing `*`
(delete it before staging) and resets `pkg/package.json`'s `"name"` field
to the unscoped `vector-color` (must be renamed back to
`@vravio/vector-color` for the pnpm workspace to resolve it — see
`pnpm-workspace.yaml`'s `crates/*/pkg` entry).
