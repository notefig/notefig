//! The ACP client side of one task's connection (port of
//! `packages/agent/src/acp-client.ts`): initialize (protocol v1, fs caps),
//! session new/load/close/delete, prompt, cancel, authenticate, and the
//! config normalization (native `configOptions`, else legacy `modes` +
//! unstable `models`) with per-option source dispatch for switching.
//!
//! The `agent-client-protocol` crate (3.6.0) was evaluated: its builder /
//! actor connection API and typed v1 enums (no unknown-variant fallback)
//! don't fit the raw passthrough this layer needs (`_meta`, legacy
//! `session/set_model`, extension fields in `session/new`, unknown update
//! kinds kept verbatim), so the wire is hand-rolled JSON-RPC (`rpc.rs`),
//! like the TS MCP server.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use serde_json::{Map, Value, json};

use crate::model::{AuthMethod, ConfigChoice, ConfigOptions, SessionConfigSelect};
use crate::rpc::{LocalBoxFuture, RpcConnection, RpcError, RpcHandler, Spawner};

pub const SUPPORTED_ACP_PROTOCOL_VERSIONS: &[i64] = &[1];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ConfigSource {
    Config,
    Mode,
    Model,
}

#[derive(Debug, Clone, Default)]
struct ConfigState {
    options: Vec<SessionConfigSelect>,
    sources: Vec<(String, ConfigSource)>,
}

impl ConfigState {
    fn source(&self, id: &str) -> Option<ConfigSource> {
        self.sources.iter().find(|(i, _)| i == id).map(|(_, s)| *s)
    }
    fn with_current_value(&self, option_id: &str, value: &str) -> ConfigState {
        let mut next = self.clone();
        for option in &mut next.options {
            if option.id == option_id {
                option.current_value = Value::String(value.into());
            }
        }
        next
    }
    fn mode_option_id(&self) -> Option<String> {
        self.sources
            .iter()
            .find(|(_, s)| *s == ConfigSource::Mode)
            .map(|(id, _)| id.clone())
            .or_else(|| {
                self.options
                    .iter()
                    .find(|o| o.category.as_deref() == Some("mode"))
                    .map(|o| o.id.clone())
            })
    }
}

fn parse_select_options(config_options: &Value) -> Vec<SessionConfigSelect> {
    config_options
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter(|o| o.get("type").and_then(Value::as_str) == Some("select"))
                .filter_map(|o| serde_json::from_value(o.clone()).ok())
                .collect()
        })
        .unwrap_or_default()
}

fn from_config_options(config_options: &Value) -> ConfigState {
    let options = parse_select_options(config_options);
    let sources = options
        .iter()
        .map(|o| (o.id.clone(), ConfigSource::Config))
        .collect();
    ConfigState { options, sources }
}

/// Fold a session/new or session/load answer into one option list.
pub fn normalize_session_config(response: &Value) -> Vec<SessionConfigSelect> {
    normalize(response).options
}

fn normalize(response: &Value) -> ConfigState {
    if let Some(native) = response
        .get("configOptions")
        .filter(|v| v.as_array().is_some_and(|a| !a.is_empty()))
    {
        return from_config_options(native);
    }
    let mut state = ConfigState::default();
    if let Some(modes) = response.get("modes").filter(|m| m.is_object()) {
        let choices = modes
            .get("availableModes")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .map(|m| ConfigChoice {
                        value: m.get("id").and_then(Value::as_str).unwrap_or("").into(),
                        name: m.get("name").and_then(Value::as_str).unwrap_or("").into(),
                        description: m
                            .get("description")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                    })
                    .collect()
            })
            .unwrap_or_default();
        state.options.push(SessionConfigSelect {
            id: "mode".into(),
            name: "Mode".into(),
            description: None,
            category: Some("mode".into()),
            kind: "select".into(),
            current_value: modes.get("currentModeId").cloned().unwrap_or(Value::Null),
            options: ConfigOptions::Flat(choices),
        });
        state.sources.push(("mode".into(), ConfigSource::Mode));
    }
    if let Some(models) = response.get("models").filter(|m| m.is_object()) {
        let choices = models
            .get("availableModels")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .map(|m| ConfigChoice {
                        value: m
                            .get("modelId")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .into(),
                        name: m.get("name").and_then(Value::as_str).unwrap_or("").into(),
                        description: m
                            .get("description")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                    })
                    .collect()
            })
            .unwrap_or_default();
        state.options.push(SessionConfigSelect {
            id: "model".into(),
            name: "Model".into(),
            description: None,
            category: Some("model".into()),
            kind: "select".into(),
            current_value: models.get("currentModelId").cloned().unwrap_or(Value::Null),
            options: ConfigOptions::Flat(choices),
        });
        state.sources.push(("model".into(), ConfigSource::Model));
    }
    state
}

