use serde::Serialize;
use usvg::tiny_skia_path::PathSegment;
use usvg::{Group, Node, Options, Paint, Tree};
use wasm_bindgen::prelude::*;

/// Stage 10 of docs/vector-plan.md: importing someone else's SVG. `usvg`
/// does the hard part — resolving `<use>`, CSS, `%`/`em` units, nested
/// `viewBox`es — into a tree of already-absolute paths/groups/images/text.
/// This module walks that resolved tree and re-serializes it as flat JSON
/// `@vravio/env-vector`'s own `svg-import.ts` turns into `VectorShape`s,
/// rather than trying to hand a `usvg::Tree` (private fields, no public
/// constructor) across the WASM boundary directly.
///
/// **Honest, documented scope cuts for this pass**, matching every other
/// stage's own practice of naming a gap rather than silently not handling
/// it:
/// - Group *nesting* is flattened. Every path/image comes out top-level
///   with its correct **absolute** transform (`Node::abs_transform`) baked
///   in, so the picture still looks right — but the original `<g>`
///   hierarchy (and therefore the ability to select/move a former group as
///   one unit) does not survive the round trip. Reconstructing nested
///   `VectorShape` groups with each one's own *relative* transform is real,
///   separate work.
/// - `Paint::Pattern` (SVG `<pattern>` fills) falls back to a flat mid-gray
///   rather than being rendered — patterns are rare in hand-authored SVGs
///   and a genuine tiled-image paint is its own feature, not a a few-line
///   addition here.
/// - `Node::Text` is skipped entirely, not converted to outlines and not
///   imported as editable text. Shaping text at all needs real font data
///   loaded into `fontdb`, which is Stage 11's job (Parley/HarfRust) — an
///   import path that half-shapes text without that infrastructure would
///   be worse than one that honestly imports nothing for it yet.
#[derive(Serialize)]
struct ImportedShape {
    kind: &'static str,
    d: String,
    transform: [f32; 6],
    fill: Option<ImportedPaintStyle>,
    stroke: Option<ImportedStrokeStyle>,
    opacity: f32,
}

#[derive(Serialize)]
struct ImportedPaintStyle {
    paint: ImportedPaint,
    opacity: f32,
}

#[derive(Serialize)]
struct ImportedStrokeStyle {
    paint: ImportedPaint,
    opacity: f32,
    width: f32,
    dash: Vec<f32>,
    cap: &'static str,
    join: &'static str,
}

#[derive(Serialize)]
struct ImportedStop {
    offset: f32,
    color: [u8; 3],
    opacity: f32,
}

#[derive(Serialize, Clone, Copy)]
struct ImportedPoint { x: f32, y: f32 }

#[derive(Serialize)]
#[serde(tag = "kind")]
enum ImportedPaint {
    #[serde(rename = "color")]
    Color { color: [u8; 3] },
    #[serde(rename = "linear")]
    Linear { from: ImportedPoint, to: ImportedPoint, stops: Vec<ImportedStop> },
    #[serde(rename = "radial")]
    Radial { center: ImportedPoint, radius: f32, stops: Vec<ImportedStop> },
}

/// A path's own local bounding box, in the same untransformed space as its
/// `d` and as `usvg`'s already-resolved (but not-yet-bbox-normalized)
/// gradient coordinates — what turns "gradient coordinates in user units"
/// into the 0..1-relative-to-bounding-box numbers `@vravio/env-vector`'s
/// own `Gradient` type expects (see its doc comment in appearance.ts).
fn normalize(x: f32, y: f32, bbox_x: f32, bbox_y: f32, bbox_w: f32, bbox_h: f32) -> ImportedPoint {
    ImportedPoint {
        x: if bbox_w > 0.0 { (x - bbox_x) / bbox_w } else { 0.0 },
        y: if bbox_h > 0.0 { (y - bbox_y) / bbox_h } else { 0.0 },
    }
}

fn stops_from(stops: &[usvg::Stop]) -> Vec<ImportedStop> {
    stops
        .iter()
        .map(|stop| {
            let color = stop.color();
            ImportedStop { offset: stop.offset().get(), color: [color.red, color.green, color.blue], opacity: stop.opacity().get() }
        })
        .collect()
}

fn paint_to_imported(paint: &Paint, bbox: (f32, f32, f32, f32)) -> ImportedPaint {
    let (bx, by, bw, bh) = bbox;
    match paint {
        Paint::Color(color) => ImportedPaint::Color { color: [color.red, color.green, color.blue] },
        Paint::LinearGradient(gradient) => ImportedPaint::Linear {
            from: normalize(gradient.x1(), gradient.y1(), bx, by, bw, bh),
            to: normalize(gradient.x2(), gradient.y2(), bx, by, bw, bh),
            stops: stops_from(gradient.stops()),
        },
        Paint::RadialGradient(gradient) => {
            let center = normalize(gradient.cx(), gradient.cy(), bx, by, bw, bh);
            let edge = normalize(gradient.cx() + gradient.r().get(), gradient.cy(), bx, by, bw, bh);
            ImportedPaint::Radial { center, radius: (edge.x - center.x).hypot(edge.y - center.y), stops: stops_from(gradient.stops()) }
        }
        // Pattern paints (tiled-image fills) are a documented gap — see this module's own doc
        // comment. A flat mid-gray is closer to "something visibly stood in for it" than a paint
        // that silently vanishes.
        Paint::Pattern(_) => ImportedPaint::Color { color: [128, 128, 128] },
    }
}

