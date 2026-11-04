//! Byte/string codecs for the tunnel protocol: a port of
//! `packages/shared/src/tunnel/encoding.ts`. Standard base64 with padding,
//! URL-safe base64 without padding (the URL half of a pairing code), and
//! the Bitcoin base58 alphabet (the secret half).

use base64::Engine as _;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};

pub fn bytes_to_base64(bytes: &[u8]) -> String {
    STANDARD.encode(bytes)
}

/// Lenient like Node's `Buffer.from(…, "base64")`: padding is optional.
pub fn base64_to_bytes(text: &str) -> Result<Vec<u8>, String> {
    let trimmed = text.trim_end_matches('=');
    base64::engine::general_purpose::STANDARD_NO_PAD
        .decode(trimmed)
        .map_err(|e| format!("invalid base64: {e}"))
}

/// URL-safe base64 without padding.
pub fn bytes_to_base64_url(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn base64_url_to_bytes(text: &str) -> Result<Vec<u8>, String> {
    URL_SAFE_NO_PAD
        .decode(text.trim_end_matches('='))
        .map_err(|e| format!("invalid base64url: {e}"))
}

/// Bitcoin base58 alphabet — no 0/O/I/l, safe to read aloud or retype.
const BASE58_ALPHABET: &[u8; 58] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

pub fn bytes_to_base58(bytes: &[u8]) -> String {
    let zeros = bytes.iter().take_while(|b| **b == 0).count();
    let mut digits: Vec<u32> = Vec::new();
    for &byte in &bytes[zeros..] {
        let mut carry = byte as u32;
        for digit in digits.iter_mut() {
            carry += *digit << 8;
            *digit = carry % 58;
            carry /= 58;
        }
        while carry > 0 {
            digits.push(carry % 58);
            carry /= 58;
        }
    }
    let mut out = "1".repeat(zeros);
    out.extend(digits.iter().rev().map(|d| BASE58_ALPHABET[*d as usize] as char));
    out
}

pub fn base58_to_bytes(text: &str) -> Result<Vec<u8>, String> {
    let zeros = text.chars().take_while(|c| *c == '1').count();
    let mut bytes: Vec<u32> = Vec::new();
    for ch in text.chars().skip(zeros) {
        let mut carry = BASE58_ALPHABET
            .iter()
            .position(|a| *a as char == ch)
            .ok_or_else(|| format!("invalid base58 character: {ch}"))? as u32;
        for byte in bytes.iter_mut() {
            carry += *byte * 58;
            *byte = carry & 0xff;
            carry >>= 8;
        }
        while carry > 0 {
            bytes.push(carry & 0xff);
            carry >>= 8;
        }
    }
    let mut out = vec![0u8; zeros];
    out.extend(bytes.iter().rev().map(|b| *b as u8));
    Ok(out)
}
