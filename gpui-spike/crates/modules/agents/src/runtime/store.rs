//! State + persistence. [`AgentState`] is the live store (tasks, turns,
//! entries, permissions, harness rows, usage, KV) shared
//! with the app for snapshot reads; [`Store`] persists the durable part
//! (task rows, harness rows, usage buckets/limits, KV) —
//! turns/entries/permissions are memory-only, as in the TS app.

use std::cell::Cell;
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::runtime::events::AgentEvent;
use notefig_agent::harness::HarnessRow;
use notefig_agent::model::{AgentEntry, AgentTaskRow, AgentTurn, PermissionRequestRow};
use notefig_agent::usage::{UsageBucket, UsageLimits};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredLimits {
    pub harness_id: String,
    pub at: i64,
    pub limits: UsageLimits,
}

/// What is persisted. Rows are kept as raw JSON so a row that fails to
/// parse (older shape, hand edit) is dropped on read, never spawned.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedState {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub tasks: BTreeMap<String, Value>,
    #[serde(default)]
    pub harnesses: BTreeMap<String, Value>,
    #[serde(default)]
    pub usage_buckets: Vec<Value>,
    #[serde(default)]
    pub usage_limits: BTreeMap<String, Value>,
    #[serde(default)]
    pub kv: BTreeMap<String, Value>,
}

/// Where the durable state lives. Called on the agent thread.
pub trait Store: Send + 'static {
    fn load(&self) -> Result<PersistedState, String>;
    fn save(&self, state: &PersistedState) -> Result<(), String>;
}

/// One JSON file (written atomically via a temp file + rename).
pub struct JsonFileStore {
    pub path: PathBuf,
}

impl JsonFileStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        JsonFileStore { path: path.into() }
    }
}

impl Store for JsonFileStore {
    fn load(&self) -> Result<PersistedState, String> {
        match std::fs::read_to_string(&self.path) {
            Ok(text) => {
                serde_json::from_str(&text).map_err(|e| format!("{}: {e}", self.path.display()))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(PersistedState::default()),
            Err(e) => Err(format!("{}: {e}", self.path.display())),
        }
    }
    fn save(&self, state: &PersistedState) -> Result<(), String> {
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let tmp = self.path.with_extension("json.tmp");
        let text = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
        std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &self.path).map_err(|e| e.to_string())
    }
}

/// The module's store: hydrated from the platform db before the runtime
/// starts, and every durable snapshot sent back to the main thread, which
/// writes it through to the db (`agent-tasks`, `harnesses`, KV `agent`).
pub struct ChannelStore {
    pub initial: PersistedState,
    pub saves: async_channel::Sender<PersistedState>,
}

impl Store for ChannelStore {
    fn load(&self) -> Result<PersistedState, String> {
        Ok(self.initial.clone())
    }
    fn save(&self, state: &PersistedState) -> Result<(), String> {
        self.saves.try_send(state.clone()).map_err(|e| e.to_string())
    }
}

/// In-memory store (tests); clones share the same state.
#[derive(Clone, Default)]
pub struct MemoryStore(pub Arc<Mutex<PersistedState>>);

impl Store for MemoryStore {
    fn load(&self) -> Result<PersistedState, String> {
        Ok(self.0.lock().unwrap().clone())
    }
    fn save(&self, state: &PersistedState) -> Result<(), String> {
        *self.0.lock().unwrap() = state.clone();
        Ok(())
    }
}

/// The live store. Read it through `AgentHandle` (it locks briefly).
#[derive(Debug, Default)]
pub struct AgentState {
    pub tasks: BTreeMap<String, AgentTaskRow>,
    pub turns: BTreeMap<String, AgentTurn>,
    /// task id → entry id → entry (id order = render order).
    pub entries: HashMap<String, BTreeMap<String, AgentEntry>>,
    pub permissions: BTreeMap<String, PermissionRequestRow>,
    pub harnesses: BTreeMap<String, HarnessRow>,
    pub usage_buckets: Vec<UsageBucket>,
    pub usage_limits: BTreeMap<String, StoredLimits>,
    pub kv: BTreeMap<String, Value>,
}

impl AgentState {
    /// Boot: load + reconcile. Task rows: invalid → dropped; sessionful →
    /// `restored` (runtime fields stripped); sessionless → dropped.
    pub fn from_persisted(p: PersistedState, _now: i64) -> AgentState {
        let mut state = AgentState::default();
        for (id, raw) in p.tasks {
            let Ok(row) = serde_json::from_value::<AgentTaskRow>(raw) else {
                continue;
            };
            if row.task_id != id || row.workspace_path.is_empty() || row.harness_id.is_empty() {
                continue;
            }
            if let Some(boot) = row.boot() {
                state.tasks.insert(id, boot);
            }
        }
        for (id, raw) in p.harnesses {
            if let Ok(row) = serde_json::from_value::<HarnessRow>(raw)
                && row.id == id
            {
                state.harnesses.insert(id, row);
            }
        }
        state.usage_buckets = p
            .usage_buckets
            .into_iter()
            .filter_map(|v| serde_json::from_value(v).ok())
            .collect();
        for (id, raw) in p.usage_limits {
            if let Ok(row) = serde_json::from_value(raw) {
                state.usage_limits.insert(id, row);
            }
        }
        state.kv = p.kv;
        state
    }

