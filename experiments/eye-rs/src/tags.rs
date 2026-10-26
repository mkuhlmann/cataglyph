// Raw `photo` outputs → calibrated tag confidences and scores, driven by eye_meta.json:
// each entry of `tags.model` names an output, an index (or several), and a piecewise-linear
// calibration curve from probability to confidence; `tags.scores` gives median and scale
// per score.
//
// The tag outputs (type, reject, sensitive, scenes, rotation) leave the model as
// probabilities already: softmax and sigmoid are part of the graph. A first version applied
// a sigmoid on top and every scene tag landed near 0.55. Only the score heads (aesthetic,
// keeper, cover) and focus are raw logits.

use std::collections::{BTreeMap, HashMap};

use anyhow::{Context, Result};
use serde_json::Value;

pub type Outputs = HashMap<String, Vec<f32>>;

/// Linear between the points; flat beyond the ends. Curves repeat x values at steps.
fn curve(points: &[(f64, f64)], x: f64) -> f64 {
    let Some(&(x0, y0)) = points.first() else { return x };
    if x <= x0 {
        return y0;
    }
    for pair in points.windows(2) {
        let ((xa, ya), (xb, yb)) = (pair[0], pair[1]);
        if x <= xb {
            if xb <= xa {
                return yb;
            }
            return ya + (yb - ya) * (x - xa) / (xb - xa);
        }
    }
    points.last().map(|p| p.1).unwrap_or(x)
}

pub struct TagModel {
    tags: Vec<TagEntry>,
    scores: Vec<(String, String, f64, f64)>,
    pub recommended: f64,
}

struct TagEntry {
    id: String,
    output: String,
    indices: Vec<usize>,
    /// "rotated": the photo is turned, i.e. not the 0° class.
    turned: bool,
    curve: Vec<(f64, f64)>,
}

impl TagModel {
    pub fn from_meta(meta: &Value) -> Result<Self> {
        let tags = meta["tags"]["model"].as_array().context("tags.model")?;
        let mut entries = Vec::new();
        for t in tags {
            let indices = match (&t["indices"], &t["index"]) {
                (Value::Array(list), _) => list.iter().filter_map(|v| v.as_u64()).map(|v| v as usize).collect(),
                (_, Value::Number(n)) => vec![n.as_u64().context("index")? as usize],
                _ => vec![],
            };
            let curve = t["curve"]
                .as_array()
                .context("curve")?
                .iter()
                .filter_map(|p| Some((p[0].as_f64()?, p[1].as_f64()?)))
                .collect();
            entries.push(TagEntry {
                id: t["id"].as_str().context("id")?.to_string(),
                output: t["output"].as_str().context("output")?.to_string(),
                indices,
                turned: t["turned"].as_bool().unwrap_or(false),
                curve,
            });
        }
        let scores = meta["tags"]["scores"]
            .as_object()
            .context("tags.scores")?
            .iter()
            .map(|(name, s)| {
                (
                    name.clone(),
                    s["output"].as_str().unwrap_or(name).to_string(),
                    s["median"].as_f64().unwrap_or(0.0),
                    s["scale"].as_f64().unwrap_or(1.0),
                )
            })
            .collect();
        let recommended = meta["tags"]["levels"]["recommended"].as_f64().unwrap_or(0.5);
        Ok(Self { tags: entries, scores, recommended })
    }

    pub fn tags(&self, outputs: &Outputs) -> BTreeMap<String, f64> {
        let mut out = BTreeMap::new();
        for t in &self.tags {
            let Some(p) = outputs.get(&t.output) else { continue };
            let x = if t.turned {
                1.0 - p.first().copied().unwrap_or(1.0) as f64
            } else {
                t.indices.iter().filter_map(|&i| p.get(i)).map(|&v| v as f64).sum()
            };
            out.insert(t.id.clone(), curve(&t.curve, x));
        }
        out
    }

    /// sigmoid((logit - median) / scale): centred on the training set's median photo.
    pub fn scores(&self, outputs: &Outputs) -> BTreeMap<String, f64> {
        let mut out = BTreeMap::new();
        for (name, output, median, scale) in &self.scores {
            let Some(&raw) = outputs.get(output).and_then(|v| v.first()) else { continue };
            out.insert(name.clone(), 1.0 / (1.0 + (-((raw as f64 - median) / scale)).exp()));
        }
        out
    }
}
