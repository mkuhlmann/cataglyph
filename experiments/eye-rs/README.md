# eye-rs (experiment)

Eye's `photo` function on LiteRT directly from Rust (`litert-sys`), without the Desert Ant
Labs SDK. A feasibility test, not part of the app.

```sh
cargo build --release
./target/release/eye-rs ../../models <folder> [--cpu] [--gpu-toml '<gpu_options>'] [--raw] \
    [--compare reference.json]
```

`../../models` is what `bun run vendor` downloads (`eye.tflite`, `eye_meta.json`). The first
build downloads LiteRT's prebuilt `libLiteRt.so` and WebGPU accelerator into
`~/.cache/litert-sys`; `build.rs` puts that directory on the binary's rpath.

## What it does

- Decodes JPEG/PNG with EXIF orientation, resizes the short side to 384 (bicubic),
  centre-crops 384×384, float32 NCHW in 0..1 (`src/preprocess.rs`).
- Runs the `photo` signature on the GPU, falling back to the CPU if a run fails or returns
  non-finite outputs (`src/runtime.rs`).
- Turns outputs into tag confidences with the calibration curves in `eye_meta.json`
  (`src/tags.rs`). The tag outputs are already probabilities; don't apply a sigmoid.
- `--compare` takes the JS SDK's analyses of the same photos (`{ "<file>": Analysis }`)
  and reports the differences.

## Findings (Intel Arc, Meteor Lake, Mesa 26.2 with the Xe KMD)

- LiteRT's default GPU precision returns NaN in every output; the SDK reports this as "the
  model failed to run". `gpu_options` `precision = 2` (fp32, now the default here) matches
  the CPU: ~110 ms per photo on the GPU vs ~610 ms on the CPU.
- Tags vs the SDK over 7 photos: mean |diff| ≈ 0.005 over ~590 values, worst 0.17; the
  tags above 0.5 agree except for a few at the threshold.
- Not covered: the SDK's keeper/cover/aesthetic scores (they also weigh flaws in code
  compiled into the SDK and not described in `eye_meta.json`), and everything from the
  other signatures (faces, sharpness → `sharp`/`blurry`, spatial, duplicates).
- The safe `litert` crate (0.2.1) was dropped: it exposes no signature/tensor names and
  no way to attach accelerator options.

## License

This runs the Eye weights without the SDK, so no usage telemetry is sent. The weights'
Hugging Face `LICENSE.md` has no telemetry clause, but the SDK's authoritative license
(https://license.desertant.com/1.0) does. Don't ship this in the app before Desert Ant Labs
has confirmed it's fine.