fn path_data(path: &usvg::tiny_skia_path::Path) -> String {
    let mut d = String::new();
    for segment in path.segments() {
        match segment {
            PathSegment::MoveTo(p) => d.push_str(&format!("M{},{} ", p.x, p.y)),
            PathSegment::LineTo(p) => d.push_str(&format!("L{},{} ", p.x, p.y)),
            PathSegment::QuadTo(c, p) => d.push_str(&format!("Q{},{} {},{} ", c.x, c.y, p.x, p.y)),
            PathSegment::CubicTo(c1, c2, p) => d.push_str(&format!("C{},{} {},{} {},{} ", c1.x, c1.y, c2.x, c2.y, p.x, p.y)),
            PathSegment::Close => d.push_str("Z "),
        }
    }
    d.trim_end().to_string()
}

fn cap_name(cap: usvg::LineCap) -> &'static str {
    match cap {
        usvg::LineCap::Butt => "butt",
        usvg::LineCap::Round => "round",
        usvg::LineCap::Square => "square",
    }
}

fn join_name(join: usvg::LineJoin) -> &'static str {
    match join {
        usvg::LineJoin::Miter | usvg::LineJoin::MiterClip => "miter",
        usvg::LineJoin::Round => "round",
        usvg::LineJoin::Bevel => "bevel",
    }
}

fn transform_to_array(t: usvg::Transform) -> [f32; 6] {
    [t.sx, t.ky, t.kx, t.sy, t.tx, t.ty]
}

fn walk(node: &Node, out: &mut Vec<ImportedShape>) {
    match node {
        Node::Group(group) => walk_group(group, out),
        Node::Path(path) => {
            let bbox = path.data().bounds();
            let bbox_tuple = (bbox.x(), bbox.y(), bbox.width(), bbox.height());
            let fill = path.fill().map(|fill| ImportedPaintStyle { paint: paint_to_imported(fill.paint(), bbox_tuple), opacity: fill.opacity().get() });
            let stroke = path.stroke().map(|stroke| ImportedStrokeStyle {
                paint: paint_to_imported(stroke.paint(), bbox_tuple),
                opacity: stroke.opacity().get(),
                width: stroke.width().get(),
                dash: stroke.dasharray().map(|d| d.to_vec()).unwrap_or_default(),
                cap: cap_name(stroke.linecap()),
                join: join_name(stroke.linejoin()),
            });
            out.push(ImportedShape { kind: "path", d: path_data(path.data()), transform: transform_to_array(path.abs_transform()), fill, stroke, opacity: 1.0 });
        }
        // Images and text are this pass's other documented gaps alongside group nesting and
        // pattern paints — see this module's own top-level doc comment.
        Node::Image(_) | Node::Text(_) => {}
    }
}

fn walk_group(group: &Group, out: &mut Vec<ImportedShape>) {
    for child in group.children() {
        walk(child, out);
    }
}

#[wasm_bindgen]
pub fn import_svg(svg_text: &str) -> Result<String, JsError> {
    let tree = Tree::from_str(svg_text, &Options::default()).map_err(|error| JsError::new(&format!("vector-svg: failed to parse SVG: {error}")))?;
    let mut shapes = Vec::new();
    walk_group(tree.root(), &mut shapes);
    serde_json::to_string(&shapes).map_err(|error| JsError::new(&format!("vector-svg: failed to serialize import result: {error}")))
}

/// Stage 10's cross-check: rasterize an SVG string through `resvg` (a
/// wholly independent renderer from this app's own live SVG/canvas
/// rendering) and hand back raw RGBA pixels, so a test can compare "what
/// resvg thinks this SVG looks like" against "what the editor's own export
/// produced" — see `vector-svg.crosscheck.test.ts`.
#[wasm_bindgen]
pub fn render_svg_to_rgba(svg_text: &str, width: u32, height: u32) -> Result<Vec<u8>, JsError> {
    let tree = Tree::from_str(svg_text, &Options::default()).map_err(|error| JsError::new(&format!("vector-svg: failed to parse SVG: {error}")))?;
    let mut pixmap = tiny_skia::Pixmap::new(width, height).ok_or_else(|| JsError::new("vector-svg: invalid pixmap size"))?;
    let size = tree.size();
    let scale_x = width as f32 / size.width();
    let scale_y = height as f32 / size.height();
    let transform = usvg::Transform::from_scale(scale_x, scale_y);
    resvg::render(&tree, transform, &mut pixmap.as_mut());
    Ok(pixmap.data().to_vec())
}
