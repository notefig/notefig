fn main() {
    // Windows/MSVC: tauri links comctl32 v6 entry points (TaskDialogIndirect,
    // via the dialog plugin), which the OS only resolves for exes whose
    // manifest declares Common-Controls 6 — without it EVERY exe linking this
    // lib dies at load with STATUS_ENTRYPOINT_NOT_FOUND (0xc0000139). By
    // default tauri-build embeds that manifest as a winres resource on the
    // app binary ONLY, so `cargo test` unittest exes and the test-shim crate
    // crashed on the windows CI leg (MET-157; upstream: tauri-apps/tauri
    // #4383's workaround, which is workspace-internal and unusable here).
    //
    // Fix: opt out of the winres manifest and embed the identical manifest
    // via linker args instead — `cargo:rustc-link-arg` reaches every link
    // target of this package (app bin, lib unittests, integration tests),
    // and applying it uniformly avoids duplicate-manifest link conflicts.
    let is_windows_msvc = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");
    if is_windows_msvc {
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());

        let attributes = tauri_build::Attributes::new().windows_attributes(
            tauri_build::WindowsAttributes::new_without_app_manifest(),
        );
        tauri_build::try_build(attributes).expect("failed to run tauri-build");
        return;
    }

    tauri_build::build()
}
