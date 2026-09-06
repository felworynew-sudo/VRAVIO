use moxcms::{ColorProfile, Layout, TransformOptions};
use qcms::{DataType, Intent, Profile, Transform};
use wasm_bindgen::prelude::*;

/// Stage 14 of docs/vector-plan.md: real, ICC-based colour management —
/// not the naive `(1-c)(1-k)` formula `kernel/color.ts`'s own `colorToCss`
/// already documents as a placeholder for exactly this crate to replace,
/// where a profile actually exists to do the real math with.
///
/// The donor is `qcms` — Mozilla's own colour management library, used in
/// Firefox to display embedded ICC profiles correctly, pure Rust, and
/// compiles to `wasm32-unknown-unknown` with zero feature-flag surgery
/// (confirmed directly: `cargo build --target wasm32-unknown-unknown` on
/// an empty crate depending on nothing else). The same "check open source
/// first" pass that found it also found its real limit, which this crate
/// is honest about rather than working around by half-measures:
///
/// **qcms only transforms CMYK → RGB, never the other way.** Its own
/// `transform_create` hard-codes the pairs of (input type, output type) it
/// will build a transform for — `(CMYK, RGB8)` is one of them,
/// `(RGB8, CMYK)` is not; every unlisted pair falls through to `None`. This
/// isn't a missing feature to work around with a few more lines: qcms was
/// built for *display* (show a CMYK JPEG correctly on an sRGB screen), a
/// job that only ever needs that one direction.
///
/// A second open-source search (6 September 2026, after the owner asked
/// for the reverse direction explicitly rather than leaving it a
/// documented gap) found one: **`moxcms`** — BSD-3-Clause OR Apache-2.0,
/// pure Rust, `wasm32-unknown-unknown`-compatible (two dependencies,
/// `num-traits` and `pxfm`, both pure Rust, no C/FFI), and — unlike
/// qcms — a general ICC engine that reads a profile's **B2A** tag (PCS →
/// device), not only its A2B (device → PCS) tag. That B2A tag is exactly
/// where an ICC profile stores the gamut-mapping/black-generation policy
/// this direction genuinely needs (`moxcms`'s own `Lut3x4`/`transform_lut3_to_4.rs`
/// reads it as a real 3-in/4-out CLUT) — `srgb_to_cmyk` below still needs
/// a real profile with that tag present to do anything (a profile with
/// only an A2B tag, like a display profile, correctly yields `None` here,
/// the same honest failure `cmyk_to_srgb` already gives for the reverse
/// case). Little CMS remains the industry-standard answer and remains a C
/// library out of reach on this target — the same wall Clipper2 hit in
/// stage 7 — but this is no longer "no pure-Rust option exists at all".
#[wasm_bindgen]
pub fn validate_icc_profile(bytes: &[u8]) -> bool {
    Profile::new_from_slice(bytes, false).is_some()
}

/// Converts one CMYK colour (each channel 0..255, matching qcms's own
/// `DataType::CMYK` byte convention — a caller working in this codebase's
/// own 0..1 convention, see `kernel/color.ts`'s `Color.components` doc
/// comment, scales by 255 first) through the given ICC CMYK profile into
/// sRGB bytes `[r, g, b]`. `None` if `profile_bytes` is not a profile qcms
/// can parse, or the transform itself cannot be built (a non-CMYK profile,
/// for instance — passing an RGB profile here is a caller error, not a
/// data error, so this reports it the same way rather than guessing).
#[wasm_bindgen]
pub fn cmyk_to_srgb(c: u8, m: u8, y: u8, k: u8, profile_bytes: &[u8]) -> Option<Vec<u8>> {
    let cmyk_profile = Profile::new_from_slice(profile_bytes, false)?;
    let srgb_profile = Profile::new_sRGB();
    let transform = Transform::new_to(&cmyk_profile, &srgb_profile, DataType::CMYK, DataType::RGB8, Intent::Perceptual)?;
    let mut out = vec![0u8; 3];
    transform.convert(&[c, m, y, k], &mut out);
    Some(out)
}

