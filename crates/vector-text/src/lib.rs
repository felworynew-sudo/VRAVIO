use std::fmt::Write as _;
use std::sync::Arc;

use parley::fontique::Blob;
use parley::{
    Alignment, AlignmentOptions, FontContext, FontFamily, Layout,
    LayoutContext, PositionedLayoutItem, StyleProperty,
};
use serde::Serialize;
use skrifa::instance::{LocationRef, Size};
use skrifa::outline::{DrawSettings, OutlinePen};
use skrifa::{FontRef, GlyphId, MetadataProvider};
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
/// separate, larger UI work, still not done. Interactive cursor/selection
/// is the same story. "Convert text to curves" **is** implemented, added
/// 6 September 2026 — see `text_to_curves` below, which runs `skrifa`'s
/// own outline API (`OutlinePen`) on each shaped glyph rather than only
/// reading back its position/advance the way `layout_text` does.
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

#[derive(Serialize)]
struct GlyphOutline {
    /// An SVG path `d` string for exactly this one glyph, already
    /// positioned at its own resolved location on the line and flipped
    /// from font design space (y grows upward) into the same y-down screen
    /// convention `GlyphResult.y` above already uses — a caller turns this
    /// straight into a path shape's own points, no further transform math.
    d: String,
}

#[derive(Serialize)]
struct OutlineLineResult {
    glyphs: Vec<GlyphOutline>,
}

#[derive(Serialize)]
struct TextOutlineResult {
    width: f32,
    height: f32,
    lines: Vec<OutlineLineResult>,
}

/// Collects one glyph's contours into an SVG path `d` string as skrifa's
/// `OutlinePen` calls back into it — the same on/off-curve-point vocabulary
/// (move/line/quad/cubic/close) `path-data.ts` on the TypeScript side
/// already reads back on import, so nothing downstream needs a new curve
/// representation just for this feature.
struct SvgPathPen {
    path: String,
    origin_x: f32,
    origin_y: f32,
}

impl SvgPathPen {
    fn new(origin_x: f32, origin_y: f32) -> Self {
        Self { path: String::new(), origin_x, origin_y }
    }
}

impl OutlinePen for SvgPathPen {
    fn move_to(&mut self, x: f32, y: f32) {
        let _ = write!(self.path, "M{} {} ", self.origin_x + x, self.origin_y - y);
    }
    fn line_to(&mut self, x: f32, y: f32) {
        let _ = write!(self.path, "L{} {} ", self.origin_x + x, self.origin_y - y);
    }
    fn quad_to(&mut self, cx0: f32, cy0: f32, x: f32, y: f32) {
        let _ = write!(self.path, "Q{} {} {} {} ", self.origin_x + cx0, self.origin_y - cy0, self.origin_x + x, self.origin_y - y);
    }
    fn curve_to(&mut self, cx0: f32, cy0: f32, cx1: f32, cy1: f32, x: f32, y: f32) {
        let _ = write!(self.path, "C{} {} {} {} {} {} ", self.origin_x + cx0, self.origin_y - cy0, self.origin_x + cx1, self.origin_y - cy1, self.origin_x + x, self.origin_y - y);
    }
    fn close(&mut self) {
        let _ = write!(self.path, "Z ");
    }
}

/// The same layout `layout_text` computes, but every glyph becomes a real
/// SVG path (skrifa's own outline API run per shaped glyph) instead of a
/// bare position/advance — "Convert to Outlines" (docs/vector-plan.md
/// stage 11's own "text to curves"), the one honest gap that write-up
/// named as needing "an implementation, not an investigation" over
/// `skrifa::outline`.
#[wasm_bindgen]
pub fn text_to_curves(text: &str, font_size: f32, max_width: f32, script: &str) -> String {
    let font_bytes_owned = font_bytes(&script_from_str(script)).to_vec();
    let mut font_cx = FontContext::new();
    let mut layout_cx: LayoutContext<()> = LayoutContext::new();

    let (family_ids, _) = font_cx
        .collection
        .register_fonts(Blob::new(Arc::new(font_bytes_owned.clone())), None)
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

    let font_ref = FontRef::new(&font_bytes_owned).expect("embedded font parses");
    let outline_glyphs = font_ref.outline_glyphs();

    let mut lines = Vec::new();
    for line in layout.lines() {
        let mut glyphs = Vec::new();
        for item in line.items() {
            if let PositionedLayoutItem::GlyphRun(glyph_run) = item {
                let mut x = glyph_run.offset();
                let y = glyph_run.baseline();
                for glyph in glyph_run.positioned_glyphs() {
                    let origin_x = x + glyph.x;
                    let origin_y = y - glyph.y;
                    let mut pen = SvgPathPen::new(origin_x, origin_y);
                    if let Some(outline) = outline_glyphs.get(GlyphId::new(glyph.id as u32)) {
                        let _ = outline.draw(DrawSettings::unhinted(Size::new(font_size), LocationRef::default()), &mut pen);
                    }
                    glyphs.push(GlyphOutline { d: pen.path.trim_end().to_string() });
                    x += glyph.advance;
                }
            }
        }
        lines.push(OutlineLineResult { glyphs });
    }

    serde_json::to_string(&TextOutlineResult { width: layout.width(), height: layout.height(), lines }).expect("outline result always serializes")
}
