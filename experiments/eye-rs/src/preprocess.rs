// The `photo` input, as eye_meta.json describes it: float RGB in 0..1, (1, 3, 384, 384),
// "384x384 centre crop (resize the short side to 384, bicubic)". Normalisation is inside
// the model, so this is only geometry and a /255.

use std::path::Path;

use anyhow::Result;
use image::imageops::FilterType;
use image::{DynamicImage, ImageDecoder, ImageReader};

pub const PHOTO_EDGE: u32 = 384;

/// Decodes with the EXIF orientation applied: camera JPEGs shot in portrait are stored
/// landscape plus an Orientation tag, and the model would see them sideways.
pub fn load(path: &Path) -> Result<DynamicImage> {
    let mut decoder = ImageReader::open(path)?.with_guessed_format()?.into_decoder()?;
    let orientation = decoder.orientation()?;
    let mut img = DynamicImage::from_decoder(decoder)?;
    img.apply_orientation(orientation);
    Ok(img)
}

/// Planar (NCHW) float32 for the `photo` signature.
pub fn photo_input(img: &DynamicImage) -> Vec<f32> {
    let (w, h) = (img.width(), img.height());
    let scale = PHOTO_EDGE as f64 / w.min(h) as f64;
    let (rw, rh) = (
        ((w as f64 * scale).round() as u32).max(PHOTO_EDGE),
        ((h as f64 * scale).round() as u32).max(PHOTO_EDGE),
    );
    // Bicubic straight from a 60 MP original is slow and aliases less than it should;
    // a cheap halving pass first keeps the final bicubic step at a sane ratio.
    let mut src = img.clone();
    while src.width() / 2 >= rw * 2 && src.height() / 2 >= rh * 2 {
        src = src.resize_exact(src.width() / 2, src.height() / 2, FilterType::Triangle);
    }
    let resized = src.resize_exact(rw, rh, FilterType::CatmullRom).to_rgb8();
    let (x0, y0) = ((rw - PHOTO_EDGE) / 2, (rh - PHOTO_EDGE) / 2);

    let plane = (PHOTO_EDGE * PHOTO_EDGE) as usize;
    let mut out = vec![0f32; 3 * plane];
    for y in 0..PHOTO_EDGE {
        for x in 0..PHOTO_EDGE {
            let px = resized.get_pixel(x0 + x, y0 + y);
            let i = (y * PHOTO_EDGE + x) as usize;
            for c in 0..3 {
                out[c * plane + i] = px[c] as f32 / 255.0;
            }
        }
    }
    out
}
