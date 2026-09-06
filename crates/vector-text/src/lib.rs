use std::sync::Arc;

use parley::fontique::Blob;
use parley::{
    Alignment, AlignmentOptions, FontContext, FontFamily, Layout,
    LayoutContext, PositionedLayoutItem, StyleProperty,
};
use serde::Serialize;
use wasm_bindgen::prelude::*;

/// Stage 11 of docs/vector-plan.md: "text stops being a string with a made-
/// up width." Real shaping and layout via Parley (line breaking, bidi
/// paragraph resolution) on top of HarfRust (shaping — kerning, ligatures)
/// — the exact library pair the plan names, not a browser `measureText`
/// stand-in (`vector-text-metrics.ts`'s own existing measurer, which this
/// does not replace: it already gives real per-line width via the
/// browser's own text stack for the common single-line case; this crate is
/// what a *portable*, in-app layout engine looks like — one that doesn't
/// depend on the runtime browser's text stack, works the same offline as
/// in Node/Vitest, and can report line breaks and per-glyph positions a
/// `CanvasRenderingContext2D` has no API for at all).
///
/// **WASM has no system fonts** — `FontContext::new()` finds none in this
/// sandbox — so the three fonts this stage's own checklist needs (Latin,
/// Arabic, Devanagari, to prove line-breaking, bidi, and a complex script
/// all actually work) are embedded directly into the compiled `.wasm` via
/// `include_bytes!`. All three are Noto Sans (OFL), fetched from Google's
/// own `google/fonts` repository. This is lazily loaded — nothing pays for
/// these ~3.4 MB combined until a caller actually asks this module to lay
/// out text — the same "pay only when used" shape Stage 7/8/10's own
/// crates already established.
///
/// **Honest scope for this pass**: this proves the hard, novel part —
/// real shaping/layout/bidi/complex-script support existing at all, in a
/// portable Rust engine — not the full stage. Text-in-a-frame's line-
/// wrapping and text-on-a-path's curve-following are both real uses of
/// `Layout` this module already computes enough to support, but wiring
/// either into `VectorWorkspace.tsx`'s live editing (as opposed to calling
/// this module and reading back numbers, which is what the tests do) is
/// separate, larger UI work. Interactive cursor/selection and "convert
/// text to curves" (via `skrifa`'s outline API on each shaped glyph) are
/// not implemented at all yet — both need the same per-glyph position data
/// this module already returns, but neither has been built on top of it.
#[derive(Serialize)]
struct LayoutResult {
    width: f32,
    height: f32,
    lines: Vec<LineResult>,
}

#[derive(Serialize)]
struct LineResult {
    /// Byte offsets into the original text this line covers — what a
    /// caller needs to know which characters wrapped where.
    text_start: usize,
    text_end: usize,
    width: f32,
    glyphs: Vec<GlyphResult>,
}

#[derive(Serialize)]
struct GlyphResult {
    /// Position within the line, left edge of the glyph's advance box —
    /// already resolved for right-to-left runs (Parley's own bidi
    /// reordering), so a caller never has to reimplement that logic to
    /// place a text cursor correctly in a mixed-direction line.
    x: f32,
    y: f32,
    advance: f32,
}

enum Script {
    Latin,
    Arabic,
    Devanagari,
}

fn font_bytes(script: &Script) -> &'static [u8] {
    match script {
        Script::Latin => include_bytes!("../assets/NotoSans-VF.ttf"),
        Script::Arabic => include_bytes!("../assets/NotoSansArabic-VF.ttf"),
        Script::Devanagari => include_bytes!("../assets/NotoSansDevanagari-VF.ttf"),
    }
}

fn script_from_str(script: &str) -> Script {
    match script {
        "arabic" => Script::Arabic,
        "devanagari" => Script::Devanagari,
        _ => Script::Latin,
    }
}

/// Lays out `text` at `font_size`, wrapping at `max_width` (0 = no
/// wrapping — a single unbounded line, "point text"), and returns the
/// overall bounding size plus every line's glyphs with their resolved
/// (post-bidi, post-shaping) positions and advances, as JSON.
#[wasm_bindgen]
pub fn layout_text(text: &str, font_size: f32, max_width: f32, script: &str) -> String {
    let mut font_cx = FontContext::new();
    let mut layout_cx: LayoutContext<()> = LayoutContext::new();

    let (family_ids, _) = font_cx
        .collection
        .register_fonts(Blob::new(Arc::new(font_bytes(&script_from_str(script)).to_vec())), None)
        .into_iter()
        .next()
        .expect("embedded font registers at least one family");
    let family_name = font_cx.collection.family_name(family_ids).expect("registered family has a name").to_string();

    let mut builder = layout_cx.ranged_builder(&mut font_cx, text, 1.0, true);
    builder.push_default(StyleProperty::FontFamily(FontFamily::named(&family_name)));
    builder.push_default(StyleProperty::FontSize(font_size));

    let mut layout: Layout<()> = builder.build(text);
    layout.break_all_lines(if max_width > 0.0 { Some(max_width) } else { None });
    layout.align(Alignment::Start, AlignmentOptions::default());

    let mut lines = Vec::new();
    for line in layout.lines() {
        let metrics = line.metrics();
        let mut glyphs = Vec::new();
        for item in line.items() {
            if let PositionedLayoutItem::GlyphRun(glyph_run) = item {
                let mut x = glyph_run.offset();
                let y = glyph_run.baseline();
                for glyph in glyph_run.positioned_glyphs() {
                    glyphs.push(GlyphResult { x: x + glyph.x, y: y - glyph.y, advance: glyph.advance });
                    x += glyph.advance;
                }
            }
        }
        let text_range = line.text_range();
        lines.push(LineResult { text_start: text_range.start, text_end: text_range.end, width: metrics.advance, glyphs });
    }

    serde_json::to_string(&LayoutResult { width: layout.width(), height: layout.height(), lines }).expect("layout result always serializes")
}
