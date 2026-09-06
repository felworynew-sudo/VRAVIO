# vector-text

The WASM half of Stage 11's real text shaping (`docs/vector-plan.md`) —
[Parley](https://github.com/linebender/parley) (layout, line breaking, bidi
paragraph resolution) on top of HarfRust (shaping — kerning, ligatures).

## Fonts

`assets/` holds three variable fonts from Google's
[`google/fonts`](https://github.com/google/fonts) repository, all
[Noto Sans](https://fonts.google.com/noto/specimen/Noto+Sans) family,
licensed under the
[SIL Open Font License 1.1](https://openfontlicense.org/):

- `NotoSans-VF.ttf` — Latin/Cyrillic/Greek etc.
- `NotoSansArabic-VF.ttf` — Arabic, for the bidi/RTL check.
- `NotoSansDevanagari-VF.ttf` — Devanagari, for the complex-script check.

They're `include_bytes!`'d directly into the compiled `.wasm` — WASM has no
system fonts to discover, so `FontContext::new()` finds nothing on its own
in this sandbox, and these three are what Stage 11's own checklist needs to
prove line-breaking, bidi, and one non-Latin complex script actually work,
not just Latin text with a browser's own font stack standing in.

## Rebuilding

```
wasm-pack build --target web --out-dir pkg --out-name vector_text --scope vravio
```

(needs `rustup target add wasm32-unknown-unknown` and `cargo install
wasm-pack` once, same as `crates/vector-geometry`.)
