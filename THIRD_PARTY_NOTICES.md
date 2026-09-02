# Third-party notices

VRAVIO currently uses or studies the following open-source projects. Keep this file and the upstream notices when redistributing builds.

## Runtime dependencies

- **WaveSurfer.js 7.10.1** — waveform renderer plus Regions and Timeline plugins. BSD-3-Clause. Copyright 2012–2023 katspaugh and contributors. <https://github.com/katspaugh/wavesurfer.js>
- **@ffmpeg/ffmpeg 0.12.15** and **@ffmpeg/util 0.12.2** — browser API and utilities. MIT. <https://github.com/ffmpegwasm/ffmpeg.wasm>
- **@ffmpeg/core 0.12.10** — FFmpeg WebAssembly core used by the local clip exporter. GPL-2.0-or-later. Distribution of a production build must satisfy this licence or replace the core with a suitably configured/licensed media pipeline.
- **three.js 0.185.1** (mrdoob and contributors) — WebGL 3D engine used for the 3D Text and 3D layer workspaces (extrusion/bevel geometry, GLTF/OBJ/STL model loading, orbit camera, lighting). MIT. Bundled font: `helvetiker_regular/bold.typeface.json`, generated from the Helvetiker typeface shipped with three.js's own examples (MIT). <https://github.com/mrdoob/three.js>
- **jsPDF 4.2.1** (James Hall, yWorks GmbH and contributors) — PDF writer used by the raster export dialog's PDF target. MIT. <https://github.com/parallax/jsPDF>
- **libraw-wasm 1.6.0** (ybouane) — Emscripten/WASM build of LibRaw used for full RAW develop (CR2/NEF/ARW/DNG/ORF/PEF/RW2 and more). The npm wrapper is ISC. The bundled LibRaw core itself is dual-licensed LGPL-2.1-or-later / CDDL-1.0 — keep this notice and the upstream LICENSE with any distributed build. <https://github.com/ybouane/LibRaw-Wasm>, <https://www.libraw.org/>.

## Architecture and algorithm references

- **Patchy**, commit `b2e38ae8085d51f9715509640ae4236e28c90626` — MIT. Copyright 2026 Seth A. Robinson. VRAVIO directly adapts permitted MIT-licensed adjustment algorithms and studies its PSD, RAW, brush, text, filter, printing, ruler/guide and Smart Object implementations. Patchy's bundled third-party components retain their own licences and are not covered by Patchy's MIT grant. <https://github.com/SethRobinson/Patchy>

- **VoidCut**, commit `815d596fa8f829e991e3166f2701c70a75bd4770` — MIT. Its local-first browser NLE architecture, Svelte stores and FFmpeg worker boundaries were reviewed for VRAVIO's video workspace. No Svelte UI was copied verbatim. <https://github.com/timii/voidcut>
- **GIMP**, commit `80946b2d4950dd956345eaff6e5fea62a68f2328` — GPL-3.0-or-later. The paint-core implementations of Clone, Heal, Smudge and Convolve were reviewed to verify tool semantics. VRAVIO's TypeScript implementations are separate adaptations; any future direct code port must retain GPL compatibility and notices. <https://gitlab.gnome.org/GNOME/gimp>
- **openDAW**, commit `4a9f183f63dfc7ad049b5f24eca6081205a7c61b` — reviewed as an audio-workstation reference. Its SDK documentation requires AGPL-3.0 product licensing unless a commercial licence is obtained, so it is not embedded in this prototype. <https://github.com/andremichelle/openDAW>