    pub fn to_persisted(&self) -> PersistedState {
        PersistedState {
            version: 1,
            tasks: self
                .tasks
                .iter()
                .map(|(k, v)| (k.clone(), to_value(&v.persisted())))
                .collect(),
            harnesses: self
                .harnesses
                .iter()
                .map(|(k, v)| (k.clone(), to_value(v)))
                .collect(),
            usage_buckets: self.usage_buckets.iter().map(to_value).collect(),
            usage_limits: self
                .usage_limits
                .iter()
                .map(|(k, v)| (k.clone(), to_value(v)))
                .collect(),
            kv: self.kv.clone(),
        }
    }

    /// A task's entries in render order.
    pub fn entries_for_task(&self, task_id: &str) -> Vec<AgentEntry> {
        self.entries
            .get(task_id)
            .map(|m| m.values().cloned().collect())
            .unwrap_or_default()
    }

    /// A task's turns in order.
    pub fn turns_for_task(&self, task_id: &str) -> Vec<AgentTurn> {
        self.turns
            .values()
            .filter(|t| t.task_id == task_id)
            .cloned()
            .collect()
    }
}

fn to_value<T: Serialize>(v: &T) -> Value {
    serde_json::to_value(v).unwrap_or(Value::Null)
}

/// The agent thread's writer over [`AgentState`]: every mutation emits its
/// event and marks the durable state dirty when it touched it.
pub(crate) struct Db {
    pub state: Arc<Mutex<AgentState>>,
    pub events: async_channel::Sender<AgentEvent>,
    store: Box<dyn Store>,
    dirty: Cell<bool>,
}

impl Db {
    pub fn new(
        state: Arc<Mutex<AgentState>>,
        events: async_channel::Sender<AgentEvent>,
        store: Box<dyn Store>,
    ) -> Db {
        Db {
            state,
            events,
            store,
            dirty: Cell::new(false),
        }
    }

