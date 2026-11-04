//! The prompt widget's state machine: a port of `@notefig/widgets`
//! `prompt/machine.ts`. Pure: no collections, no views.
//!
//! Every widget is in exactly one of five states. The agent's side of a
//! round arrives as [`RoundFacts`], and [`state_from_round`] is the one
//! place those facts become a state. Everything that behaves differently per
//! state asks [`capabilities_of`], never the state's name.
//!
//! Deviation: the states are `Copy` values, so "returns the same object when
//! nothing changed" is plain equality here.

use notefig_agent::model::TurnStatus;

/// What the agent is waiting on the user for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ask {
    Permission,
    Auth,
    /// The round ended on a question (a `widget_respond` kind that awaits a
    /// reply); the field takes the answer.
    Question,
}

/// A live turn's place: waiting its turn, or running.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkingTurn {
    Queued,
    Running,
}

/// How a settled round ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SettledOutcome {
    Done,
    Error,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WidgetState {
    /// Writing a prompt; `confirming_trust` while the workspace trust
    /// warning waits for a second Send.
    Composing { confirming_trust: bool },
    /// Send pressed; the session is resolving and the turn doesn't exist yet.
    Sending,
    /// The agent has a live turn.
    Working(WorkingTurn),
    /// The agent waits on the user.
    Asking(Ask),
    /// The round is over; the reply field is open.
    Settled(SettledOutcome),
}

impl WidgetState {
    /// The TS state's `name`.
    pub fn name(&self) -> &'static str {
        match self {
            WidgetState::Composing { .. } => "composing",
            WidgetState::Sending => "sending",
            WidgetState::Working(_) => "working",
            WidgetState::Asking(_) => "asking",
            WidgetState::Settled(_) => "settled",
        }
    }
}

pub const COMPOSING: WidgetState = WidgetState::Composing { confirming_trust: false };

/// The agent's side of a bound round, read off its rows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct RoundFacts {
    /// The bound turn's status; `None` when its row is gone.
    pub turn: Option<TurnStatus>,
    pub auth_required: bool,
    pub pending_permission: bool,
    /// The completed round's response waits on the user's reply.
    pub awaiting_reply: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WidgetEvent {
    TrustAsked,
    TrustAnswered,
    SendStarted,
    SendFailed,
    /// The send produced a turn; leaves `sending` for whatever it is now.
    Dispatched(RoundFacts),
    /// The bound round's rows changed.
    RoundChanged(RoundFacts),
    /// The widget no longer watches a round (Edit, dismiss, a stale turn).
    Unbound,
}

/// The state a round's facts add up to. Sign-in outranks the turn's own
/// status.
pub fn state_from_round(facts: RoundFacts) -> WidgetState {
    let Some(turn) = facts.turn else { return COMPOSING };
    if facts.auth_required && turn != TurnStatus::Completed {
        return WidgetState::Asking(Ask::Auth);
    }
    match turn {
        TurnStatus::Queued => WidgetState::Working(WorkingTurn::Queued),
        TurnStatus::Running if facts.pending_permission => WidgetState::Asking(Ask::Permission),
        TurnStatus::Running => WidgetState::Working(WorkingTurn::Running),
        TurnStatus::Error => WidgetState::Settled(SettledOutcome::Error),
        TurnStatus::Completed if facts.awaiting_reply => WidgetState::Asking(Ask::Question),
        TurnStatus::Completed => WidgetState::Settled(SettledOutcome::Done),
        TurnStatus::Cancelled => WidgetState::Settled(SettledOutcome::Cancelled),
    }
}

