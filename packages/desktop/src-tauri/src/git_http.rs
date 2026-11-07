//! Sync's git smart-HTTP transport (MET-270): `@notefig/git`'s http port,
//! sent from Rust so the webview's CORS never applies.
//!
//! - HTTPS only, no userinfo in the URL.
//! - One shared client: connections are kept alive between polls.
//! - A 10 s timeout per request. A request that times out has an unknown
//!   outcome; the JS side re-polls (a push can land after the timeout).
//! - The request names a credential (`host/owner/repo`), never carries a
//!   secret. Rust looks the token up in the keychain and adds
//!   `Authorization: Basic …` itself, and only when the URL is under that
//!   remote — a request elsewhere goes out without it. Headers the frontend
//!   sends for auth or cookies are dropped.
//!
//! Wire: the body travels raw; the metadata (`{url, method, headers,
//! credential}`) in the percent-encoded `x-notefig-git-http` header. The
//! answer is one buffer: a 4-byte big-endian length, the JSON
//! `{status, headers}` it measures, then the body. No response at all
//! (network failure, timeout) is an `Err`.

use std::collections::{BTreeMap, HashMap};
use std::sync::OnceLock;
use std::time::Duration;

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use url::Url;

use crate::credentials;
use crate::fs_ops::{percent_decode, RawRequest};

pub const GIT_HTTP_META_HEADER: &str = "x-notefig-git-http";
const TIMEOUT: Duration = Duration::from_secs(10);
/// Headers the frontend may not set: auth is Rust's alone.
const DROPPED_HEADERS: [&str; 5] = ["authorization", "cookie", "host", "proxy-authorization", "content-length"];

#[derive(Debug, Deserialize)]
pub struct RequestMeta {
    pub url: String,
    pub method: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default)]
    pub credential: Option<String>,
}

#[derive(Debug, Serialize)]
struct ResponseMeta {
    status: u16,
    headers: BTreeMap<String, String>,
}

pub fn parse_meta(encoded: &str) -> Result<RequestMeta, String> {
    let json = percent_decode(encoded).ok_or("Malformed git request metadata.")?;
    serde_json::from_str(&json).map_err(|e| format!("Malformed git request metadata: {e}"))
}

/// The request URL, if sync may send to it: HTTPS, a host, no userinfo.
pub fn validate_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|_| "Not a URL.".to_string())?;
    if url.scheme() != "https" {
        return Err("Sync only talks to HTTPS remotes.".into());
    }
    if url.host_str().is_none() {
        return Err("The remote URL has no host.".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("The remote URL must not carry credentials.".into());
    }
    Ok(url)
}

/// Whether the token stored under `key` (`host/owner/repo`) may go with a
/// request to `url`: same host (and port), and the path is the repo's
/// (`/owner/repo`, `/owner/repo.git`, or anything under either).
pub fn credential_applies(url: &Url, key: &str) -> bool {
    let Some((key_host, key_path)) = key.split_once('/') else {
        return false;
    };
    let host = match (url.host_str(), url.port()) {
        (Some(host), Some(port)) => format!("{host}:{port}"),
        (Some(host), None) => host.to_string(),
        _ => return false,
    };
    if !host.eq_ignore_ascii_case(key_host) || key_path.is_empty() {
        return false;
    }
    let repo = format!("/{}", key_path.trim_end_matches('/'));
    let path = url.path();
    [repo.clone(), format!("{repo}.git")].iter().any(|prefix| {
        path == prefix || path.starts_with(&format!("{prefix}/"))
    })
}

pub fn basic_auth(username: &str, token: &str) -> String {
    let encoded = base64::engine::general_purpose::STANDARD.encode(format!("{username}:{token}"));
    format!("Basic {encoded}")
}

pub fn frame_response(status: u16, headers: BTreeMap<String, String>, body: &[u8]) -> Vec<u8> {
    let meta = serde_json::to_vec(&ResponseMeta { status, headers }).unwrap_or_default();
    let mut out = Vec::with_capacity(4 + meta.len() + body.len());
    out.extend_from_slice(&(meta.len() as u32).to_be_bytes());
    out.extend_from_slice(&meta);
    out.extend_from_slice(body);
    out
}

/// The frontend's headers, minus the ones Rust owns.
pub fn forwarded_headers(headers: &HashMap<String, String>) -> Vec<(String, String)> {
    headers
        .iter()
        .filter(|(name, _)| !DROPPED_HEADERS.contains(&name.to_ascii_lowercase().as_str()))
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect()
}

fn client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            if rustls::crypto::CryptoProvider::get_default().is_none() {
                // Fails only if another thread installed one meanwhile.
                let _ = rustls::crypto::ring::default_provider().install_default();
            }
            reqwest::Client::builder()
                .https_only(true)
                .timeout(TIMEOUT)
                .connect_timeout(TIMEOUT)
                .pool_idle_timeout(Duration::from_secs(90))
                .tcp_keepalive(Duration::from_secs(30))
                .build()
                .map_err(|e| e.to_string())
        })
        .as_ref()
        .map_err(Clone::clone)
}

