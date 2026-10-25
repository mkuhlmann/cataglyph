# Third-party notices

Cataglyph's own source code is MIT-licensed (see `LICENSE`). The MIT license covers only
that code. Components the app depends on or ships with keep their own licenses, and in
particular **the Eye model and SDK are not MIT-licensed**.

## Eye by Desert Ant Labs (model weights and SDK)

The photo analysis uses **Eye by [Desert Ant Labs](https://desertant.com)**:
`@desert-ant-labs/eye` and `@desert-ant-labs/core` from npm, and the `eye.tflite` /
`eye_meta.json` weights from `huggingface.co/desert-ant-labs/eye` at revision v1.0.0.

- License: Desert Ant Labs Source-Available License 1.0
  (`LicenseRef-DAL-Source-Available-1.0`). Authoritative text:
  <https://license.desertant.com/1.0>. This is source-available, not open source.
- Copies of the license that came with these files are kept in place:
  `node_modules/@desert-ant-labs/*/LICENSE.md`, plus `models/LICENSE.md`, which is fetched
  together with the weights.
- Free below 100,000 monthly active devices per platform for each model. Above that you
  need a commercial license from Desert Ant Labs.
- You may not use the model, its outputs, or logs of them to train a competing model.
  You may not redistribute the model or SDK as a standalone product.
- Telemetry: the SDK sends a minimal usage signal to Desert Ant Labs so they can count
  active devices. It never contains images, analysis results, or user content. Do not
  tamper with it, since the license forbids that.
- Attribution (§9): the start screen shows "Powered by Eye from Desert Ant Labs 🐜", linked
  to <https://desertant.com/models/eye/>. The toolbar repeats the credit while an analysis
  is running.

This repository does not redistribute the weights: `bun run vendor` downloads them from
Hugging Face. The AppImage embeds them as part of the application, which the license
permits.

## Bundled in the AppImage

| Component | License | Notes |
|---|---|---|
| [Electron](https://www.electronjs.org) | MIT | app shell; its `LICENSE` ships in the `cataglyph/` directory of the AppImage |
| [Chromium](https://www.chromium.org) (inside Electron) | BSD-3-Clause (bundled components: various) | renderer; `LICENSES.chromium.html` ships in the `cataglyph/` directory of the AppImage |
| [Bun](https://bun.sh) | MIT (with bundled deps under their own terms) | runtime of the backend process, shipped as `resources/app/bin/bun` |
| [libjxl](https://github.com/libjxl/libjxl) `cjxl` 0.12.0 | BSD-3-Clause | statically linked libraries' licenses in `vendor/jxl/LICENSE.*` |
| [LiteRT](https://github.com/google-ai-edge/LiteRT) WebGPU accelerator 2.3.0 | Apache-2.0 | `vendor/litert/LICENSE` |
| [ExifTool](https://exiftool.org) by Phil Harvey (via `exiftool-vendored.pl`) | Perl (GPL-1.0+ or Artistic) | |
| [exiftool-vendored](https://github.com/photostructure/exiftool-vendored.js) | MIT | |
| [koffi](https://koffi.dev) | MIT | |
| [libheif-js](https://github.com/catdad-experiments/libheif-js) (libheif compiled to wasm) | LGPL-3.0 | unmodified; replaceable in `node_modules/libheif-js` |
| [jpeg-js](https://github.com/jpeg-js/jpeg-js) | BSD-3-Clause | |
| [Vue](https://vuejs.org) (compiled into the view) | MIT | |

Each npm package's own license file is included under `node_modules/` in the image.