/// The next state. An event that doesn't apply leaves the state unchanged.
pub fn transition(state: WidgetState, event: WidgetEvent) -> WidgetState {
    match event {
        WidgetEvent::TrustAsked => match state {
            WidgetState::Composing { confirming_trust: false } => WidgetState::Composing { confirming_trust: true },
            _ => state,
        },
        WidgetEvent::TrustAnswered => match state {
            WidgetState::Composing { confirming_trust: true } => COMPOSING,
            _ => state,
        },
        // A send leaves from wherever the field takes typing.
        WidgetEvent::SendStarted => {
            if capabilities_of(state, false).field_editable {
                WidgetState::Sending
            } else {
                state
            }
        }
        WidgetEvent::SendFailed => {
            if state == WidgetState::Sending {
                COMPOSING
            } else {
                state
            }
        }
        WidgetEvent::Dispatched(facts) => {
            if state == WidgetState::Sending {
                state_from_round(facts)
            } else {
                state
            }
        }
        // While sending, the round watched is the previous one: the
        // dispatch result decides what comes next.
        WidgetEvent::RoundChanged(facts) => {
            if state == WidgetState::Sending {
                state
            } else {
                state_from_round(facts)
            }
        }
        WidgetEvent::Unbound => COMPOSING,
    }
}

/// What Escape does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Escape {
    Revert,
    Stop,
    Leave,
}

/// What a widget in a state allows. The only thing behaviour reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WidgetCapabilities {
    pub field_editable: bool,
    pub removable: bool,
    pub escape: Escape,
    /// The face reads the draft's text (sending, a question).
    pub live_draft: bool,
}

/// `capabilitiesOf(state, { summoned })`.
pub fn capabilities_of(state: WidgetState, summoned: bool) -> WidgetCapabilities {
    let caps = |field_editable, removable, escape, live_draft| WidgetCapabilities {
        field_editable,
        removable,
        escape,
        live_draft,
    };
    match state {
        WidgetState::Composing { .. } => {
            caps(true, true, if summoned { Escape::Revert } else { Escape::Leave }, false)
        }
        WidgetState::Sending => caps(false, false, Escape::Leave, true),
        WidgetState::Working(_) => caps(false, false, Escape::Stop, false),
        WidgetState::Asking(Ask::Auth) => caps(false, true, Escape::Leave, false),
        WidgetState::Asking(Ask::Permission) => caps(false, false, Escape::Stop, false),
        // The turn is over; only the answer is missing.
        WidgetState::Asking(Ask::Question) => caps(true, true, Escape::Leave, true),
        WidgetState::Settled(_) => caps(true, true, Escape::Leave, false),
    }
}

/// The face's rendering vocabulary (`BlobPhase`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlobPhase {
    Composing,
    Sending,
    Queued,
    Running,
    NeedsPermission,
    NeedsAuth,
    NeedsAnswer,
    Done,
    Error,
}

impl BlobPhase {
    pub fn as_str(self) -> &'static str {
        match self {
            BlobPhase::Composing => "composing",
            BlobPhase::Sending => "sending",
            BlobPhase::Queued => "queued",
            BlobPhase::Running => "running",
            BlobPhase::NeedsPermission => "needs-permission",
            BlobPhase::NeedsAuth => "needs-auth",
            BlobPhase::NeedsAnswer => "needs-answer",
            BlobPhase::Done => "done",
            BlobPhase::Error => "error",
        }
    }
}

/// `phaseOf`.
pub fn phase_of(state: WidgetState) -> BlobPhase {
    match state {
        WidgetState::Composing { .. } => BlobPhase::Composing,
        WidgetState::Sending => BlobPhase::Sending,
        WidgetState::Working(WorkingTurn::Queued) => BlobPhase::Queued,
        WidgetState::Working(WorkingTurn::Running) => BlobPhase::Running,
        WidgetState::Asking(Ask::Permission) => BlobPhase::NeedsPermission,
        WidgetState::Asking(Ask::Auth) => BlobPhase::NeedsAuth,
        WidgetState::Asking(Ask::Question) => BlobPhase::NeedsAnswer,
        WidgetState::Settled(SettledOutcome::Error) => BlobPhase::Error,
        WidgetState::Settled(_) => BlobPhase::Done,
    }
}

#[cfg(test)]
mod tests {
    //! `prompt/__tests__/machine.test.ts`.
    use super::*;
    use TurnStatus::*;