async fn authorization(url: &Url, credential: Option<String>) -> Result<Option<String>, String> {
    let Some(key) = credential.filter(|key| credential_applies(url, key)) else {
        return Ok(None);
    };
    Ok(credentials::lookup(key)
        .await?
        .map(|found| basic_auth(&found.username, &found.token)))
}

#[tauri::command]
pub async fn git_http_request(request: RawRequest) -> Result<tauri::ipc::Response, String> {
    let encoded = request
        .headers
        .get(GIT_HTTP_META_HEADER)
        .and_then(|v| v.to_str().ok())
        .ok_or("A git request needs its metadata header.")?;
    let meta = parse_meta(encoded)?;
    let url = validate_url(&meta.url)?;
    let method = match meta.method.as_str() {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        other => return Err(format!("Unsupported method {other}.")),
    };

    let mut builder = client()?.request(method.clone(), url.clone());
    for (name, value) in forwarded_headers(&meta.headers) {
        builder = builder.header(name, value);
    }
    if let Some(auth) = authorization(&url, meta.credential).await? {
        builder = builder.header(reqwest::header::AUTHORIZATION, auth);
    }
    if method == reqwest::Method::POST {
        builder = builder.body(request.body);
    }

    let response = builder.send().await.map_err(|e| e.to_string())?;
    let status = response.status().as_u16();
    let headers = response
        .headers()
        .iter()
        .filter_map(|(name, value)| Some((name.as_str().to_string(), value.to_str().ok()?.to_string())))
        .collect();
    let body = response.bytes().await.map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(frame_response(status, headers, &body)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_percent_encoded_metadata() {
        let json = r#"{"url":"https://github.com/o/r.git/info/refs?service=git-upload-pack","method":"GET","headers":{"Git-Protocol":"version=2"},"credential":"github.com/o/r"}"#;
        let encoded: String = json
            .bytes()
            .map(|b| match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
                _ => format!("%{b:02X}"),
            })
            .collect();
        let meta = parse_meta(&encoded).unwrap();
        assert_eq!(meta.method, "GET");
        assert_eq!(meta.credential.as_deref(), Some("github.com/o/r"));
        assert_eq!(meta.headers.get("Git-Protocol").map(String::as_str), Some("version=2"));
        assert!(parse_meta("%7B%7Bnot json").is_err());
    }

    #[test]
    fn sends_to_https_remotes_only() {
        assert!(validate_url("https://github.com/o/r.git/git-upload-pack").is_ok());
        assert!(validate_url("http://github.com/o/r.git").is_err());
        assert!(validate_url("file:///etc/passwd").is_err());
        assert!(validate_url("https://user:pw@github.com/o/r.git").is_err());
        assert!(validate_url("not a url").is_err());
    }

    #[test]
    fn adds_the_token_only_for_its_own_remote() {
        let key = "github.com/notefig/notes";
        let applies = |raw: &str| credential_applies(&Url::parse(raw).unwrap(), key);
        assert!(applies("https://github.com/notefig/notes.git/info/refs?service=git-receive-pack"));
        assert!(applies("https://github.com/notefig/notes/git-upload-pack"));
        assert!(applies("https://GitHub.com/notefig/notes.git"));
        // Another repo, a look-alike path, another host or port: no token.
        assert!(!applies("https://github.com/notefig/notes-other.git/git-upload-pack"));
        assert!(!applies("https://github.com/notefig/other.git/git-upload-pack"));
        assert!(!applies("https://evil.example/notefig/notes.git/git-upload-pack"));
        assert!(!applies("https://github.com:8443/notefig/notes.git"));
        assert!(credential_applies(
            &Url::parse("https://git.example.com:8443/team/notes.git/x").unwrap(),
            "git.example.com:8443/team/notes"
        ));
    }

    #[test]
    fn builds_basic_auth_for_either_host_username() {
        assert_eq!(basic_auth("x-access-token", "tok"), "Basic eC1hY2Nlc3MtdG9rZW46dG9r");
        assert_eq!(basic_auth("oauth2", "tok"), "Basic b2F1dGgyOnRvaw==");
    }

    #[test]
    fn drops_headers_rust_owns() {
        let headers = HashMap::from([
            ("Authorization".to_string(), "Basic stolen".to_string()),
            ("cookie".to_string(), "a=b".to_string()),
            ("Git-Protocol".to_string(), "version=2".to_string()),
        ]);
        let kept = forwarded_headers(&headers);
        assert_eq!(kept, vec![("Git-Protocol".to_string(), "version=2".to_string())]);
    }

    #[test]
    fn frames_status_headers_and_body() {
        let headers = BTreeMap::from([("content-type".to_string(), "x".to_string())]);
        let framed = frame_response(200, headers, b"PACK");
        let len = u32::from_be_bytes(framed[..4].try_into().unwrap()) as usize;
        let meta: serde_json::Value = serde_json::from_slice(&framed[4..4 + len]).unwrap();
        assert_eq!(meta["status"], 200);
        assert_eq!(meta["headers"]["content-type"], "x");
        assert_eq!(&framed[4 + len..], b"PACK");
    }
}
