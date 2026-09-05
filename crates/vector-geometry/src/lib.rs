use geo_booleanop::boolean::BooleanOp;
use geo_types::{Coordinate, LineString, Polygon};
use kurbo::{simplify::simplify_bezpath, BezPath, Cap, Diagonal2, Join, Stroke, StrokeOpts};
use wasm_bindgen::prelude::*;

/// A closed polygon as a flat `[x0, y0, x1, y1, ...]` array — no repeated
/// first point, no holes. This is the exact wire shape `VectorGeometryPort`
/// (`@vravio/kernel`'s `vector-geometry-port.ts`) declares for every
/// implementation, TS reference and this WASM one alike, so the two can be
/// swapped for each other or cross-checked without either side knowing the
/// other's internals.
fn polygon_from_flat(flat: &[f64]) -> Polygon<f64> {
    let coords: Vec<Coordinate<f64>> = flat
        .chunks_exact(2)
        .map(|pair| Coordinate { x: pair[0], y: pair[1] })
        .collect();
    Polygon::new(LineString::from(coords), vec![])
}

/// Encodes a `MultiPolygon` (a boolean op can split one shape into several,
/// e.g. subtracting a bar out of the middle of a ring) into a single flat
/// `Vec<f64>`, since wasm-bindgen has no built-in `Vec<Vec<f64>>` — the
/// header scheme is `[polygonCount, len0, x0, y0, ..., len1, x0, y0, ...]`.
/// Holes are dropped: this stage's boolean ops produce holeless output
/// polygons only, same simplification the TS reference makes (see
/// `vector-geometry-port.ts`'s own doc comment for why that's an honest gap,
/// not a silent one).
fn encode_multi(polygons: &[Polygon<f64>]) -> Vec<f64> {
    let mut out = vec![polygons.len() as f64];
    for polygon in polygons {
        let mut points: Vec<(f64, f64)> = polygon.exterior().points_iter().map(|p| (p.x(), p.y())).collect();
        // geo's rings repeat the first point at the end to close the loop;
        // the wire format doesn't, so drop the duplicate if present.
        if points.len() > 1 && points[0] == points[points.len() - 1] {
            points.pop();
        }
        out.push(points.len() as f64);
        for (x, y) in points {
            out.push(x);
            out.push(y);
        }
    }
    out
}

#[wasm_bindgen]
pub fn boolean_op(kind: &str, subject: &[f64], clip: &[f64]) -> Vec<f64> {
    let a = polygon_from_flat(subject);
    let b = polygon_from_flat(clip);
    let result = match kind {
        "union" => a.union(&b),
        "subtract" => a.difference(&b),
        "intersect" => a.intersection(&b),
        "exclude" => a.xor(&b),
        other => panic!("vector-geometry: unknown boolean op {other}"),
    };
    encode_multi(&result.0)
}

/// Stage 8 of docs/vector-plan.md: "curves stay curves" — offset, stroke-to-
/// fill, and simplify all go through Kurbo (the plan's own choice of
/// library), reading and writing the same SVG path-data string
/// `@vravio/env-vector`'s own `pathData()` already produces and consumes.
/// Reusing that format instead of inventing a flat-array wire shape (like
/// `boolean_op`'s above) means the TS side needs zero new encoding/decoding
/// logic to call these — a bezier path was already a string everywhere
/// else in this codebase.
///
/// Unlike Stage 7's boolean ops, this stage's plan doesn't ask for a second,
/// independent implementation to cross-check — Kurbo is named as *the*
/// implementation, not *a* reference one, so there is no TS-side twin here
/// to stay honest against.
fn parse_path(d: &str) -> BezPath {
    BezPath::from_svg(d).unwrap_or_else(|error| panic!("vector-geometry: invalid path data {d:?}: {error}"))
}

fn join_from_str(join: &str) -> Join {
    match join {
        "round" => Join::Round,
        "bevel" => Join::Bevel,
        _ => Join::Miter,
    }
}

fn cap_from_str(cap: &str) -> Cap {
    match cap {
        "round" => Cap::Round,
        "square" => Cap::Square,
        _ => Cap::Butt,
    }
}

/// Grows (positive `amount`) or shrinks (negative) a filled shape by a
/// uniform distance — the "offset path" bullet. `tolerance` is Kurbo's own
/// accuracy knob for how closely the (possibly curved) joins approximate
/// the true offset curve; it is not a node-count knob the way `simplify`'s
/// `accuracy` is.
#[wasm_bindgen]
pub fn offset_path(d: &str, amount: f64, join: &str, tolerance: f64) -> String {
    let path = parse_path(d);
    kurbo::expand_path(path, Diagonal2::new(amount, amount), join_from_str(join), 10.0, tolerance).to_svg()
}

/// Turns a stroked line into the filled shape it would visually paint as —
/// the "stroke to path" bullet. Once this runs, "stroke" is no longer a
/// live style property of the result; the width/cap/join/dash have all been
/// baked into geometry, same as Illustrator's own "Outline Stroke".
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn stroke_to_fill(d: &str, width: f64, cap: &str, join: &str, miter_limit: f64, dash: &[f64], dash_offset: f64, tolerance: f64) -> String {
    let path = parse_path(d);
    let style = Stroke::new(width).with_caps(cap_from_str(cap)).with_join(join_from_str(join)).with_miter_limit(miter_limit).with_dashes(dash_offset, dash.to_vec());
    kurbo::stroke(&path, &style, &StrokeOpts::default(), tolerance).to_svg()
}

/// Reduces the number of nodes in a path while staying within `accuracy` of
/// the original shape — genuinely redundant points (near-collinear runs, a
/// hand-drawn path with far more samples than its actual curvature needs)
/// collapse a lot; a real corner never does, on purpose (`SimplifyOptions`'
/// default angle threshold treats any non-negligible turn as an intentional
/// corner to preserve exactly, not noise to smooth away).
///
/// That preserve-corners default is *not* enough, on its own, to satisfy
/// this stage's other bullet — turning `boolean_op`'s straight-line polygon
/// output back into curves. A flattened circle is, vertex-for-vertex,
/// indistinguishable from a polygon someone drew on purpose with that many
/// sides: every turn between its ~5° segments reads as "corner," so this
/// function barely reduces it (measured: a 64-gon circle stayed at 65 path
/// commands from accuracy 0.01 all the way to 10 — 10% of its own radius —
/// and a hand-tuned wider angle threshold only got a union-of-two-circles
/// output down to the tens, not the single digits the plan's own measurement
/// goal asks for). Real reverse-curve-fitting needs least-squares Bezier
/// fitting through the point sequence (Kurbo's `fit_to_bezpath` via a custom
/// `ParamCurveFit`), not corner-preserving simplification — deferred; see
/// `vector-geometry.curves.test.ts` and vector-plan.md's Stage 8 write-up
/// for the measured numbers this leaves honestly unresolved.
#[wasm_bindgen]
pub fn simplify_path(d: &str, accuracy: f64) -> String {
    let path = parse_path(d);
    simplify_bezpath(&path, accuracy, &Default::default()).to_svg()
}
