# vector-color

Stage 14 of `docs/vector-plan.md`: real, ICC-based colour management, via
[`qcms`](https://crates.io/crates/qcms) — Mozilla's own pure-Rust colour
management library (used in Firefox), which compiles to
`wasm32-unknown-unknown` with no feature-flag surgery.

## What's here, and what isn't

`cmyk_to_srgb` converts one CMYK colour through a real ICC CMYK profile
into sRGB, using the profile's own colour tables — not the naive
`(1-c)(1-k)` formula `packages/kernel/src/color.ts`'s `colorToCss` uses
when no profile is available.

**`srgb_to_cmyk` does not exist here.** `qcms` only builds a transform for
`(CMYK, RGB8)` — never the reverse — because it was built to *display* a
CMYK-encoded image correctly, not to turn an arbitrary RGB colour into
press-ready ink percentages (a harder, genuinely different problem:
gamut mapping, black generation/UCR policy — exactly why an ICC profile
carries a separate A2B *and* B2A table rather than one invertible
function). No pure-Rust, `wasm32-unknown-unknown`-compatible library this
search found solves the reverse direction either; the industry-standard
answer (Little CMS) is a C library, the same "needs a C toolchain
`wasm32-unknown-unknown` doesn't have" wall `crates/vector-geometry`
already hit with Clipper2. This is recorded as an open gap in
`docs/vector-plan.md`, not worked around.

`validate_icc_profile` is a real parse-and-check (`qcms::Profile::new_from_slice`),
for the asset store's ICC import path to reject a file that isn't
actually a profile qcms can read, rather than storing it and failing
later at conversion time.

## Rebuilding

```
wasm-pack build --target web --out-dir pkg
```

`pkg/` is committed (see `crates/vector-geometry/README.md` for why) —
every `wasm-pack build` regenerates a `pkg/.gitignore` containing `*`,
which must be deleted before staging `pkg/` for commit.
