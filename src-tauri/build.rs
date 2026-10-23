fn main() {
    link_clang_runtime_on_macos();
    tauri_build::build()
}

/// ONNX Runtime's prebuilt static library (from the `ort` crate) calls
/// `__isPlatformVersionAtLeast`, which lives in clang's runtime library. Clang links that
/// automatically, but rustc links with -nodefaultlibs, so add it explicitly.
fn link_clang_runtime_on_macos() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    let out = std::process::Command::new("xcrun").args(["clang", "--print-runtime-dir"]).output();
    match out {
        Ok(o) if o.status.success() => {
            let dir = String::from_utf8_lossy(&o.stdout).trim().to_string();
            println!("cargo:rustc-link-search=native={dir}");
            println!("cargo:rustc-link-lib=static=clang_rt.osx");
        }
        _ => println!("cargo:warning=Could not locate clang's runtime library; linking ONNX Runtime may fail. Is Xcode installed?"),
    }
}
