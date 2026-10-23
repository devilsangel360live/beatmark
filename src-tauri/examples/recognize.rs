//! Run recognition on page images from the command line and print the result as JSON.
//!
//!   cargo run --release --example recognize -- page1.png [page2.png …] > result.json

use std::path::{Path, PathBuf};

use beatmark_lib::omr::{self, Detector};

fn main() -> Result<(), String> {
    let model = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("models/drum-omr.onnx");
    let mut detector = Detector::load(&model)?;
    let mut pages = Vec::new();
    for arg in std::env::args().skip(1) {
        let started = std::time::Instant::now();
        let result = omr::recognize(Path::new(&arg), &mut detector)?;
        eprintln!("{arg}: {} staves in {:.1}s", result.staves.len(), started.elapsed().as_secs_f32());
        pages.push(result);
    }
    println!("{}", serde_json::to_string(&pages).map_err(|e| e.to_string())?);
    Ok(())
}
