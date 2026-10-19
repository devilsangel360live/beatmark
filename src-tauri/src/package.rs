//! The `.beatmark` project package: a zip holding `project.json` and `sources/*.png`.

use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

pub const PROJECT_ENTRY: &str = "project.json";
pub const SOURCES_DIR: &str = "sources";

/// Writes the package next to `dest`, then renames it into place, so a crash
/// mid-save never leaves a half-written project.
pub fn write_package(dest: &Path, project_json: &str, sources_dir: &Path) -> Result<(), String> {
    let parent = dest.parent().ok_or("Invalid save location")?;
    let tmp = parent.join(format!(".{}.saving", uuid::Uuid::new_v4()));
    let result = write_zip(&tmp, project_json, sources_dir).and_then(|_| {
        fs::rename(&tmp, dest).map_err(|e| format!("Could not replace {}: {e}", dest.display()))
    });
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

fn write_zip(path: &Path, project_json: &str, sources_dir: &Path) -> Result<(), String> {
    let file = File::create(path).map_err(|e| format!("Could not create file: {e}"))?;
    let mut zip = ZipWriter::new(file);
    let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    // PNGs are already compressed.
    let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    let err = |e: zip::result::ZipError| e.to_string();

    zip.start_file(PROJECT_ENTRY, deflated).map_err(err)?;
    zip.write_all(project_json.as_bytes()).map_err(|e| e.to_string())?;

    if sources_dir.is_dir() {
        for entry in fs::read_dir(sources_dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if !entry.file_type().map_err(|e| e.to_string())?.is_file() || !is_safe_name(&name) {
                continue;
            }
            zip.start_file(format!("{SOURCES_DIR}/{name}"), stored).map_err(err)?;
            zip.write_all(&fs::read(entry.path()).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        }
    }
    zip.finish().map_err(err)?.sync_all().map_err(|e| e.to_string())
}

/// Reads `project.json` and copies the package's source images into `sources_dir`.
/// Only `project.json` and plain files directly under `sources/` are accepted.
pub fn read_package(path: &Path, sources_dir: &Path) -> Result<String, String> {
    let file = File::open(path).map_err(|e| format!("Could not open {}: {e}", path.display()))?;
    let mut zip = ZipArchive::new(file).map_err(|_| "This file is not a Beatmark project.".to_string())?;
    fs::create_dir_all(sources_dir).map_err(|e| e.to_string())?;

    let mut project = None;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        if !entry.is_file() {
            continue;
        }
        let Ok(name) = entry.name().map(|n| n.into_owned()) else {
            continue;
        };
        if name == PROJECT_ENTRY {
            let mut s = String::new();
            entry.read_to_string(&mut s).map_err(|e| e.to_string())?;
            project = Some(s);
        } else if let Some(file_name) = name.strip_prefix(&format!("{SOURCES_DIR}/")) {
            if is_safe_name(file_name) {
                let mut out = File::create(sources_dir.join(file_name)).map_err(|e| e.to_string())?;
                std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
            }
        }
    }
    project.ok_or_else(|| "The project file is missing its score data.".to_string())
}

/// A bare file name with no path components.
pub fn is_safe_name(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('.')
        && PathBuf::from(name).file_name().map(|f| f == name).unwrap_or(false)
        && !name.contains(['/', '\\', ':'])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_project_and_sources() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("a.png"), b"png-bytes").unwrap();
        let dest = dir.path().join("song.beatmark");

        write_package(&dest, r#"{"schemaVersion":1}"#, &src).unwrap();
        let out = dir.path().join("out");
        let json = read_package(&dest, &out).unwrap();

        assert_eq!(json, r#"{"schemaVersion":1}"#);
        assert_eq!(fs::read(out.join("a.png")).unwrap(), b"png-bytes");
        // The temporary file was renamed away.
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 3);
    }

    #[test]
    fn ignores_entries_outside_sources() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("evil.beatmark");
        let mut zip = ZipWriter::new(File::create(&path).unwrap());
        let opts = SimpleFileOptions::default();
        zip.start_file(PROJECT_ENTRY, opts).unwrap();
        zip.write_all(b"{}").unwrap();
        zip.start_file("sources/../../escape.txt", opts).unwrap();
        zip.write_all(b"x").unwrap();
        zip.finish().unwrap();

        let out = dir.path().join("out");
        read_package(&path, &out).unwrap();
        assert!(!dir.path().join("escape.txt").exists());
        assert_eq!(fs::read_dir(&out).unwrap().count(), 0);
    }

    #[test]
    fn rejects_path_like_names() {
        assert!(is_safe_name("page-1.png"));
        for bad in ["", "../x.png", "a/b.png", "a\\b.png", ".hidden", "C:x.png"] {
            assert!(!is_safe_name(bad), "{bad}");
        }
    }
}
