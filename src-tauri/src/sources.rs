//! Importing score images. Originals are only read, never modified (FR-IMP-05).

use std::path::Path;

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedSource {
    pub id: String,
    pub file_name: String,
    pub original_name: String,
    pub width: u32,
    pub height: u32,
}

/// Decodes PNG/JPEG/TIFF and stores a PNG copy in `sources_dir`. Normalizing to PNG
/// matters because WebView2 on Windows cannot display TIFF.
pub fn import_image(path: &Path, sources_dir: &Path) -> Result<ImportedSource, String> {
    let original_name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let img = image::ImageReader::open(path)
        .map_err(|e| format!("Could not open {original_name}: {e}"))?
        .with_guessed_format()
        .map_err(|e| e.to_string())?
        .decode()
        .map_err(|e| format!("{original_name} is not a readable PNG, JPEG or TIFF image ({e})."))?;

    std::fs::create_dir_all(sources_dir).map_err(|e| e.to_string())?;
    let id = uuid::Uuid::new_v4().to_string();
    let file_name = format!("{id}.png");
    img.save_with_format(sources_dir.join(&file_name), image::ImageFormat::Png)
        .map_err(|e| format!("Could not store the imported image: {e}"))?;

    Ok(ImportedSource { id, file_name, original_name, width: img.width(), height: img.height() })
}

/// Stores PNG bytes rendered elsewhere (e.g. a PDF page rendered by pdf.js in the UI).
pub fn import_png_bytes(bytes: &[u8], original_name: &str, sources_dir: &Path) -> Result<ImportedSource, String> {
    let img = image::load_from_memory_with_format(bytes, image::ImageFormat::Png)
        .map_err(|e| format!("Rendered page is not a valid PNG: {e}"))?;
    std::fs::create_dir_all(sources_dir).map_err(|e| e.to_string())?;
    let id = uuid::Uuid::new_v4().to_string();
    let file_name = format!("{id}.png");
    std::fs::write(sources_dir.join(&file_name), bytes).map_err(|e| e.to_string())?;
    Ok(ImportedSource {
        id,
        file_name,
        original_name: original_name.to_string(),
        width: img.width(),
        height: img.height(),
    })
}
