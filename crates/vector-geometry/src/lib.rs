use geo_booleanop::boolean::BooleanOp;
use geo_types::{Coordinate, LineString, Polygon};
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
