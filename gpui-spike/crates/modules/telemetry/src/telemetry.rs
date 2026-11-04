//! Port of `modules/telemetry/telemetry.ts`: `core.telemetry`.

use std::cell::Cell;
use std::collections::BTreeMap;
use std::rc::Rc;

use notefig_core::{Executor, ExecutorExt, Listeners, Subscription};
use notefig_kv::KvApi;
use serde_json::{Value, json};

use crate::client::{TelemetryClient, TelemetryConsent};
use crate::{CURRENT_TELEMETRY_CONSENT_VERSION, SETTINGS_NAMESPACE};

/// `TelemetryConsentAnswer`.
pub type TelemetryAnswer = TelemetryConsent;

/// `core.telemetry`: whether the first-run consent is still owed, and the
/// user's answer to it.
pub struct TelemetryApi {
    kv: Rc<KvApi>,
    client: TelemetryClient,
    executor: Rc<dyn Executor>,
    owed: Rc<Cell<bool>>,
    changed: Listeners<()>,
}

pub fn create_telemetry(kv: Rc<KvApi>, client: TelemetryClient, executor: Rc<dyn Executor>) -> TelemetryApi {
    TelemetryApi {
        kv,
        client,
        executor,
        owed: Rc::new(Cell::new(false)),
        changed: Listeners::new(),
    }
}

/// `crypto.randomUUID()`, without a dependency: v4-shaped, from the
/// process's random hasher keys and the clock.
pub fn new_install_id() -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut bytes = [0u8; 16];
    for (i, chunk) in bytes.chunks_mut(8).enumerate() {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
        h.write_usize(i);
        chunk.copy_from_slice(&h.finish().to_le_bytes());
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..32])
}

struct StoredConsent {
    answered: bool,
    crash_enabled: bool,
    analytics_enabled: bool,
    install_id: Option<String>,
}

/// Fail closed: a flag missing despite the answered marker reads as declined.
fn read_stored_consent(stored: &BTreeMap<String, Value>) -> StoredConsent {
    let version = stored.get("telemetryConsentVersion").and_then(Value::as_u64).unwrap_or(0);
    StoredConsent {
        answered: version >= CURRENT_TELEMETRY_CONSENT_VERSION as u64,
        crash_enabled: stored.get("crashReportingEnabled").and_then(Value::as_bool).unwrap_or(false),
        analytics_enabled: stored.get("analyticsEnabled").and_then(Value::as_bool).unwrap_or(false),
        install_id: stored.get("telemetryInstallId").and_then(Value::as_str).map(String::from),
    }
}

impl TelemetryApi {
    pub fn client(&self) -> &TelemetryClient {
        &self.client
    }

    pub fn consent_owed(&self) -> bool {
        self.owed.get()
    }

    pub fn subscribe(&self, listener: impl Fn() + 'static) -> Subscription {
        self.changed.subscribe(move |_| listener())
    }

    fn set_owed(owed: &Cell<bool>, changed: &Listeners<()>, next: bool) {
        owed.set(next);
        changed.emit();
    }

    /// Configure from stored consent, or arm the first-run dialog. Boot runs
    /// this once.
    pub fn start(&self) {
        let (kv, client, owed, changed) = (self.kv.clone(), self.client.clone(), self.owed.clone(), self.changed.clone());
        self.executor.spawn_local(async move {
            if !client.available() {
                // Keyless build: resolve the buffer as fully disabled, never ask.
                client.configure(TelemetryConsent::default(), None);
                return;
            }
            let stored = kv.read_all::<Value>(SETTINGS_NAMESPACE).await;
            let consent = read_stored_consent(&stored);
            if !consent.answered {
                Self::set_owed(&owed, &changed, true);
                return;
            }
            let any = consent.crash_enabled || consent.analytics_enabled;
            let mut install_id = consent.install_id;
            if any && install_id.is_none() {
                let id = new_install_id();
                if let Err(err) = kv.write(SETTINGS_NAMESPACE, "telemetryInstallId", &id).await {
                    log::error!("[telemetry] startup failed: {err:#}");
                    client.configure(TelemetryConsent::default(), None);
                    return;
                }
                install_id = Some(id);
            }
            client.configure(
                TelemetryConsent { crash_enabled: consent.crash_enabled, analytics_enabled: consent.analytics_enabled },
                install_id.as_deref(),
            );
            client.capture_event("app_opened", None);
        });
    }

    /// The first-run dialog's answer. `telemetryConsentVersion` is written
    /// last: it is the "answered" marker.
    pub fn answer(&self, answer: TelemetryAnswer) {
        Self::set_owed(&self.owed, &self.changed, false);
        let (kv, client) = (self.kv.clone(), self.client.clone());
        self.executor.spawn_local(async move {
            let any = answer.crash_enabled || answer.analytics_enabled;
            let install_id = if any {
                Some(kv.read::<String>(SETTINGS_NAMESPACE, "telemetryInstallId").await.unwrap_or_else(new_install_id))
            } else {
                None
            };
            let mut entries: Vec<(&str, Value)> = vec![
                ("crashReportingEnabled", json!(answer.crash_enabled)),
                ("analyticsEnabled", json!(answer.analytics_enabled)),
            ];
            if let Some(id) = &install_id {
                entries.push(("telemetryInstallId", json!(id)));
            }
            entries.push(("telemetryConsentVersion", json!(CURRENT_TELEMETRY_CONSENT_VERSION)));
            for (key, value) in entries {
                if let Err(err) = kv.write(SETTINGS_NAMESPACE, key, &value).await {
                    // Honor the answer for this session; the dialog re-asks next launch.
                    log::error!("[telemetry] failed to persist consent: {err:#}");
                    break;
                }
            }
            client.configure(answer, install_id.as_deref());
            client.capture_event(
                "telemetry_consent_answered",
                Some(json!({ "crash_enabled": answer.crash_enabled, "analytics_enabled": answer.analytics_enabled })),
            );
            client.capture_event("app_opened", None);
        });
    }

    /// Live consent changes from Settings → Privacy (`updateTelemetryConsent`).
    pub fn update_consent(&self, consent: TelemetryConsent, install_id: Option<&str>) {
        self.client.configure(consent, install_id);
    }
}