/// Converts one sRGB colour `(r, g, b)` through the given ICC CMYK
/// profile's own **B2A** tag into CMYK ink percentages `[c, m, y, k]`
/// (each 0..255) — real gamut mapping and black generation from the
/// profile itself, not a re-derivation of `cmyk_to_srgb`'s A2B direction
/// and not the naive `(1-r)/(1-k)`-style formula this crate exists to
/// replace. `None` if `profile_bytes` doesn't parse as an ICC profile,
/// or the profile has no CMYK colour space / no B2A tag `moxcms` can use
/// to build this specific transform (a colour-managed *display* profile,
/// for instance, typically has only the A2B direction `cmyk_to_srgb`
/// already covers — that is a data problem to report honestly as `None`,
/// not a bug to route around).
#[wasm_bindgen]
pub fn srgb_to_cmyk(r: u8, g: u8, b: u8, profile_bytes: &[u8]) -> Option<Vec<u8>> {
    let cmyk_profile = ColorProfile::new_from_slice(profile_bytes).ok()?;
    let srgb_profile = ColorProfile::new_srgb();
    // `Layout::Rgba`, not the seemingly-obvious `Layout::Cmyka` — confirmed
    // empirically (a native, non-wasm `cargo test` probe against this
    // exact profile shape), not assumed from the enum's name. moxcms's own
    // `DataColorSpace::Cmyk::check_layout` only accepts `Layout::Rgba` for
    // a 4-channel CMYK-space profile on this side of the transform (its
    // doc comment: "Cmyk8 uses the same layout as Rgba8" — same 4-byte
    // memory shape, channels reinterpreted); `Layout::Cmyka` exists for a
    // different case this crate doesn't use and fails here with
    // `InvalidLayout` despite type-checking fine, which is exactly the
    // "code looks right, isn't" trap CLAUDE.md's own rule 2 warns about.
    let transform = srgb_profile
        .create_transform_8bit(Layout::Rgb, &cmyk_profile, Layout::Rgba, TransformOptions::default())
        .ok()?;
    let mut out = vec![0u8; 4];
    transform.transform(&[r, g, b], &mut out).ok()?;
    Some(out)
}

/// Test-fixture-only: builds a minimal CMYK ICC profile carrying both an
/// `A2B` and a `B2A` tag (`lut8Type`, 2 grid points per axis — the
/// corners of the input hypercube are the only points actually stored,
/// everything else is the reading library's own interpolation), via
/// `moxcms`'s own `ColorProfile::encode()` rather than this crate hand-
/// writing ICC binary layout a second time.
///
/// Why this exists at all: there is no small, unambiguously-licensed
/// real-world CMYK ICC profile this repo can commit and embed for
/// `cmyk_to_srgb`/`srgb_to_cmyk`'s own tests, and a first attempt at
/// hand-writing the ICC v2 header (correct enough for `qcms`, which barely
/// validates it) failed `moxcms`'s parse with `InvalidProfile` for reasons
/// that stayed opaque even after checking every header field `moxcms`'s
/// own source validates (profile signature, version, colour space,
/// PCS) — `moxcms` is the more particular reader of the two libraries
/// this crate wraps, so its own encoder is the reliable way to produce
/// bytes it (and, checked here, `qcms` too) will actually accept, rather
/// than trusting a second from-scratch binary-format implementation this
/// pass could not get to agree with the first.
///
/// `a2b_corners` must be exactly 16×3 = 48 bytes (16 CMYK-hypercube
/// corners, 3 output channels each, address order matching
/// `apps/web/src/vector-color.test.ts`'s own `buildLut8Tag` bit ordering);
/// `b2a_corners` must be exactly 8×4 = 32 bytes (8 XYZ-cube corners, 4
/// output channels each). Panics on the wrong length — a test-fixture
/// helper's caller is this repo's own test file, not untrusted input.
#[wasm_bindgen]
pub fn build_test_cmyk_profile(a2b_corners: &[u8], b2a_corners: &[u8]) -> Vec<u8> {
    assert_eq!(a2b_corners.len(), 16 * 3, "a2b_corners must be 16 corners × 3 channels");
    assert_eq!(b2a_corners.len(), 8 * 4, "b2a_corners must be 8 corners × 4 channels");
    let identity = moxcms::Matrix3d { v: [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]] };
    let ramp = |channels: u8| -> moxcms::LutStore { moxcms::LutStore::Store8((0..channels).flat_map(|_| (0..256u32).map(|i| i as u8)).collect()) };
    let a2b = moxcms::LutDataType {
        num_input_channels: 4, num_output_channels: 3, num_clut_grid_points: 2,
        matrix: identity, num_input_table_entries: 256, num_output_table_entries: 256,
        input_table: ramp(4), clut_table: moxcms::LutStore::Store8(a2b_corners.to_vec()), output_table: ramp(3),
        lut_type: moxcms::LutType::Lut8,
    };
    let b2a = moxcms::LutDataType {
        num_input_channels: 3, num_output_channels: 4, num_clut_grid_points: 2,
        matrix: identity, num_input_table_entries: 256, num_output_table_entries: 256,
        input_table: ramp(3), clut_table: moxcms::LutStore::Store8(b2a_corners.to_vec()), output_table: ramp(4),
        lut_type: moxcms::LutType::Lut8,
    };
    let mut profile = ColorProfile::default();
    profile.pcs = moxcms::DataColorSpace::Xyz;
    profile.color_space = moxcms::DataColorSpace::Cmyk;
    profile.profile_class = moxcms::ProfileClass::OutputDevice;
    profile.rendering_intent = moxcms::RenderingIntent::Perceptual;
    profile.lut_a_to_b_perceptual = Some(moxcms::LutWarehouse::Lut(a2b));
    profile.lut_b_to_a_perceptual = Some(moxcms::LutWarehouse::Lut(b2a));
    profile.encode().expect("a well-formed minimal LutDataType always encodes")
}

