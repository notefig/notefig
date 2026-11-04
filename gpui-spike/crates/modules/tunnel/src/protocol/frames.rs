//! The tunnel's wire protocol: a port of
//! `packages/shared/src/tunnel/tunnel-protocol.ts`. Plaintext JSON envelopes
//! carry XSalsa20-Poly1305 (NaCl `secretbox`) ciphertext of one inner frame,
//! under a pairing-derived session key with direction-tagged counter nonces.
//!
//! Zod's schemas become serde types plus the explicit checks the schemas
//! made (`v == 1`, `challenge` 1–64 chars, `seq >= 0`, payload cap, task id
//! 1–64 chars).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use xsalsa20poly1305::aead::{Aead, KeyInit};
use xsalsa20poly1305::{Key, Nonce, XSalsa20Poly1305};

use super::encoding::{base64_to_bytes, bytes_to_base64};

pub const TUNNEL_PROTOCOL_VERSION: u64 = 1;

/// 4 MiB ciphertext cap — backpressure/flow control is a v2 concern.
pub const MAX_FRAME_PAYLOAD_BASE64: usize = 4_194_304;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TunnelErrorCode {
    VersionMismatch,
    PairingFailed,
    Busy,
    ProtocolError,
}

/// The plaintext outer envelope (one JSON text frame on the WebSocket).
#[derive(Debug, Clone, PartialEq)]
pub enum TunnelEnvelope {
    Hello { challenge: String },
    Frame(FrameEnvelope),
    Error { code: TunnelErrorCode, message: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrameEnvelope {
    pub seq: u64,
    /// base64 secretbox of one [`InnerFrame`].
    pub payload: String,
}

#[derive(Serialize, Deserialize)]
struct WireEnvelope {
    v: Value,
    t: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    challenge: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    seq: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    payload: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<TunnelErrorCode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

impl TunnelEnvelope {
    /// `TunnelEnvelopeSchema.parse(JSON.parse(raw))`.
    pub fn parse(raw: &str) -> Result<Self, String> {
        let wire: WireEnvelope = serde_json::from_str(raw).map_err(|e| e.to_string())?;
        if wire.v.as_u64() != Some(TUNNEL_PROTOCOL_VERSION) {
            return Err("version mismatch".into());
        }
        match wire.t.as_str() {
            "hello" => {
                let challenge = wire.challenge.ok_or("hello without challenge")?;
                let n = challenge.chars().count();
                if !(1..=64).contains(&n) {
                    return Err("bad challenge".into());
                }
                Ok(Self::Hello { challenge })
            }
            "frame" => {
                let seq = wire.seq.and_then(|s| s.as_u64()).ok_or("bad seq")?;
                let payload = wire.payload.ok_or("frame without payload")?;
                if payload.len() > MAX_FRAME_PAYLOAD_BASE64 {
                    return Err("payload too large".into());
                }
                Ok(Self::Frame(FrameEnvelope { seq, payload }))
            }
            "error" => Ok(Self::Error {
                code: wire.code.ok_or("error without code")?,
                message: wire.message.ok_or("error without message")?,
            }),
            other => Err(format!("unknown envelope type {other}")),
        }
    }

    pub fn to_json(&self) -> String {
        let mut wire = WireEnvelope {
            v: Value::from(TUNNEL_PROTOCOL_VERSION),
            t: String::new(),
            challenge: None,
            seq: None,
            payload: None,
            code: None,
            message: None,
        };
        match self {
            Self::Hello { challenge } => {
                wire.t = "hello".into();
                wire.challenge = Some(challenge.clone());
            }
            Self::Frame(f) => {
                wire.t = "frame".into();
                wire.seq = Some(Value::from(f.seq));
                wire.payload = Some(f.payload.clone());
            }
            Self::Error { code, message } => {
                wire.t = "error".into();
                wire.code = Some(*code);
                wire.message = Some(message.clone());
            }
        }
        serde_json::to_string(&wire).expect("envelope serializes")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TunnelChannel {
    Acp,
    Mcp,
    Ctl,
}

/// The decrypted payload of one `frame`. Field order is the wire's
/// (`ch`, `taskId`, `connId`, `data`): the fixed vectors pin the ciphertext.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InnerFrame {
    pub ch: TunnelChannel,
    #[serde(rename = "taskId", skip_serializing_if = "Option::is_none", default)]
    pub task_id: Option<String>,
    #[serde(rename = "connId", skip_serializing_if = "Option::is_none", default)]
    pub conn_id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub data: Option<Value>,
}

impl InnerFrame {
    /// `InnerFrameSchema.parse`.
    pub fn parse(value: Value) -> Result<Self, String> {
        let frame: InnerFrame = serde_json::from_value(value).map_err(|e| e.to_string())?;
        if let Some(id) = &frame.task_id
            && !valid_task_id(id)
        {
            return Err("bad taskId".into());
        }
        Ok(frame)
    }

    pub fn ctl(message: &CtlMessage) -> Self {
        Self {
            ch: TunnelChannel::Ctl,
            task_id: None,
            conn_id: None,
            data: Some(serde_json::to_value(message).expect("ctl serializes")),
        }
    }
}

fn valid_task_id(id: &str) -> bool {
    (1..=64).contains(&id.chars().count())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HarnessAdvert {
    pub id: String,
    pub available: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerInfo {
    /// The worker's hostname — the "paired with <name>" surface.
    pub name: String,
    /// The worker's resolved `--dir`.
    pub workspace_path: String,
    pub harnesses: Vec<HarnessAdvert>,
    pub protocol: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EnvVar {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct McpServerSpec {
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: Vec<EnvVar>,
}

/// Worker control messages (`ctl` channel bodies).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum CtlMessage {
    /// browser → worker: first encrypted frame, echoes the hello challenge.
    Pair { challenge: String },
    PairAck { worker: WorkerInfo },
    StartTask {
        task_id: String,
        harness_id: String,
        cwd: String,
        #[serde(default)]
        extra_env: BTreeMap<String, String>,
    },
    TaskStarted { task_id: String },
    TaskSpawnError { task_id: String, message: String },
    StopTask { task_id: String },
    TaskExit { task_id: String, code: Option<i64> },
    TaskDiagnostic { task_id: String, line: String },
    McpOpen { task_id: String },
    McpOpened { task_id: String, mcp_server: McpServerSpec },
    McpClose { task_id: String },
}

impl CtlMessage {
    /// `CtlMessageSchema.safeParse(data)`.
    pub fn parse(value: &Value) -> Option<Self> {
        let message: CtlMessage = serde_json::from_value(value.clone()).ok()?;
        let ok = match &message {
            Self::Pair { .. } | Self::PairAck { .. } => true,
            Self::StartTask { harness_id, cwd, .. } => {
                !harness_id.is_empty() && !cwd.is_empty() && message.task_id().is_some_and(valid_task_id)
            }
            _ => message.task_id().is_some_and(valid_task_id),
        };
        ok.then_some(message)
    }

    /// The task a message is about, if any (TS `"taskId" in message`).
    pub fn task_id(&self) -> Option<&str> {
        match self {
            Self::Pair { .. } | Self::PairAck { .. } => None,
            Self::StartTask { task_id, .. }
            | Self::TaskStarted { task_id }
            | Self::TaskSpawnError { task_id, .. }
            | Self::StopTask { task_id }
            | Self::TaskExit { task_id, .. }
            | Self::TaskDiagnostic { task_id, .. }
            | Self::McpOpen { task_id }
            | Self::McpOpened { task_id, .. }
            | Self::McpClose { task_id } => Some(task_id),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TunnelRole {
    Browser,
    Worker,
}

impl TunnelRole {
    fn tag(self) -> u8 {
        match self {
            Self::Browser => 0x01,
            Self::Worker => 0x02,
        }
    }

    fn peer(self) -> Self {
        match self {
            Self::Browser => Self::Worker,
            Self::Worker => Self::Browser,
        }
    }
}

/// 24-byte nonce: byte 0 = direction tag, bytes 1–23 = big-endian counter.
fn frame_nonce(role: TunnelRole, seq: u64) -> [u8; 24] {
    let mut nonce = [0u8; 24];
    nonce[0] = role.tag();
    nonce[16..].copy_from_slice(&seq.to_be_bytes());
    nonce
}

/// Sequenced, direction-tagged frame encryption. `seal` numbers outbound
/// frames from 0; `open` requires inbound frames in exact sequence and
/// returns `None` on any gap, repeat, tamper or wrong-direction nonce — the
/// caller must hard-close the connection then.
pub struct FrameCipher {
    cipher: XSalsa20Poly1305,
    role: TunnelRole,
    send_seq: u64,
    last_recv_seq: Option<u64>,
}

impl FrameCipher {
    pub fn new(frame_key: &[u8], role: TunnelRole) -> Result<Self, String> {
        if frame_key.len() != 32 {
            return Err("frame key must be 32 bytes".into());
        }
        Ok(Self {
            cipher: XSalsa20Poly1305::new(Key::from_slice(frame_key)),
            role,
            send_seq: 0,
            last_recv_seq: None,
        })
    }

    pub fn seal(&mut self, inner: &InnerFrame) -> FrameEnvelope {
        let seq = self.send_seq;
        self.send_seq += 1;
        let plaintext = serde_json::to_vec(inner).expect("inner frame serializes");
        let nonce = frame_nonce(self.role, seq);
        // NaCl layout: the 16-byte tag first, as tweetnacl's secretbox.
        let boxed = self
            .cipher
            .encrypt(Nonce::from_slice(&nonce), plaintext.as_slice())
            .expect("secretbox seal");
        FrameEnvelope { seq, payload: bytes_to_base64(&boxed) }
    }

    pub fn open(&mut self, envelope: &FrameEnvelope) -> Option<InnerFrame> {
        let expected = self.last_recv_seq.map_or(0, |s| s + 1);
        if envelope.seq != expected {
            return None;
        }
        let bytes = base64_to_bytes(&envelope.payload).ok()?;
        let nonce = frame_nonce(self.role.peer(), envelope.seq);
        let opened = self.cipher.decrypt(Nonce::from_slice(&nonce), bytes.as_slice()).ok()?;
        let value: Value = serde_json::from_slice(&opened).ok()?;
        let inner = InnerFrame::parse(value).ok()?;
        self.last_recv_seq = Some(envelope.seq);
        Some(inner)
    }
}