/// What the client needs from its owner (the task runtime).
pub trait AcpDelegate {
    /// A `session/update` notification's params (`{sessionId, update}`).
    fn session_update(&self, params: &Value);
    /// The session's normalized options changed (always the full list).
    fn config_changed(&self, session_id: &str, options: &[SessionConfigSelect]);
    /// A permission request no auto-grant answered: resolve to the ACP
    /// response (`{outcome:{…}}`).
    fn request_permission(&self, params: Value) -> LocalBoxFuture<Value>;
    fn read_text_file(
        &self,
        path: String,
        line: Option<u64>,
        limit: Option<u64>,
    ) -> LocalBoxFuture<Result<String, String>>;
    fn write_text_file(&self, path: String, content: String) -> LocalBoxFuture<Result<(), String>>;
}

struct Shared {
    configs: RefCell<HashMap<String, ConfigState>>,
    delegate: Rc<dyn AcpDelegate>,
    auto_grant: bool,
}

impl Shared {
    fn store(&self, session_id: &str, state: ConfigState) {
        let options = state.options.clone();
        self.configs
            .borrow_mut()
            .insert(session_id.to_string(), state);
        self.delegate.config_changed(session_id, &options);
    }
}

struct Handler(Rc<Shared>);

/// The permission auto-grant policy: `allow_always`, else `allow_once`.
pub fn auto_grant_option(params: &Value) -> Option<String> {
    let options = params.get("options")?.as_array()?;
    ["allow_always", "allow_once"].iter().find_map(|kind| {
        options
            .iter()
            .find(|o| o.get("kind").and_then(Value::as_str) == Some(kind))
            .and_then(|o| o.get("optionId")?.as_str().map(str::to_string))
    })
}

impl RpcHandler for Handler {
    fn request(&self, method: String, params: Value) -> LocalBoxFuture<Result<Value, RpcError>> {
        let shared = self.0.clone();
        Box::pin(async move {
            match method.as_str() {
                "session/request_permission" => {
                    if shared.auto_grant
                        && let Some(option_id) = auto_grant_option(&params)
                    {
                        return Ok(
                            json!({"outcome": {"outcome": "selected", "optionId": option_id}}),
                        );
                    }
                    Ok(shared.delegate.request_permission(params).await)
                }
                "fs/read_text_file" => {
                    let path = params
                        .get("path")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    let line = params.get("line").and_then(Value::as_u64);
                    let limit = params.get("limit").and_then(Value::as_u64);
                    shared
                        .delegate
                        .read_text_file(path, line, limit)
                        .await
                        .map(|content| json!({"content": content}))
                        .map_err(RpcError::internal)
                }
                "fs/write_text_file" => {
                    let path = params
                        .get("path")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    let content = params
                        .get("content")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    shared
                        .delegate
                        .write_text_file(path, content)
                        .await
                        .map(|()| json!({}))
                        .map_err(RpcError::internal)
                }
                // No terminal capability is advertised; terminal/* and anything else.
                other => Err(RpcError::method_not_found(other)),
            }
        })
    }

    fn notification(&self, method: String, params: Value) {
        if method != "session/update" {
            return;
        }
        let session_id = params
            .get("sessionId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if let Some(update) = params.get("update") {
            match update.get("sessionUpdate").and_then(Value::as_str) {
                Some("config_option_update") => {
                    let state =
                        from_config_options(update.get("configOptions").unwrap_or(&Value::Null));
                    self.0.store(&session_id, state);
                }
                Some("current_mode_update") => {
                    let current = self.0.configs.borrow().get(&session_id).cloned();
                    if let (Some(state), Some(mode)) =
                        (current, update.get("currentModeId").and_then(Value::as_str))
                        && let Some(option_id) = state.mode_option_id()
                    {
                        self.0
                            .store(&session_id, state.with_current_value(&option_id, mode));
                    }
                }
                _ => {}
            }
        }
        self.0.delegate.session_update(&params);
    }
}

pub struct AcpClient {
    conn: Rc<RpcConnection>,
    shared: Rc<Shared>,
    auth_methods: RefCell<Vec<AuthMethod>>,
    agent_capabilities: RefCell<Value>,
}

