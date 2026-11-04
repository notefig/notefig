//! Port of `src/telemetry/telemetry.ts`, as a value instead of a module-scope
//! singleton: events buffer in memory while consent is pending, then flush
//! through the tier filter once [`TelemetryClient::configure`] runs.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::time::{Duration, Instant};

use serde_json::Value;

const BUFFER_CAP: usize = 25;
const ERROR_DEDUPE_WINDOW: Duration = Duration::from_secs(5);

/// Whether this build may send telemetry at all. The TS build needs a
/// PostHog key; this port ships none, so it is never available.
pub fn telemetry_available() -> bool {
    false
}

/// Where configured events go: the TS `PostHogLike`. Nothing in the app
/// implements it.
pub trait TelemetrySink {
    fn init(&self, install_id: &str);
    fn capture(&self, name: &str, properties: Option<&Value>);
    fn capture_exception(&self, message: &str, context: Option<&Value>);
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TelemetryConsent {
    pub crash_enabled: bool,
    pub analytics_enabled: bool,
}

/// "meta" is telemetry-about-telemetry (the consent answer): sent when any
/// tier is enabled.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Tier {
    Usage,
    Crash,
    Meta,
}

enum Item {
    Event(String, Option<Value>),
    Error(String, Option<Value>),
}

struct State {
    configured: bool,
    consent: TelemetryConsent,
    started: bool,
    buffer: Vec<(Tier, Item)>,
    recent_errors: HashMap<String, Instant>,
}

#[derive(Clone)]
pub struct TelemetryClient {
    available: bool,
    sink: Option<Rc<dyn TelemetrySink>>,
    state: Rc<RefCell<State>>,
}

/// A client. `available` stands for "this build has a key"; `sink` is the
/// PostHog stand-in, used only when available and some tier is on.
pub fn create_telemetry_client(available: bool, sink: Option<Rc<dyn TelemetrySink>>) -> TelemetryClient {
    TelemetryClient {
        available,
        sink,
        state: Rc::new(RefCell::new(State {
            configured: false,
            consent: TelemetryConsent::default(),
            started: false,
            buffer: Vec::new(),
            recent_errors: HashMap::new(),
        })),
    }
}

impl TelemetryClient {
    pub fn available(&self) -> bool {
        self.available
    }

    pub fn is_configured(&self) -> bool {
        self.state.borrow().configured
    }

    fn tier_enabled(consent: TelemetryConsent, tier: Tier) -> bool {
        match tier {
            Tier::Crash => consent.crash_enabled,
            Tier::Meta => consent.crash_enabled || consent.analytics_enabled,
            Tier::Usage => consent.analytics_enabled,
        }
    }

    fn dispatch(&self, tier: Tier, item: Item) {
        let mut state = self.state.borrow_mut();
        if !state.configured {
            state.buffer.push((tier, item));
            if state.buffer.len() > BUFFER_CAP {
                state.buffer.remove(0);
            }
            return;
        }
        let send = Self::tier_enabled(state.consent, tier) && state.started;
        drop(state);
        if !send {
            return;
        }
        let Some(sink) = &self.sink else { return };
        match &item {
            Item::Event(name, props) => sink.capture(name, props.as_ref()),
            Item::Error(message, ctx) => sink.capture_exception(message, ctx.as_ref()),
        }
    }

    /// Resolve consent and (if anything is enabled) start the sink, then
    /// flush the pending buffer through the tier filter. Safe to call again
    /// from the Settings toggles.
    pub fn configure(&self, consent: TelemetryConsent, install_id: Option<&str>) {
        let any = consent.crash_enabled || consent.analytics_enabled;
        let start = {
            let mut state = self.state.borrow_mut();
            state.consent = consent;
            any && self.available && install_id.is_some() && !state.started && self.sink.is_some()
        };
        if start {
            if let (Some(sink), Some(id)) = (&self.sink, install_id) {
                sink.init(id);
            }
            self.state.borrow_mut().started = true;
        }
        let pending = {
            let mut state = self.state.borrow_mut();
            state.configured = true;
            std::mem::take(&mut state.buffer)
        };
        for (tier, item) in pending {
            self.dispatch(tier, item);
        }
    }

    /// Usage-tier event (the consent answer is meta-tier).
    pub fn capture_event(&self, name: &str, properties: Option<Value>) {
        let tier = if name == "telemetry_consent_answered" { Tier::Meta } else { Tier::Usage };
        self.dispatch(tier, Item::Event(name.to_string(), properties));
    }

    /// Crash-tier error; the same message within 5 s is dropped.
    pub fn capture_error(&self, message: &str, context: Option<Value>) {
        let now = Instant::now();
        {
            let mut state = self.state.borrow_mut();
            if let Some(seen) = state.recent_errors.get(message)
                && now.duration_since(*seen) < ERROR_DEDUPE_WINDOW
            {
                return;
            }
            state.recent_errors.insert(message.to_string(), now);
        }
        self.dispatch(Tier::Crash, Item::Error(message.to_string(), context));
    }
}
