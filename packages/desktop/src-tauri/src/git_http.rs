//! Git's smart-HTTP transport: `@notefig/git`'s http port,
//! sent from Rust so the webview's CORS never applies and a token never
//! reaches JS.
//!
//! - HTTPS only, no userinfo in the URL; one shared keep-alive client; a
//!   10 s timeout (a push that times out has an unknown outcome: JS polls).
//! - The remote is read off the URL (`remote_key`), and its credential
//!   (`credentials.rs`) is added as `Authorization: Basic …` — so a token
//!   only ever goes to its own repository. A 401 drops it for the session.
//!   Auth and cookie headers from the frontend are dropped.
//!
//! Wire: the body travels raw, `{url, method, headers}` in the
//! percent-encoded `x-notefig-git-http` header. The answer is one buffer: a
//! 4-byte big-endian length, the JSON `{status, headers}` it measures, then
//! the body. No response at all is an `Err`.

use std::collections::{BTreeMap, HashMap};
use std::sync::OnceLock;
use std::time::Duration;

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use url::Url;

use crate::credentials;
use crate::fs_ops::{percent_decode, RawRequest};

const META_HEADER: &str = "x-notefig-git-http";
const TIMEOUT: Duration = Duration::from_secs(10);
const DROPPED_HEADERS: [&str; 5] = ["authorization", "cookie", "host", "proxy-authorization", "content-length"];
/// What git's smart-HTTP protocol appends to a repository URL.
const SERVICE_SUFFIXES: [&str; 3] = ["/info/refs", "/git-upload-pack", "/git-receive-pack"];

#[derive(Debug, Deserialize)]
struct RequestMeta {
    url: String,
    method: String,
    #[serde(default)]
    headers: HashMap<String, String>,
}

#[derive(Serialize)]
struct ResponseMeta {
    status: u16,
    headers: BTreeMap<String, String>,
}

/// An HTTPS URL with a host and no credentials in it.
pub fn validate_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|_| "Not a URL.".to_string())?;
    if url.scheme() != "https" || url.host_str().is_none() {
        return Err("Only HTTPS remotes are supported.".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("The remote URL must not carry credentials.".into());
    }
    Ok(url)
}

/// The repository a URL is under, as `host[:port]/owner/repo`: the
/// service suffix, a trailing `.git` and `/` dropped, the host lowercased.
/// A remote's URL and every request git makes to it give the same key.
pub fn remote_key(url: &Url) -> Result<String, String> {
    let mut path = url.path().trim_end_matches('/');
    if let Some(at) = SERVICE_SUFFIXES.iter().find_map(|suffix| path.find(suffix)) {
        path = &path[..at];
    }
    let path = path.trim_end_matches(".git").trim_matches('/');
    let host = url.host_str().ok_or("The remote URL has no host.")?.to_ascii_lowercase();
    if path.is_empty() {
        return Err("The remote URL names no repository.".into());
    }
    Ok(match url.port() {
        Some(port) => format!("{host}:{port}/{path}"),
        None => format!("{host}/{path}"),
    })
}

fn basic_auth(username: &str, token: &str) -> String {
    let encoded = base64::engine::general_purpose::STANDARD.encode(format!("{username}:{token}"));
    format!("Basic {encoded}")
}

fn frame_response(status: u16, headers: BTreeMap<String, String>, body: &[u8]) -> Vec<u8> {
    let meta = serde_json::to_vec(&ResponseMeta { status, headers }).unwrap_or_default();
    let mut out = Vec::with_capacity(4 + meta.len() + body.len());
    out.extend_from_slice(&(meta.len() as u32).to_be_bytes());
    out.extend_from_slice(&meta);
    out.extend_from_slice(body);
    out
}

fn shared_client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            if rustls::crypto::CryptoProvider::get_default().is_none() {
                let _ = rustls::crypto::ring::default_provider().install_default();
            }
            reqwest::Client::builder()
                .https_only(true)
                .timeout(TIMEOUT)
                .connect_timeout(TIMEOUT)
                .pool_idle_timeout(Duration::from_secs(90))
                .build()
                .map_err(|e| e.to_string())
        })
        .as_ref()
        .map_err(Clone::clone)
}

#[tauri::command]
pub async fn git_http_request(request: RawRequest) -> Result<tauri::ipc::Response, String> {
    let encoded = request
        .headers
        .get(META_HEADER)
        .and_then(|v| v.to_str().ok())
        .ok_or("A git request needs its metadata header.")?;
    let json = percent_decode(encoded).ok_or("Malformed git request metadata.")?;
    let meta: RequestMeta = serde_json::from_str(&json).map_err(|e| format!("Malformed git request metadata: {e}"))?;
    let url = validate_url(&meta.url)?;
    let key = remote_key(&url)?;
    let post = match meta.method.as_str() {
        "GET" => false,
        "POST" => true,
        other => return Err(format!("Unsupported method {other}.")),
    };

    let mut builder = shared_client()?.request(if post { reqwest::Method::POST } else { reqwest::Method::GET }, url);
    for (name, value) in &meta.headers {
        if !DROPPED_HEADERS.contains(&name.to_ascii_lowercase().as_str()) {
            builder = builder.header(name, value);
        }
    }
    let credential = credentials::for_remote(&key).await;
    if let Some(found) = &credential {
        builder = builder.header(reqwest::header::AUTHORIZATION, basic_auth(&found.username, &found.token));
    }
    if post {
        builder = builder.body(request.body);
    }

    let response = builder.send().await.map_err(|e| e.to_string())?;
    let status = response.status().as_u16();
    if status == 401 && credential.is_some() {
        credentials::refused(&key);
    }
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

    fn key(raw: &str) -> String {
        remote_key(&Url::parse(raw).unwrap()).unwrap()
    }

    #[test]
    fn sends_to_https_remotes_only() {
        assert!(validate_url("https://github.com/o/r.git/git-upload-pack").is_ok());
        assert!(validate_url("http://github.com/o/r.git").is_err());
        assert!(validate_url("file:///etc/passwd").is_err());
        assert!(validate_url("https://user:pw@github.com/o/r.git").is_err());
    }

    #[test]
    fn a_remote_and_its_requests_share_one_key() {
        assert_eq!(key("https://github.com/notefig/notes.git"), "github.com/notefig/notes");
        assert_eq!(key("https://GitHub.com/notefig/notes/"), "github.com/notefig/notes");
        assert_eq!(key("https://github.com/notefig/notes.git/info/refs?service=git-receive-pack"), "github.com/notefig/notes");
        assert_eq!(key("https://github.com/notefig/notes/git-upload-pack"), "github.com/notefig/notes");
        assert_eq!(key("https://git.example.com:8443/team/sub/notes.git/git-receive-pack"), "git.example.com:8443/team/sub/notes");
        // A look-alike repo is another key, so it never gets the token.
        assert_eq!(key("https://github.com/notefig/notes-other.git/info/refs"), "github.com/notefig/notes-other");
        assert!(remote_key(&Url::parse("https://github.com/").unwrap()).is_err());
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
        assert_eq!(basic_auth("oauth2", "tok"), "Basic b2F1dGgyOnRvaw==");
    }
}
