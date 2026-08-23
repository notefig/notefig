fn main() {
    // Same Common-Controls-6 manifest embed as the parent package's build.rs
    // (see the comment there): the shim links the notefig lib and therefore
    // comctl32 v6, and without the manifest it dies at load on Windows with
    // STATUS_ENTRYPOINT_NOT_FOUND before serving a single request.
    let is_windows_msvc = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");
    if is_windows_msvc {
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    }
}
