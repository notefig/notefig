//! Tokens for sync's git remotes, in the OS keychain (MET-270).
//!
//! One token per remote, keyed by host plus repo path
//! (`github.com/owner/repo`). The frontend can store, check and delete a
//! token but never read it back: there is no `get` command. Only
//! `git_http.rs` looks a token up, to add `Authorization` to a request for
//! that remote, so the token never reaches JS, the sync worker or an agent.

use serde::{Deserialize, Serialize};

/// The keychain service every sync token is filed under.
const SERVICE: &str = "com.notefig.app.git-sync";

/// What is stored per remote.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Credential {
    pub username: String,
    pub token: String,
}

/// Where secrets live: the OS keychain in the app, memory in tests.
pub trait SecretStore {
    fn get(&self, key: &str) -> Result<Option<String>, String>;
    fn set(&self, key: &str, secret: &str) -> Result<(), String>;
    fn delete(&self, key: &str) -> Result<(), String>;
}

/// A remote key is `host[:port]/path`, with no scheme, userinfo, query or
/// whitespace: the same string `remoteCredentialKey` builds in JS.
pub fn validate_remote_key(key: &str) -> Result<(), String> {
    let invalid = || Err(format!("Not a remote key: {key:?}"));
    if key.is_empty() || key.len() > 512 || key.contains("://") {
        return invalid();
    }
    if key.chars().any(|c| c.is_whitespace() || matches!(c, '@' | '?' | '#' | '\\')) {
        return invalid();
    }
    match key.split_once('/') {
        Some((host, path)) if !host.is_empty() && !path.is_empty() => Ok(()),
        _ => invalid(),
    }
}

pub fn store_credential(
    store: &dyn SecretStore,
    key: &str,
    username: &str,
    token: &str,
) -> Result<(), String> {
    validate_remote_key(key)?;
    let token = token.trim();
    if token.is_empty() {
        return Err("The token is empty.".into());
    }
    if username.is_empty() || username.contains(':') {
        return Err("The username can't be empty or contain ':'.".into());
    }
    let secret = serde_json::to_string(&Credential {
        username: username.to_string(),
        token: token.to_string(),
    })
    .map_err(|e| e.to_string())?;
    store.set(key, &secret)
}

pub fn read_credential(store: &dyn SecretStore, key: &str) -> Result<Option<Credential>, String> {
    validate_remote_key(key)?;
    match store.get(key)? {
        None => Ok(None),
        Some(secret) => serde_json::from_str(&secret)
            .map(Some)
            .map_err(|_| "The stored credential is unreadable.".to_string()),
    }
}

/// The OS keychain (macOS Keychain, Windows Credential Manager, Linux
/// Secret Service).
pub struct Keychain;

#[cfg(any(target_os = "macos", windows, target_os = "linux"))]
impl SecretStore for Keychain {
    fn get(&self, key: &str) -> Result<Option<String>, String> {
        let entry = keyring::Entry::new(SERVICE, key).map_err(|e| e.to_string())?;
        match entry.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    fn set(&self, key: &str, secret: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(SERVICE, key).map_err(|e| e.to_string())?;
        entry.set_password(secret).map_err(|e| e.to_string())
    }

    fn delete(&self, key: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(SERVICE, key).map_err(|e| e.to_string())?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
impl SecretStore for Keychain {
    fn get(&self, _key: &str) -> Result<Option<String>, String> {
        Err("No keychain on this platform.".into())
    }
    fn set(&self, _key: &str, _secret: &str) -> Result<(), String> {
        Err("No keychain on this platform.".into())
    }
    fn delete(&self, _key: &str) -> Result<(), String> {
        Err("No keychain on this platform.".into())
    }
}

/// Keychain calls block (and on Linux drive their own D-Bus runtime), so
/// they run on the blocking pool, never on the IPC thread.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| e.to_string())?
}

/// The token for a remote, for `git_http.rs` only.
pub(crate) async fn lookup(key: String) -> Result<Option<Credential>, String> {
    blocking(move || read_credential(&Keychain, &key)).await
}

#[tauri::command]
pub async fn credentials_set(
    remote_key: String,
    username: String,
    token: String,
) -> Result<(), String> {
    blocking(move || store_credential(&Keychain, &remote_key, &username, &token)).await
}

#[tauri::command]
pub async fn credentials_has(remote_key: String) -> Result<bool, String> {
    blocking(move || Ok(read_credential(&Keychain, &remote_key)?.is_some())).await
}

#[tauri::command]
pub async fn credentials_delete(remote_key: String) -> Result<(), String> {
    blocking(move || {
        validate_remote_key(&remote_key)?;
        Keychain.delete(&remote_key)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;

    #[derive(Default)]
    struct MemoryStore(RefCell<HashMap<String, String>>);

    impl SecretStore for MemoryStore {
        fn get(&self, key: &str) -> Result<Option<String>, String> {
            Ok(self.0.borrow().get(key).cloned())
        }
        fn set(&self, key: &str, secret: &str) -> Result<(), String> {
            self.0.borrow_mut().insert(key.into(), secret.into());
            Ok(())
        }
        fn delete(&self, key: &str) -> Result<(), String> {
            self.0.borrow_mut().remove(key);
            Ok(())
        }
    }

    #[test]
    fn accepts_host_and_repo_path_keys_only() {
        assert!(validate_remote_key("github.com/owner/repo").is_ok());
        assert!(validate_remote_key("git.example.com:8443/team/notes").is_ok());
        for bad in [
            "",
            "github.com",
            "github.com/",
            "/owner/repo",
            "https://github.com/owner/repo",
            "user@github.com/owner/repo",
            "github.com/owner/repo?x=1",
            "github.com/owner repo",
        ] {
            assert!(validate_remote_key(bad).is_err(), "{bad:?} should be refused");
        }
    }

    #[test]
    fn stores_reads_and_deletes_a_token() {
        let store = MemoryStore::default();
        let key = "github.com/owner/repo";
        assert_eq!(read_credential(&store, key).unwrap(), None);

        store_credential(&store, key, "x-access-token", "  test-token-abc \n").unwrap();
        assert_eq!(
            read_credential(&store, key).unwrap(),
            Some(Credential {
                username: "x-access-token".into(),
                token: "test-token-abc".into(),
            })
        );

        store.delete(key).unwrap();
        assert_eq!(read_credential(&store, key).unwrap(), None);
    }

    #[test]
    fn refuses_empty_tokens_and_bad_usernames() {
        let store = MemoryStore::default();
        let key = "gitlab.com/group/project";
        assert!(store_credential(&store, key, "oauth2", "   ").is_err());
        assert!(store_credential(&store, key, "", "tok").is_err());
        assert!(store_credential(&store, key, "a:b", "tok").is_err());
        assert!(store.0.borrow().is_empty());
    }
}
