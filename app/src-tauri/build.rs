use std::path::PathBuf;

fn main() {
    let mut attributes = tauri_build::Attributes::new();

    // Windows: Das Manifest (Common Controls v6) für ALLE Ziele einbetten – auch für die
    // Test-Programme von `cargo test`. Sonst fehlt dort z. B. `TaskDialogIndirect` und Windows
    // startet die Tests gar nicht (STATUS_ENTRYPOINT_NOT_FOUND). Tauri bettet sein Manifest
    // nur in die eigentliche Exe ein; deshalb hier selbst über den Linker.
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    if target_os == "windows" && target_env == "msvc" {
        attributes = attributes.windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
        let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default()).join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    }

    tauri_build::try_build(attributes).expect("tauri-build ist fehlgeschlagen");
}
