# vector-geometry

The WASM half of Stage 7's `VectorGeometryPort` (`docs/vector-plan.md`) —
boolean polygon operations (union, subtract, intersect, exclude) on top of
[`geo-booleanop`](https://crates.io/crates/geo-booleanop), a pure-Rust
implementation of the Martinez-Rueda algorithm. See that file's own doc
comments, and the Stage 7 section of `docs/vector-plan.md`, for why
`geo-booleanop` rather than the `clipper2` crate the plan originally named
(short version: `clipper2` wraps the C++ Clipper2 library and won't build
for `wasm32-unknown-unknown` without a much heavier Emscripten toolchain;
`geo-booleanop` is pure Rust and compiles for wasm out of the box).

`pkg/` is wasm-pack's build output, **committed to the repo** rather than
built on every machine — this keeps `apps/web` working for anyone who clones
the repo without a Rust toolchain installed. Rebuild it after editing
`src/lib.rs`:

```
wasm-pack build --target web --out-dir pkg --out-name vector_geometry --scope vravio
```

(needs `rustup target add wasm32-unknown-unknown` and `cargo install
wasm-pack` once, if not already set up.)