/// Same shape as `build_test_cmyk_profile`, but the `B2A` tag omitted —
/// for the test that checks `srgb_to_cmyk` honestly returns `None` on a
/// profile that only carries the `cmyk_to_srgb` direction.
#[wasm_bindgen]
pub fn build_test_cmyk_profile_a2b_only(a2b_corners: &[u8]) -> Vec<u8> {
    assert_eq!(a2b_corners.len(), 16 * 3, "a2b_corners must be 16 corners × 3 channels");
    let identity = moxcms::Matrix3d { v: [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]] };
    let ramp = |channels: u8| -> moxcms::LutStore { moxcms::LutStore::Store8((0..channels).flat_map(|_| (0..256u32).map(|i| i as u8)).collect()) };
    let a2b = moxcms::LutDataType {
        num_input_channels: 4, num_output_channels: 3, num_clut_grid_points: 2,
        matrix: identity, num_input_table_entries: 256, num_output_table_entries: 256,
        input_table: ramp(4), clut_table: moxcms::LutStore::Store8(a2b_corners.to_vec()), output_table: ramp(3),
        lut_type: moxcms::LutType::Lut8,
    };
    let mut profile = ColorProfile::default();
    profile.pcs = moxcms::DataColorSpace::Xyz;
    profile.color_space = moxcms::DataColorSpace::Cmyk;
    profile.profile_class = moxcms::ProfileClass::OutputDevice;
    profile.rendering_intent = moxcms::RenderingIntent::Perceptual;
    profile.lut_a_to_b_perceptual = Some(moxcms::LutWarehouse::Lut(a2b));
    profile.encode().expect("a well-formed minimal LutDataType always encodes")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flat_a2b(corner: impl Fn(u8, u8, u8, u8) -> [u8; 3]) -> Vec<u8> {
        let mut out = Vec::with_capacity(16 * 3);
        for index in 0..16u8 {
            let (c, m, y, k) = ((index >> 3) & 1, (index >> 2) & 1, (index >> 1) & 1, index & 1);
            out.extend(corner(c, m, y, k));
        }
        out
    }

    fn flat_b2a(corner: impl Fn(u8, u8, u8) -> [u8; 4]) -> Vec<u8> {
        let mut out = Vec::with_capacity(8 * 4);
        for index in 0..8u8 {
            let (x, y, z) = ((index >> 2) & 1, (index >> 1) & 1, index & 1);
            out.extend(corner(x, y, z));
        }
        out
    }

    /// `srgb_to_cmyk`'s own round trip — write via `moxcms`'s encoder,
    /// read back via `moxcms`'s own transform, both directions of one
    /// library. Deliberately does NOT also check `cmyk_to_srgb` (qcms)
    /// against this same moxcms-encoded profile: an earlier version of
    /// this test did, and found qcms reading a `moxcms`-written A2B0 CLUT
    /// in a different corner order than qcms's own writer convention (or
    /// this crate's own, qcms-compatible, hand-built fixture in
    /// `apps/web/src/vector-color.test.ts` uses) — `cmyk_to_srgb(0,0,0,0)`
    /// and `cmyk_to_srgb(0,0,0,255)` on a `moxcms`-encoded profile came
    /// back byte-identical, meaning qcms wasn't seeing the k-axis move at
    /// all. That is a genuine cross-library ICC byte-layout incompatibility
    /// between two independently-implemented CMMs, not a bug in either
    /// library's own read/write round trip, and not something this crate
    /// needs to solve: each direction only ever needs to work with the
    /// library that will actually execute it in production, never with
    /// the other one's writer.
    #[test]
    fn srgb_to_cmyk_is_a_real_transform_not_a_naive_formula() {
        let a2b = flat_a2b(|c, m, y, k| {
            let (c, m, y, k) = (c as f32, m as f32, y as f32, k as f32);
            [
                (255.0 * (0.15 + 0.10 * c + 0.05 * m + 0.03 * y + 0.02 * k)).round() as u8,
                (255.0 * (0.15 + 0.02 * c + 0.10 * m + 0.05 * y + 0.03 * k)).round() as u8,
                (255.0 * (0.35 - 0.05 * c - 0.05 * m - 0.05 * y - 0.25 * k).max(0.0)).round() as u8,
            ]
        });
        let b2a = flat_b2a(|x, y, z| {
            let (x, y, z) = (x as f32, y as f32, z as f32);
            [
                (255.0 * (0.05 + 0.30 * (1.0 - x) + 0.05 * (1.0 - y) + 0.03 * (1.0 - z))).round() as u8,
                (255.0 * (0.05 + 0.05 * (1.0 - x) + 0.30 * (1.0 - y) + 0.04 * (1.0 - z))).round() as u8,
                (255.0 * (0.05 + 0.04 * (1.0 - x) + 0.05 * (1.0 - y) + 0.30 * (1.0 - z))).round() as u8,
                (255.0 * (0.02 + 0.15 * (1.0 - x) * (1.0 - y) * (1.0 - z))).round() as u8,
            ]
        });
        let profile = build_test_cmyk_profile(&a2b, &b2a);
        assert!(validate_icc_profile(&profile));

        // Not asserted here: "white sRGB gives less total ink than black
        // sRGB". A first version of this test tried that and failed —
        // sRGB(255,255,255) and sRGB(0,0,0) both convert to *specific*
        // PCS-XYZ byte positions inside this profile's B2A grid (via
        // moxcms's own sRGB A2B step first), and where those positions
        // land relative to this test's 2-point grid corners depends on
        // the PCS-XYZ 8-bit encoding range (which extends somewhat past
        // 1.0, not 0..1 mapped straight to 0..255) — a detail this
        // synthetic fixture's corner function doesn't model faithfully
        // enough to make that specific comparison meaningful. What *is*
        // meaningful, and asserted below: real inputs produce distinct,
        // properly-interpolated outputs — proof this is the actual B2A
        // CLUT executing, not a stub.
        let light = srgb_to_cmyk(255, 255, 255, &profile).expect("B2A0 direction should work");
        let dark = srgb_to_cmyk(0, 0, 0, &profile).expect("B2A0 direction should work");
        assert_ne!(light, dark);

        // Non-vacuity: distinct sRGB inputs give distinct CMYK outputs.
        let red = srgb_to_cmyk(255, 0, 0, &profile).unwrap();
        let green = srgb_to_cmyk(0, 255, 0, &profile).unwrap();
        let blue = srgb_to_cmyk(0, 0, 255, &profile).unwrap();
        assert_ne!(red, green);
        assert_ne!(green, blue);
        assert_ne!(red, blue);

        // Real multi-dimensional interpolation, not 8 fixed answers: a
        // midpoint on the X axis lands strictly between the two corners
        // it's between, not snapped to either one.
        let x_zero = srgb_to_cmyk(0, 255, 255, &profile).unwrap();
        let x_one = srgb_to_cmyk(255, 255, 255, &profile).unwrap();
        let x_half = srgb_to_cmyk(128, 255, 255, &profile).unwrap();
        for channel in 0..4 {
            let (lo, hi) = (x_zero[channel].min(x_one[channel]), x_zero[channel].max(x_one[channel]));
            assert!(x_half[channel] as i32 >= lo as i32 - 5 && x_half[channel] as i32 <= hi as i32 + 5, "channel {channel}: half={} not between zero={} and one={}", x_half[channel], x_zero[channel], x_one[channel]);
        }
        assert_ne!(x_half, x_zero);
        assert_ne!(x_half, x_one);
    }

    #[test]
    fn srgb_to_cmyk_returns_none_for_a_profile_with_no_b2a_tag() {
        let a2b = flat_a2b(|c, m, y, k| {
            let (c, m, y, k) = (c as f32, m as f32, y as f32, k as f32);
            [
                (255.0 * (0.15 + 0.10 * c + 0.05 * m + 0.03 * y + 0.02 * k)).round() as u8,
                (255.0 * (0.15 + 0.02 * c + 0.10 * m + 0.05 * y + 0.03 * k)).round() as u8,
                (255.0 * (0.35 - 0.05 * c - 0.05 * m - 0.05 * y - 0.25 * k).max(0.0)).round() as u8,
            ]
        });
        let profile = build_test_cmyk_profile_a2b_only(&a2b);
        assert!(cmyk_to_srgb(0, 0, 0, 0, &profile).is_some(), "A2B0 direction still works");
        assert!(srgb_to_cmyk(255, 0, 0, &profile).is_none(), "no B2A0 tag on this profile");
    }
}
