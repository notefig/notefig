//! Port of `engine/load-model.ts`: reads the bundled dictation model (the
//! TS app's `public/dictation/`): the manifest, then every chunk, each
//! checked against its size and sha256 before the bytes are joined. The TS
//! fetched from the app's origin; here a `read` closure hands back a file's
//! bytes by name (`load_bundled_model_from_dir` reads a folder).

use std::path::Path;

use anyhow::{Context as _, bail};
use serde::Deserialize;
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Deserialize)]
pub struct ManifestChunk {
    pub file: String,
    pub size: usize,
    pub sha256: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ManifestTokens {
    pub file: String,
    pub sha256: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ModelManifest {
    pub version: String,
    pub size: usize,
    pub chunks: Vec<ManifestChunk>,
    pub tokens: ManifestTokens,
}

#[derive(Debug, Clone)]
pub struct BundledModel {
    pub version: String,
    pub bytes: Vec<u8>,
    pub tokens: String,
}

pub fn sha256_hex(data: &[u8]) -> String {
    Sha256::digest(data).iter().map(|b| format!("{b:02x}")).collect()
}

fn read_checked(
    read: &dyn Fn(&str) -> anyhow::Result<Vec<u8>>,
    file: &str,
    size: Option<usize>,
    sha256: &str,
) -> anyhow::Result<Vec<u8>> {
    let bytes = read(file).with_context(|| format!("dictation model: reading {file}"))?;
    if let Some(size) = size {
        if bytes.len() != size {
            bail!("dictation model: {file} is {} bytes, expected {size}", bytes.len());
        }
    }
    if sha256_hex(&bytes) != sha256 {
        bail!("dictation model: checksum mismatch for {file}");
    }
    Ok(bytes)
}

pub fn load_bundled_model(read: &dyn Fn(&str) -> anyhow::Result<Vec<u8>>) -> anyhow::Result<BundledModel> {
    let manifest = read("manifest.json").context("dictation model: no manifest")?;
    let manifest: ModelManifest = serde_json::from_slice(&manifest).context("dictation model: bad manifest")?;
    let tokens = read_checked(read, &manifest.tokens.file, None, &manifest.tokens.sha256)?;
    let mut bytes = Vec::with_capacity(manifest.size);
    for chunk in &manifest.chunks {
        bytes.extend(read_checked(read, &chunk.file, Some(chunk.size), &chunk.sha256)?);
    }
    if bytes.len() != manifest.size {
        bail!("dictation model: chunks add up to {} bytes, expected {}", bytes.len(), manifest.size);
    }
    Ok(BundledModel {
        version: manifest.version,
        bytes,
        tokens: String::from_utf8_lossy(&tokens).into_owned(),
    })
}

/// The model in `dir` (its `manifest.json`'s folder), read in place.
pub fn load_bundled_model_from_dir(dir: &Path) -> anyhow::Result<BundledModel> {
    load_bundled_model(&|file: &str| {
        // A manifest names plain files in its own folder, never a path.
        if file.contains('/') || file.contains('\\') || file.contains("..") {
            bail!("dictation model: {file} is not a file in the model folder");
        }
        Ok(std::fs::read(dir.join(file))?)
    })
}
