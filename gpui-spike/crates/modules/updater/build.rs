//! Bundles the notes for this version, as vite.config.ts injects
//! `__LATEST_RELEASE_NOTES__`: `release-notes/v<version>.md` if it exists,
//! else nothing (the tab then says there are none).
fn main() {
    let version = std::env::var("CARGO_PKG_VERSION").unwrap();
    let dir = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap()).join("release-notes");
    let file = dir.join(format!("v{version}.md"));
    println!("cargo:rerun-if-changed={}", dir.display());
    let notes = std::fs::read_to_string(&file).unwrap_or_default();
    let out = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("latest_release_notes.md");
    std::fs::write(out, notes).unwrap();
}