    fn facts(f: impl FnOnce(&mut RoundFacts)) -> RoundFacts {
        let mut facts = RoundFacts { turn: Some(Running), ..Default::default() };
        f(&mut facts);
        facts
    }

    fn states() -> Vec<(&'static str, WidgetState)> {
        vec![
            ("composing", COMPOSING),
            ("confirmingTrust", WidgetState::Composing { confirming_trust: true }),
            ("sending", WidgetState::Sending),
            ("queued", WidgetState::Working(WorkingTurn::Queued)),
            ("running", WidgetState::Working(WorkingTurn::Running)),
            ("permission", WidgetState::Asking(Ask::Permission)),
            ("auth", WidgetState::Asking(Ask::Auth)),
            ("question", WidgetState::Asking(Ask::Question)),
            ("done", WidgetState::Settled(SettledOutcome::Done)),
            ("error", WidgetState::Settled(SettledOutcome::Error)),
            ("cancelled", WidgetState::Settled(SettledOutcome::Cancelled)),
        ]
    }

    fn state(name: &str) -> WidgetState {
        states().into_iter().find(|(n, _)| *n == name).unwrap().1
    }

    #[test]
    fn follows_the_turns_status() {
        assert_eq!(state_from_round(facts(|f| f.turn = None)), COMPOSING);
        assert_eq!(state_from_round(facts(|f| f.turn = Some(Queued))), state("queued"));
        assert_eq!(state_from_round(facts(|f| f.turn = Some(Running))), state("running"));
        assert_eq!(state_from_round(facts(|f| f.turn = Some(Completed))), state("done"));
        assert_eq!(state_from_round(facts(|f| f.turn = Some(Error))), state("error"));
        assert_eq!(state_from_round(facts(|f| f.turn = Some(Cancelled))), state("cancelled"));
    }

    #[test]
    fn asks_for_a_permission_only_while_the_turn_runs() {
        assert_eq!(state_from_round(facts(|f| f.pending_permission = true)), state("permission"));
        assert_eq!(
            state_from_round(facts(|f| {
                f.turn = Some(Queued);
                f.pending_permission = true
            })),
            state("queued")
        );
    }

    #[test]
    fn asks_for_a_sign_in_over_anything_but_a_completed_turn() {
        for turn in [Queued, Running, Error, Cancelled] {
            assert_eq!(
                state_from_round(facts(|f| {
                    f.turn = Some(turn);
                    f.auth_required = true
                })),
                state("auth")
            );
        }
        assert_eq!(
            state_from_round(facts(|f| {
                f.turn = Some(Completed);
                f.auth_required = true
            })),
            state("done")
        );
    }

    #[test]
    fn asks_a_question_when_the_completed_rounds_response_awaits_a_reply() {
        assert_eq!(
            state_from_round(facts(|f| {
                f.turn = Some(Completed);
                f.awaiting_reply = true
            })),
            state("question")
        );
        assert_eq!(
            state_from_round(facts(|f| {
                f.turn = Some(Error);
                f.awaiting_reply = true
            })),
            state("error")
        );
    }

    fn every(event: WidgetEvent) -> Vec<(&'static str, WidgetState)> {
        states().into_iter().map(|(n, s)| (n, transition(s, event))).collect()
    }

