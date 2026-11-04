//! Fixed vectors for the tunnel crypto, copied verbatim from
//! `packages/shared/src/tunnel/test-vectors.ts`. The TS shared, CLI and
//! desktop suites assert the same values: matching them is the proof this
//! port can talk to the TS peers. Regenerate only on a protocol bump.

/// 32-byte pairing secret, hex.
pub const VECTOR_SECRET_HEX: &str = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

/// HKDF-SHA256(secret, info="metrists-tunnel-frame-key-v1"), hex.
pub const VECTOR_FRAME_KEY_HEX: &str = "e25236c5beeba706c6af8d70bfc555c7e51b451f23acb6030a7ffd2a68b3c5c8";

/// A fixed hello.challenge (16 bytes, hex).
pub const VECTOR_CHALLENGE_HEX: &str = "101112131415161718191a1b1c1d1e1f";

/// HKDF-SHA256(frameKey, salt=challenge, info="metrists-tunnel-session-key-v1").
pub const VECTOR_SESSION_KEY_HEX: &str = "f7ac8048e44ad4ce28998ce268dcbdeb2a86ae716300ef297cd4fdc9c661e375";

/// `VECTOR_INNER_FRAME`'s fields.
pub const VECTOR_INNER_TASK_ID: &str = "task-1";
pub const VECTOR_INNER_DATA: &str = r#"{"jsonrpc":"2.0","id":1,"method":"initialize"}"#;

/// seal(VECTOR_INNER_FRAME) under the session key as browser at seq 0.
pub const VECTOR_BROWSER_SEQ0_PAYLOAD_B64: &str = "OpOeYTnZwZX/ZZIGKHjpbwqnfp5B7xdsbafYXbQQxPNg2aFdT1m3al5Iiin8yielZtJ5U9YmNqywxUemrr/1S0tmaQzmOlTaLcnUCBsZyvDiTJ9DI3qeidDKl2g7Dk1onoM/4jNw1EzVRRm0W/0n5g==";

/// seal(VECTOR_INNER_FRAME) under the session key as worker at seq 0.
pub const VECTOR_WORKER_SEQ0_PAYLOAD_B64: &str = "vNs2PnbC+Q9a9Rf5dpovIWQ1vjttzcD3B8Ryfs+CaqVps5APMM+K3LGp85dA+C18EonavEpcaqpLAMvgZJ/u2AK06bFXYB90NwX8F3IoHjdPdZuLLOHNUOw9YuNc65FqAdVyoWbd7UG0nXO7eQ+5xg==";

pub const VECTOR_TUNNEL_URL: &str = "wss://example.trycloudflare.com";
pub const VECTOR_PAIRING_CODE: &str =
    "1thX6LZfHDZZKUs92febYZhYRcXddmzfzF2NvTkPNE.d3NzOi8vZXhhbXBsZS50cnljbG91ZGZsYXJlLmNvbQ";

pub fn hex_to_bytes(hex: &str) -> Vec<u8> {
    (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap()).collect()
}

pub fn bytes_to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// `VECTOR_INNER_FRAME`.
pub fn vector_inner_frame() -> super::InnerFrame {
    super::InnerFrame {
        ch: super::TunnelChannel::Acp,
        task_id: Some(VECTOR_INNER_TASK_ID.into()),
        conn_id: None,
        data: Some(VECTOR_INNER_DATA.into()),
    }
}