    pub fn lock(&self) -> MutexGuard<'_, AgentState> {
        self.state.lock().unwrap()
    }

    pub fn emit(&self, event: AgentEvent) {
        let _ = self.events.try_send(event);
    }

    pub fn mark_dirty(&self) {
        self.dirty.set(true);
    }

    /// Save now if anything durable changed.
    pub fn flush(&self) {
        if !self.dirty.replace(false) {
            return;
        }
        let snapshot = self.lock().to_persisted();
        if let Err(e) = self.store.save(&snapshot) {
            self.emit(AgentEvent::Diagnostic {
                task_id: None,
                label: "persist failed".into(),
                detail: e,
            });
        }
    }

    // ── tasks ──
    pub fn task(&self, id: &str) -> Option<AgentTaskRow> {
        self.lock().tasks.get(id).cloned()
    }
    pub fn insert_task(&self, row: AgentTaskRow) {
        self.lock().tasks.insert(row.task_id.clone(), row.clone());
        self.mark_dirty();
        self.emit(AgentEvent::TaskChanged(row));
    }
    /// Update a task row; false when there is none.
    pub fn update_task(&self, id: &str, f: impl FnOnce(&mut AgentTaskRow)) -> bool {
        let row = {
            let mut state = self.lock();
            let Some(row) = state.tasks.get_mut(id) else {
                return false;
            };
            let before = row.persisted();
            f(row);
            if row.persisted() != before {
                self.dirty.set(true);
            }
            row.clone()
        };
        self.emit(AgentEvent::TaskChanged(row));
        true
    }
    /// Drop a task's rows from every collection.
    pub fn purge_task(&self, id: &str) {
        let (turns, existed) = {
            let mut state = self.lock();
            let existed = state.tasks.remove(id).is_some();
            let turns: Vec<String> = state
                .turns
                .values()
                .filter(|t| t.task_id == id)
                .map(|t| t.turn_id.clone())
                .collect();
            for t in &turns {
                state.turns.remove(t);
            }
            state.entries.remove(id);
            state.permissions.retain(|_, p| p.task_id != id);
            (turns, existed)
        };
        let _ = turns;
        if existed {
            self.mark_dirty();
            self.emit(AgentEvent::TaskRemoved { task_id: id.into() });
        }
    }

    // ── turns ──
    pub fn turn(&self, id: &str) -> Option<AgentTurn> {
        self.lock().turns.get(id).cloned()
    }
    pub fn insert_turn(&self, turn: AgentTurn) {
        self.lock().turns.insert(turn.turn_id.clone(), turn.clone());
        self.emit(AgentEvent::TurnChanged(turn));
    }
    pub fn update_turn(&self, id: &str, f: impl FnOnce(&mut AgentTurn)) -> bool {
        let turn = {
            let mut state = self.lock();
            let Some(turn) = state.turns.get_mut(id) else {
                return false;
            };
            f(turn);
            turn.clone()
        };
        self.emit(AgentEvent::TurnChanged(turn));
        true
    }
    pub fn delete_turn(&self, id: &str) {
        let removed = self.lock().turns.remove(id);
        if let Some(turn) = removed {
            self.emit(AgentEvent::TurnRemoved {
                task_id: turn.task_id,
                turn_id: turn.turn_id,
            });
        }
    }

    // ── entries ──
    pub fn entry(&self, task_id: &str, id: &str) -> Option<AgentEntry> {
        self.lock().entries.get(task_id)?.get(id).cloned()
    }
    pub fn insert_entry(&self, entry: AgentEntry) {
        self.lock()
            .entries
            .entry(entry.task_id.clone())
            .or_default()
            .insert(entry.id.clone(), entry.clone());
        self.emit(AgentEvent::EntryChanged(entry));
    }
    pub fn update_entry(&self, task_id: &str, id: &str, f: impl FnOnce(&mut AgentEntry)) -> bool {
        let entry = {
            let mut state = self.lock();
            let Some(entry) = state.entries.get_mut(task_id).and_then(|m| m.get_mut(id)) else {
                return false;
            };
            f(entry);
            entry.clone()
        };
        self.emit(AgentEvent::EntryChanged(entry));
        true
    }
    pub fn delete_entry(&self, task_id: &str, id: &str) {
        let removed = self
            .lock()
            .entries
            .get_mut(task_id)
            .and_then(|m| m.remove(id));
        if removed.is_some() {
            self.emit(AgentEvent::EntryRemoved {
                task_id: task_id.into(),
                entry_id: id.into(),
            });
        }
    }
    pub fn entries_for_task(&self, task_id: &str) -> Vec<AgentEntry> {
        self.lock().entries_for_task(task_id)
    }

    // ── permissions ──
    pub fn upsert_permission(&self, row: PermissionRequestRow) {
        self.lock().permissions.insert(row.id.clone(), row.clone());
        self.emit(AgentEvent::PermissionChanged(row));
    }

    // ── kv ──
    pub fn kv_get(&self, key: &str) -> Option<Value> {
        self.lock().kv.get(key).cloned()
    }
    pub fn kv_set(&self, key: &str, value: Value) {
        self.lock().kv.insert(key.into(), value);
        self.mark_dirty();
    }

    // ── harness rows ──
    pub fn upsert_harness(&self, id: &str, f: impl FnOnce(&mut HarnessRow)) {
        {
            let mut state = self.lock();
            let row = state
                .harnesses
                .entry(id.to_string())
                .or_insert_with(|| HarnessRow {
                    id: id.into(),
                    r#override: None,
                    custom: None,
                    install: None,
                    catalog: None,
                    created_at: notefig_agent::ids::now_ms(),
                });
            f(row);
        }
        self.mark_dirty();
        self.emit(AgentEvent::HarnessesChanged);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notefig_agent::model::TaskStatus;
    use serde_json::json;

    #[test]
    fn boot_reconcile_restores_sessionful_and_drops_rest() {
        let mut p = PersistedState::default();
        p.tasks.insert("task_a".into(), json!({"taskId": "task_a", "workspacePath": "/w", "title": "A", "status": "running", "harnessId": "opencode", "sessionId": "s1", "createdAt": 1, "updatedAt": 2, "authRequired": true, "configOptions": []}));
        p.tasks.insert("task_b".into(), json!({"taskId": "task_b", "workspacePath": "/w", "title": "B", "status": "idle", "harnessId": "opencode", "createdAt": 1, "updatedAt": 2}));
        p.tasks.insert("task_c".into(), json!({"garbage": true}));
        let state = AgentState::from_persisted(p, 10);
        assert_eq!(state.tasks.len(), 1);
        let row = &state.tasks["task_a"];
        assert_eq!(row.status, TaskStatus::Restored);
        assert!(!row.auth_required);
        assert!(row.config_options.is_none());
        let persisted = state.to_persisted();
        assert!(persisted.tasks["task_a"].get("authRequired").is_none());
    }

    #[test]
    fn json_file_store_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let store = JsonFileStore::new(dir.path().join("agents.json"));
        assert!(store.load().unwrap().tasks.is_empty());
        let mut p = PersistedState::default();
        p.kv.insert("agent/trust:/w".into(), json!(true));
        store.save(&p).unwrap();
        assert_eq!(store.load().unwrap().kv["agent/trust:/w"], json!(true));
    }
}
