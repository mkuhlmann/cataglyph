// MVP: Eye's `photo` function on LiteRT directly (litert-sys) instead of the Desert Ant
// Labs SDK.
//
//   eye-rs <model dir> <photo folder> [--cpu] [--gpu-toml '<gpu_options>'] [--raw]
//          [--compare reference.json]
//
// <model dir> holds eye.tflite and eye_meta.json (`bun run vendor` puts them in models/).
// Prints the tags above the recommended level per photo. --compare reads the JS SDK's
// analyses of the same photos and reports how far each number is off.

mod preprocess;
mod runtime;
mod tags;

use std::path::{Path, PathBuf};
use std::time::Instant;

use anyhow::{Context, Result, bail};
use serde_json::Value;

use runtime::{Accelerator, Runtime};
use tags::TagModel;

fn photos_in(dir: &Path) -> Result<Vec<PathBuf>> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| matches!(e.to_ascii_lowercase().as_str(), "jpg" | "jpeg" | "png"))
        })
        .collect();
    files.sort();
    Ok(files)
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let positional: Vec<&String> = args.iter().filter(|a| !a.starts_with("--")).collect();
    let (Some(model_dir), Some(folder)) = (positional.first(), positional.get(1)) else {
        bail!("usage: eye-rs <model dir> <photo folder> [--cpu] [--compare reference.json]");
    };
    let cpu_only = args.iter().any(|a| a == "--cpu");
    let compare = args
        .iter()
        .position(|a| a == "--compare")
        .and_then(|i| args.get(i + 1))
        .map(|p| -> Result<Value> { Ok(serde_json::from_str(&std::fs::read_to_string(p)?)?) })
        .transpose()?;

    // fp32: with LiteRT's default GPU precision every output came back NaN on Intel Arc
    // (Mesa, Xe KMD); `precision = 2` (kLiteRtDelegatePrecisionFp32) gives the CPU's results
    // at ~110 vs ~610 ms per photo. Strings ("fp32") fail to parse; the value is the enum.
    let gpu_toml = args
        .iter()
        .position(|a| a == "--gpu-toml")
        .and_then(|i| args.get(i + 1))
        .cloned()
        .unwrap_or_else(|| "precision = 2".to_string());

    let model_dir = PathBuf::from(model_dir);
    let model_path = model_dir.join("eye.tflite");
    let meta: Value = serde_json::from_str(&std::fs::read_to_string(model_dir.join("eye_meta.json"))?)?;
    let tag_model = TagModel::from_meta(&meta)?;
    let photos = photos_in(Path::new(folder))?;
    let first = photos.first().context("no JPEG/PNG in that folder")?;

    let started = Instant::now();
    let load_cpu = || Runtime::load(&model_path, "photo", &Accelerator::Cpu);
    let (mut photo, accelerator) = if cpu_only {
        (load_cpu()?, "cpu")
    } else {
        // The GPU path can compile fine and then fail, or return NaN, on every run (Intel
        // Arc with Mesa's Xe driver, see the app's session.ts). Prove it on the first photo.
        let pixels = preprocess::photo_input(&preprocess::load(first)?);
        let toml = Some(gpu_toml).filter(|t| !t.is_empty());
        match Runtime::load(&model_path, "photo", &Accelerator::Gpu(toml))
            .and_then(|mut rt| rt.run(&pixels).map(|_| rt))
        {
            Ok(rt) => (rt, "gpu"),
            Err(err) => {
                eprintln!("GPU unusable ({err:#}), falling back to CPU");
                (load_cpu()?, "cpu")
            }
        }
    };
    println!("model ready on {accelerator} in {} ms\n", started.elapsed().as_millis());

    let mut worst: Vec<(f64, String, String, f64, f64)> = Vec::new();
    let mut run_ms = Vec::new();
    for path in &photos {
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        let t0 = Instant::now();
        let pixels = preprocess::photo_input(&preprocess::load(path)?);
        let t1 = Instant::now();
        let outputs = photo.run(&pixels)?;
        let t2 = Instant::now();
        run_ms.push(t2.duration_since(t1).as_secs_f64() * 1000.0);
        if args.iter().any(|a| a == "--raw") {
            for key in ["type", "reject", "rotation", "sensitive", "keeper", "aesthetic", "focus"] {
                let v = &outputs[key];
                println!("  raw {key}: {:?}", v.iter().map(|x| (x * 1000.0).round() / 1000.0).collect::<Vec<_>>());
            }
            let s = &outputs["scenes"];
            println!("  raw scenes: min {:.3} max {:.3} mean {:.3}", s.iter().cloned().fold(f32::MAX, f32::min), s.iter().cloned().fold(f32::MIN, f32::max), s.iter().sum::<f32>() / s.len() as f32);
        }
        let tags = tag_model.tags(&outputs);
        let scores = tag_model.scores(&outputs);

        let mut shown: Vec<(&String, &f64)> = tags.iter().filter(|(_, c)| **c >= tag_model.recommended).collect();
        shown.sort_by(|a, b| b.1.total_cmp(a.1));
        println!(
            "{name}  decode+prep {:.0} ms, run {:.0} ms",
            t1.duration_since(t0).as_secs_f64() * 1000.0,
            t2.duration_since(t1).as_secs_f64() * 1000.0,
        );
        // Not the SDK's scores: its keeper/cover/aesthetic also weigh flaws found elsewhere
        // (keeper fell to 0.01 on a blurry photo whose keeper logit alone gave 0.58), in code
        // compiled into its native core that eye_meta.json doesn't describe.
        println!(
            "  logit scores (not SDK-equivalent): {}",
            scores.iter().map(|(k, v)| format!("{k} {v:.3}")).collect::<Vec<_>>().join(", ")
        );
        println!(
            "  tags:   {}",
            shown.iter().map(|(k, v)| format!("{k} {v:.2}")).collect::<Vec<_>>().join(", ")
        );

        if let Some(reference) = compare.as_ref().and_then(|r| r.get(&name)) {
            let mut diffs = Vec::new();
            for (key, &mine) in tags.iter() {
                if let Some(js) = reference["tags"].get(key).and_then(Value::as_f64) {
                    diffs.push(((mine - js).abs(), key.clone(), mine, js));
                }
            }
            let n = diffs.len();
            let mean = diffs.iter().map(|d| d.0).sum::<f64>() / n.max(1) as f64;
            diffs.sort_by(|a, b| b.0.total_cmp(&a.0));
            let ref_tags: Vec<&str> = reference["tags"]
                .as_object()
                .map(|o| o.iter().filter(|(_, v)| v.as_f64().unwrap_or(0.0) >= tag_model.recommended).map(|(k, _)| k.as_str()).collect())
                .unwrap_or_default();
            let ours_set: Vec<&str> = shown.iter().map(|(k, _)| k.as_str()).collect();
            let missing: Vec<&&str> = ref_tags.iter().filter(|t| !ours_set.contains(t)).collect();
            let extra: Vec<&&str> = ours_set.iter().filter(|t| !ref_tags.contains(t)).collect();
            println!("  vs JS:  {n} values, mean |diff| {mean:.4}, max {:.4} ({})", diffs[0].0, diffs[0].1);
            println!("          tags only in JS: {missing:?}, only here: {extra:?}");
            for d in diffs.iter().take(3) {
                worst.push((d.0, name.clone(), d.1.clone(), d.2, d.3));
            }
        }
        println!();
    }

    if !run_ms.is_empty() {
        run_ms.sort_by(f64::total_cmp);
        println!("run time on {accelerator}: median {:.0} ms over {} photos", run_ms[run_ms.len() / 2], run_ms.len());
    }
    if !worst.is_empty() {
        worst.sort_by(|a, b| b.0.total_cmp(&a.0));
        println!("largest differences vs JS:");
        for (d, file, key, mine, js) in worst.iter().take(8) {
            println!("  {d:.4}  {file}  {key}: here {mine:.4}, JS {js:.4}");
        }
    }
    Ok(())
}
