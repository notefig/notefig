//! Pairing-code key derivation: a port of
//! `packages/shared/src/tunnel/pairing.ts`.
//!
//! The CLI worker generates a random 32-byte secret and shows it as a
//! pairing code (base58 secret + tunnel URL). Both peers derive the same
//! frame key; the tunnel provider only ever carries ciphertext.

use hkdf::Hkdf;
use sha2::Sha256;

use super::encoding::{base58_to_bytes, base64_url_to_bytes, bytes_to_base58, bytes_to_base64_url};

pub const PAIRING_SECRET_BYTES: usize = 32;

// KEEP "metrists" in these HKDF info labels: they are inputs to key
// derivation, so renaming them changes every derived key and silently breaks
// pairing between builds from opposite sides of the rebrand.
const FRAME_KEY_INFO: &[u8] = b"metrists-tunnel-frame-key-v1";
const SESSION_KEY_INFO: &[u8] = b"metrists-tunnel-session-key-v1";

pub const DEFAULT_APP_URL: &str = "https://app.notefig.com";

pub fn generate_pairing_secret() -> [u8; PAIRING_SECRET_BYTES] {
    let mut secret = [0u8; PAIRING_SECRET_BYTES];
    getrandom::fill(&mut secret).expect("OS randomness");
    secret
}

/// HKDF-SHA256(secret, salt = empty, info = frame label) → 32-byte frame key.
pub fn derive_frame_key(secret: &[u8]) -> Result<[u8; 32], String> {
    if secret.len() != PAIRING_SECRET_BYTES {
        return Err(format!("pairing secret must be {PAIRING_SECRET_BYTES} bytes"));
    }
    Ok(hkdf(secret, &[], FRAME_KEY_INFO))
}

/// Per-connection key: HKDF-SHA256(ikm = frame key, salt = the connection's
/// hello challenge, info = session label). Frame counters restart at 0 on
/// every connection, so the random challenge keeps (key, nonce) unique.
pub fn derive_session_key(frame_key: &[u8], challenge: &[u8]) -> [u8; 32] {
    hkdf(frame_key, challenge, SESSION_KEY_INFO)
}

fn hkdf(ikm: &[u8], salt: &[u8], info: &[u8]) -> [u8; 32] {
    // WebCrypto treats an empty salt as HashLen zero bytes, as RFC 5869 and
    // the hkdf crate's `None` do.
    let hk = Hkdf::<Sha256>::new(if salt.is_empty() { None } else { Some(salt) }, ikm);
    let mut out = [0u8; 32];
    hk.expand(info, &mut out).expect("32 bytes is a valid HKDF length");
    out
}

fn is_ws_url(url: &str) -> bool {
    url.starts_with("ws://") || url.starts_with("wss://")
}

/// `base58(secret) + "." + base64url(url)`.
pub fn encode_pairing_code(secret: &[u8], url: &str) -> Result<String, String> {
    if secret.len() != PAIRING_SECRET_BYTES {
        return Err(format!("pairing secret must be {PAIRING_SECRET_BYTES} bytes"));
    }
    if !is_ws_url(url) {
        return Err("pairing URL must be a ws:// or wss:// endpoint".into());
    }
    Ok(format!("{}.{}", bytes_to_base58(secret), bytes_to_base64_url(url.as_bytes())))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodedPairing {
    pub secret: Vec<u8>,
    pub url: String,
}

pub fn decode_pairing_code(code: &str) -> Result<DecodedPairing, String> {
    let dot = code.find('.');
    let Some(dot) = dot.filter(|d| *d > 0 && *d != code.len() - 1) else {
        return Err("malformed pairing code".into());
    };
    let secret = base58_to_bytes(&code[..dot])?;
    if secret.len() != PAIRING_SECRET_BYTES {
        return Err("malformed pairing code: bad secret length".into());
    }
    let url = String::from_utf8(base64_url_to_bytes(&code[dot + 1..])?)
        .map_err(|_| "malformed pairing code: bad URL".to_string())?;
    if !is_ws_url(&url) {
        return Err("malformed pairing code: bad URL".into());
    }
    Ok(DecodedPairing { secret, url })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairingLinks {
    pub web: String,
    pub deep_link: String,
}

/// Shareable links; the code rides the fragment so no server logs it.
pub fn pairing_link(code: &str, app_base_url: Option<&str>) -> PairingLinks {
    let base = app_base_url.unwrap_or(DEFAULT_APP_URL);
    let base = base.strip_suffix('/').unwrap_or(base);
    PairingLinks {
        web: format!("{base}/pair#{code}"),
        deep_link: format!("notefig://pair#{code}"),
    }
}