    fn at(list: &[(&'static str, WidgetState)], name: &str) -> WidgetState {
        list.iter().find(|(n, _)| *n == name).unwrap().1
    }

    #[test]
    fn arms_and_answers_the_trust_warning_only_while_composing() {
        let asked = every(WidgetEvent::TrustAsked);
        assert_eq!(at(&asked, "composing"), state("confirmingTrust"));
        assert_eq!(at(&asked, "confirmingTrust"), state("confirmingTrust"));
        assert_eq!(at(&asked, "running"), state("running"));
        let answered = every(WidgetEvent::TrustAnswered);
        assert_eq!(at(&answered, "confirmingTrust"), COMPOSING);
        assert_eq!(at(&answered, "composing"), COMPOSING);
    }

    #[test]
    fn sends_from_a_composer_a_settled_round_or_a_question_nowhere_else() {
        let next = every(WidgetEvent::SendStarted);
        for name in ["composing", "confirmingTrust", "question", "done", "error", "cancelled"] {
            assert_eq!(at(&next, name), WidgetState::Sending, "{name}");
        }
        for name in ["sending", "queued", "running", "permission", "auth"] {
            assert_eq!(at(&next, name), state(name), "{name}");
        }
    }

    #[test]
    fn leaves_sending_for_the_dispatched_round_or_back_to_composing() {
        assert_eq!(
            transition(WidgetState::Sending, WidgetEvent::Dispatched(facts(|f| f.turn = Some(Queued)))),
            state("queued")
        );
        assert_eq!(transition(WidgetState::Sending, WidgetEvent::SendFailed), COMPOSING);
        assert_eq!(transition(state("done"), WidgetEvent::SendFailed), state("done"));
    }

    #[test]
    fn ignores_round_changes_while_a_send_is_in_flight() {
        assert_eq!(
            transition(WidgetState::Sending, WidgetEvent::RoundChanged(facts(|f| f.turn = Some(Completed)))),
            WidgetState::Sending
        );
    }

    #[test]
    fn follows_the_round_otherwise_keeping_the_object_when_nothing_moved() {
        assert_eq!(transition(state("queued"), WidgetEvent::RoundChanged(facts(|_| {}))), state("running"));
        assert_eq!(transition(state("running"), WidgetEvent::RoundChanged(facts(|_| {}))), state("running"));
    }

    #[test]
    fn unbinding_always_lands_on_a_fresh_composer() {
        for (_, s) in states() {
            assert_eq!(transition(s, WidgetEvent::Unbound), COMPOSING);
        }
    }

    fn names_where(pred: impl Fn(WidgetCapabilities) -> bool) -> Vec<&'static str> {
        states().into_iter().filter(|(_, s)| pred(capabilities_of(*s, false))).map(|(n, _)| n).collect()
    }

    #[test]
    fn opens_the_field_to_a_composer_a_reply_and_an_answer_nothing_else() {
        assert_eq!(
            names_where(|c| c.field_editable),
            vec!["composing", "confirmingTrust", "question", "done", "error", "cancelled"]
        );
    }

    #[test]
    fn protects_a_widget_while_the_agent_has_a_live_turn() {
        assert_eq!(names_where(|c| !c.removable), vec!["sending", "queued", "running", "permission"]);
    }

    #[test]
    fn renders_each_draft_edit_only_where_the_face_reads_the_text() {
        assert_eq!(names_where(|c| c.live_draft), vec!["sending", "question"]);
    }

    #[test]
    fn escape_stops_a_live_turn_reverts_a_fresh_summon_else_leaves() {
        assert_eq!(capabilities_of(COMPOSING, true).escape, Escape::Revert);
        assert_eq!(capabilities_of(COMPOSING, false).escape, Escape::Leave);
        for name in ["queued", "running", "permission"] {
            assert_eq!(capabilities_of(state(name), false).escape, Escape::Stop);
        }
        for name in ["sending", "auth", "question", "done", "error"] {
            assert_eq!(capabilities_of(state(name), false).escape, Escape::Leave);
        }
    }

    #[test]
    fn names_each_state_in_the_faces_vocabulary() {
        let phases: Vec<(&str, &str)> = states().into_iter().map(|(n, s)| (n, phase_of(s).as_str())).collect();
        assert_eq!(
            phases,
            vec![
                ("composing", "composing"),
                ("confirmingTrust", "composing"),
                ("sending", "sending"),
                ("queued", "queued"),
                ("running", "running"),
                ("permission", "needs-permission"),
                ("auth", "needs-auth"),
                ("question", "needs-answer"),
                ("done", "done"),
                ("error", "error"),
                ("cancelled", "done"),
            ]
        );
    }
}