impl AcpClient {
    /// Wire a client onto the agent's stdio. `on_close` fires when the
    /// agent's stdout ends.
    pub fn new(
        spawner: &Spawner,
        reader: impl smol::io::AsyncRead + Unpin + 'static,
        writer: impl smol::io::AsyncWrite + Unpin + 'static,
        delegate: Rc<dyn AcpDelegate>,
        auto_grant: bool,
        on_close: impl FnOnce() + 'static,
    ) -> Rc<AcpClient> {
        let shared = Rc::new(Shared {
            configs: RefCell::default(),
            delegate,
            auto_grant,
        });
        let conn = RpcConnection::start(
            spawner,
            reader,
            writer,
            Rc::new(Handler(shared.clone())),
            on_close,
        );
        Rc::new(AcpClient {
            conn,
            shared,
            auth_methods: RefCell::default(),
            agent_capabilities: RefCell::new(Value::Null),
        })
    }

    pub fn is_closed(&self) -> bool {
        self.conn.is_closed()
    }

    /// `initialize`: protocol v1, fs caps (`fs` false for a remote locus),
    /// vendor `_meta`. Rejects an unsupported negotiated version.
    pub async fn connect(&self, fs: bool, client_meta: Option<Value>) -> Result<Value, RpcError> {
        let mut caps = json!({"fs": {"readTextFile": fs, "writeTextFile": fs}});
        if let Some(meta) = client_meta {
            caps["_meta"] = meta;
        }
        let response = self
            .conn
            .request(
                "initialize",
                json!({
                    "protocolVersion": 1,
                    "clientCapabilities": caps,
                    "clientInfo": {"name": "notefig", "version": env!("CARGO_PKG_VERSION")},
                }),
            )
            .await?;
        let version = response
            .get("protocolVersion")
            .and_then(Value::as_i64)
            .unwrap_or(-1);
        if !SUPPORTED_ACP_PROTOCOL_VERSIONS.contains(&version) {
            return Err(RpcError::new(
                -32000,
                format!(
                    "agent negotiated unsupported ACP protocol version {version} (supported: 1)"
                ),
            ));
        }
        let methods: Vec<AuthMethod> = response
            .get("authMethods")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|m| serde_json::from_value(m.clone()).ok())
                    .collect()
            })
            .unwrap_or_default();
        *self.auth_methods.borrow_mut() = methods;
        *self.agent_capabilities.borrow_mut() = response
            .get("agentCapabilities")
            .cloned()
            .unwrap_or(Value::Null);
        Ok(response)
    }

    fn session_params(base: Value, ext: &Map<String, Value>) -> Value {
        let mut params = base;
        for (k, v) in ext {
            params[k] = v.clone();
        }
        params
    }

    pub async fn new_session(
        &self,
        cwd: &str,
        mcp_servers: Vec<Value>,
        ext: &Map<String, Value>,
    ) -> Result<String, RpcError> {
        let response = self
            .conn
            .request(
                "session/new",
                Self::session_params(json!({"cwd": cwd, "mcpServers": mcp_servers}), ext),
            )
            .await?;
        let session_id = response
            .get("sessionId")
            .and_then(Value::as_str)
            .ok_or_else(|| RpcError::internal("session/new answered without a sessionId"))?
            .to_string();
        self.shared.store(&session_id, normalize(&response));
        Ok(session_id)
    }

    /// `session/load`: history replays as `session/update`s before this resolves.
    pub async fn load_session(
        &self,
        session_id: &str,
        cwd: &str,
        mcp_servers: Vec<Value>,
        ext: &Map<String, Value>,
    ) -> Result<(), RpcError> {
        let response = self
            .conn
            .request(
                "session/load",
                Self::session_params(
                    json!({"sessionId": session_id, "cwd": cwd, "mcpServers": mcp_servers}),
                    ext,
                ),
            )
            .await?;
        self.shared.store(session_id, normalize(&response));
        Ok(())
    }

    pub fn session_config_options(&self, session_id: &str) -> Vec<SessionConfigSelect> {
        self.shared
            .configs
            .borrow()
            .get(session_id)
            .map(|s| s.options.clone())
            .unwrap_or_default()
    }

    /// Switch one setting, dispatching on where the option came from.
    pub async fn set_session_config_option(
        &self,
        session_id: &str,
        option_id: &str,
        value: &str,
    ) -> Result<Vec<SessionConfigSelect>, RpcError> {
        let source = self
            .shared
            .configs
            .borrow()
            .get(session_id)
            .and_then(|s| s.source(option_id))
            .ok_or_else(|| {
                RpcError::internal(format!("session has no config option \"{option_id}\""))
            })?;
        match source {
            ConfigSource::Config => {
                let response = self
                    .conn
                    .request(
                        "session/set_config_option",
                        json!({"sessionId": session_id, "configId": option_id, "value": value}),
                    )
                    .await?;
                self.shared.store(
                    session_id,
                    from_config_options(response.get("configOptions").unwrap_or(&Value::Null)),
                );
            }
            ConfigSource::Mode | ConfigSource::Model => {
                let (method, params) = if source == ConfigSource::Mode {
                    (
                        "session/set_mode",
                        json!({"sessionId": session_id, "modeId": value}),
                    )
                } else {
                    (
                        "session/set_model",
                        json!({"sessionId": session_id, "modelId": value}),
                    )
                };
                self.conn.request(method, params).await?;
                let state = self
                    .shared
                    .configs
                    .borrow()
                    .get(session_id)
                    .cloned()
                    .unwrap_or_default();
                self.shared
                    .store(session_id, state.with_current_value(option_id, value));
            }
        }
        Ok(self.session_config_options(session_id))
    }

    pub async fn prompt(&self, session_id: &str, blocks: Vec<Value>) -> Result<Value, RpcError> {
        self.conn
            .request(
                "session/prompt",
                json!({"sessionId": session_id, "prompt": blocks}),
            )
            .await
    }

    pub fn cancel(&self, session_id: &str) {
        self.conn
            .notify("session/cancel", json!({"sessionId": session_id}));
    }

    pub async fn close_session(&self, session_id: &str) -> Result<(), RpcError> {
        self.conn
            .request("session/close", json!({"sessionId": session_id}))
            .await?;
        self.shared.configs.borrow_mut().remove(session_id);
        Ok(())
    }

    /// `session/delete` when advertised; Ok(false) without sending otherwise.
    pub async fn delete_session(&self, session_id: &str) -> Result<bool, RpcError> {
        let supported = self
            .agent_capabilities
            .borrow()
            .pointer("/sessionCapabilities/delete")
            .is_some_and(|v| !v.is_null() && v != &Value::Bool(false));
        if !supported {
            return Ok(false);
        }
        self.conn
            .request("session/delete", json!({"sessionId": session_id}))
            .await?;
        self.shared.configs.borrow_mut().remove(session_id);
        Ok(true)
    }

    pub async fn authenticate(&self, method_id: &str) -> Result<(), RpcError> {
        self.conn
            .request("authenticate", json!({"methodId": method_id}))
            .await
            .map(|_| ())
    }

    pub fn auth_methods(&self) -> Vec<AuthMethod> {
        self.auth_methods.borrow().clone()
    }

    /// The adapter's own "how to sign in" (first method's description).
    pub fn auth_hint(&self) -> Option<String> {
        self.auth_methods
            .borrow()
            .first()
            .and_then(|m| m.description.clone())
    }

    pub fn embedded_context(&self) -> bool {
        self.agent_capabilities
            .borrow()
            .pointer("/promptCapabilities/embeddedContext")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    }

    pub fn close(&self) {
        self.conn.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_options_win_and_legacy_synthesizes() {
        let native = json!({"configOptions": [
            {"id": "model", "name": "Model", "category": "model", "type": "select", "currentValue": "a", "options": [{"value": "a", "name": "A"}]},
            {"id": "b", "name": "B", "type": "boolean", "currentValue": true}
        ], "modes": {"currentModeId": "x", "availableModes": []}});
        let opts = normalize_session_config(&native);
        assert_eq!(opts.len(), 1);
        assert_eq!(opts[0].id, "model");
        let legacy = json!({"modes": {"currentModeId": "default", "availableModes": [{"id": "default", "name": "Default"}]},
                             "models": {"currentModelId": "m1", "availableModels": [{"modelId": "m1", "name": "M1"}]}});
        let opts = normalize_session_config(&legacy);
        assert_eq!(
            opts.iter().map(|o| o.id.as_str()).collect::<Vec<_>>(),
            vec!["mode", "model"]
        );
        assert_eq!(opts[1].current(), Some("m1"));
    }

    #[test]
    fn grouped_options_parse() {
        let v = json!({"configOptions": [{"id": "model", "name": "Model", "type": "select", "currentValue": "a",
            "options": [{"group": "g", "name": "G", "options": [{"value": "a", "name": "A"}, {"value": "b", "name": "B"}]}]}]});
        let opts = normalize_session_config(&v);
        assert_eq!(opts[0].choices().len(), 2);
    }

    #[test]
    fn auto_grant_prefers_always() {
        let p = json!({"options": [{"optionId": "o", "kind": "allow_once"}, {"optionId": "a", "kind": "allow_always"}, {"optionId": "r", "kind": "reject_once"}]});
        assert_eq!(auto_grant_option(&p).as_deref(), Some("a"));
        let p = json!({"options": [{"optionId": "r", "kind": "reject_once"}]});
        assert_eq!(auto_grant_option(&p), None);
    }
}
