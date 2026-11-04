//! The prompt widget's minimap declaration: a port of `@notefig/widgets`
//! `prompt/minimap.ts`. The generic rail (the document minimap the editor
//! host draws) owns how a dot looks; this maps a widget's phase onto the
//! two-axis vocabulary and names its entry.
//!
//! Everything comes from `core.promptWidgets` — the same state the face
//! reads, so the dot can never disagree with the card. The rail calls
//! [`prompt_minimap_dot`] per widget (re-reading on
//! `PromptWidgetsApi::subscribe`) and [`prompt_minimap_title`] for the
//! tooltip, and calls `mark_seen` once a done widget scrolls into view (the
//! TS `IntersectionObserver`).

use notefig_prompt_widgets::{BlobPhase, PromptWidgetsApi, phase_of};

use super::face::derive_queue_position;

/// `MinimapDotCore`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MinimapDotCore {
    /// Settled and working states.
    Neutral,
    /// Blocked on the user.
    Attention,
    Error,
    /// Holds a result the user hasn't seen.
    Fresh,
}

/// `MinimapDotState`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MinimapDotState {
    pub core: MinimapDotCore,
    pub label: Option<String>,
    /// An empty vessel.
    pub hollow: bool,
    /// System busy.
    pub breathe: bool,
    /// Waiting.
    pub pulse: bool,
    /// A human must act.
    pub ping: bool,
}

impl MinimapDotState {
    fn quiet(core: MinimapDotCore, label: impl Into<String>) -> Self {
        Self { core, label: Some(label.into()), hollow: false, breathe: false, pulse: false, ping: false }
    }
}

/// `describeDotState`: color only where it means something, motion only for
/// live states — waiting pulses, working breathes, blocked-on-a-human pings
/// (including a completed turn nobody has looked at).
pub fn describe_dot_state(phase: BlobPhase, unseen: bool, queue_ahead: usize, issue: bool) -> MinimapDotState {
    use MinimapDotCore as C;
    match phase {
        BlobPhase::Composing => MinimapDotState { hollow: true, ..MinimapDotState::quiet(C::Neutral, "Draft") },
        BlobPhase::Sending => MinimapDotState { hollow: true, pulse: true, ..MinimapDotState::quiet(C::Neutral, "Sending…") },
        BlobPhase::Queued => MinimapDotState {
            hollow: true,
            pulse: true,
            ..MinimapDotState::quiet(
                C::Neutral,
                if queue_ahead > 0 { format!("Queued · {queue_ahead} ahead") } else { "Queued · next".into() },
            )
        },
        BlobPhase::Running => MinimapDotState { breathe: true, ..MinimapDotState::quiet(C::Neutral, "Running") },
        BlobPhase::NeedsPermission => MinimapDotState { ping: true, ..MinimapDotState::quiet(C::Attention, "Needs permission") },
        BlobPhase::NeedsAuth => MinimapDotState { ping: true, ..MinimapDotState::quiet(C::Attention, "Needs sign-in") },
        BlobPhase::NeedsAnswer => MinimapDotState { ping: true, ..MinimapDotState::quiet(C::Attention, "Needs your answer") },
        BlobPhase::Error => MinimapDotState { ping: true, ..MinimapDotState::quiet(C::Error, "Failed") },
        BlobPhase::Done => {
            let label = if issue { "Done · issue" } else { "Done" };
            if unseen {
                MinimapDotState {
                    ping: true,
                    ..MinimapDotState::quiet(if issue { C::Error } else { C::Fresh }, format!("{label} · unread"))
                }
            } else {
                MinimapDotState::quiet(if issue { C::Error } else { C::Neutral }, label)
            }
        }
    }
}

/// The dot of the widget `blob_id` (`deriveDotInputs` + `describeDotState`).
pub fn prompt_minimap_dot(prompts: &PromptWidgetsApi, blob_id: &str) -> MinimapDotState {
    let widget = prompts.get(blob_id);
    let phase = phase_of(widget.state);
    let unseen = widget.bound_turn_id.is_some() && widget.seen_turn_id != widget.bound_turn_id;
    let queue_ahead = match (&widget.bound_turn_id, prompts.round(blob_id)) {
        (Some(turn), Some(round)) if phase == BlobPhase::Queued => derive_queue_position(&round.task_turns, turn),
        _ => 0,
    };
    let issue = phase == BlobPhase::Done
        && widget.outcome.as_ref().and_then(|o| o.response.as_ref()).is_some_and(|r| r.kind == "issue");
    describe_dot_state(phase, unseen, queue_ahead, issue)
}

/// `promptEntry`'s title: the draft, else the last sent prompt, else
/// "Prompt".
pub fn prompt_minimap_title(prompts: &PromptWidgetsApi, blob_id: &str) -> String {
    let widget = prompts.get(blob_id);
    title_chain(&widget.draft, &widget.last_sent_prompt)
}

/// The title chain over its two inputs.
fn title_chain(draft: &str, last_sent: &str) -> String {
    [draft.trim(), last_sent.trim()].into_iter().find(|t| !t.is_empty()).unwrap_or("Prompt").to_string()
}

/// The editor rail's dot for this mapping (`markdown_editor::MinimapDot`).
pub fn to_editor_dot(state: MinimapDotState, title: &str) -> markdown_editor::MinimapDot {
    use markdown_editor::MinimapDotCore as E;
    markdown_editor::MinimapDot {
        title: markdown_editor::dot_title(title).into(),
        state: markdown_editor::MinimapDotState {
            core: match state.core {
                MinimapDotCore::Neutral => E::Neutral,
                MinimapDotCore::Attention => E::Attention,
                MinimapDotCore::Error => E::Error,
                MinimapDotCore::Fresh => E::Fresh,
            },
            label: state.label.map(Into::into),
            hollow: state.hollow,
            breathe: state.breathe,
            pulse: state.pulse,
            ping: state.ping,
        },
    }
}

/// `Panels::minimap`: the prompt widgets' dots for any document's rail
/// (the shell draws `MinimapRail`; a dot's click reveals its block, then
/// runs the jump).
pub fn prompt_minimap(
    _document_path: &str,
    cx: &gpui::App,
) -> Option<(markdown_editor::MinimapSource, Option<markdown_editor::MinimapJump>)> {
    use notefig_ui::CoreExt as _;
    let prompts = cx.core().try_use::<notefig_prompt_widgets::PromptWidgetsModule>()?;
    let titles = prompts.clone();
    let source: markdown_editor::MinimapSource = std::rc::Rc::new(move |widget, _cx| {
        let state = prompt_minimap_dot(&titles, &widget.id);
        let title = prompt_minimap_title(&titles, &widget.id);
        to_editor_dot(state, &title)
    });
    // The widget's `reveal` (`focusPromptDraft`): a jump lands in the
    // composer, unless the round has it hidden — then it is only shown.
    // The rail has selected the widget's block; focusing the editor there
    // enters the draft (`render_widget`'s arrival into a field that takes
    // typing), as the caret arriving from the document does.
    let jump: markdown_editor::MinimapJump = std::rc::Rc::new(move |editor, _block, widget, window, cx| {
        if reveal_focuses_composer(&prompts, &widget.id) {
            editor.update(cx, |e, cx| e.focus(window, cx));
        }
    });
    Some((source, Some(jump)))
}

/// Whether revealing the widget lands in its composer: only while the
/// field takes typing (`focusPromptDraft` finds no laid-out draft
/// otherwise).
pub fn reveal_focuses_composer(prompts: &PromptWidgetsApi, blob_id: &str) -> bool {
    notefig_prompt_widgets::capabilities_of(prompts.get(blob_id).state, false).field_editable
}

#[cfg(test)]
mod tests {
    //! The phase → dot half of `__tests__/minimap.test.ts`.
    use super::*;
    use MinimapDotCore as C;

    /// `minimap.test.ts`: "titles from draft text, then last sent prompt,
    /// then a generic label".
    #[test]
    fn titles_from_draft_text_then_last_sent_prompt_then_a_generic_label() {
        let titles = [("half typed", "earlier"), ("  ", "summarize the doc"), ("", "")].map(|(d, s)| title_chain(d, s));
        assert_eq!(titles, ["half typed", "summarize the doc", "Prompt"]);
    }

    #[test]
    fn composing_and_waiting_states_are_hollow() {
        let d = describe_dot_state(BlobPhase::Composing, false, 0, false);
        assert!(d.hollow && !d.pulse && d.core == C::Neutral);
        let d = describe_dot_state(BlobPhase::Sending, false, 0, false);
        assert!(d.hollow && d.pulse);
        assert_eq!(describe_dot_state(BlobPhase::Queued, false, 2, false).label.as_deref(), Some("Queued · 2 ahead"));
        assert_eq!(describe_dot_state(BlobPhase::Queued, false, 0, false).label.as_deref(), Some("Queued · next"));
    }

    #[test]
    fn running_breathes_and_blocked_states_ping() {
        assert!(describe_dot_state(BlobPhase::Running, false, 0, false).breathe);
        for phase in [BlobPhase::NeedsPermission, BlobPhase::NeedsAuth, BlobPhase::NeedsAnswer] {
            let d = describe_dot_state(phase, false, 0, false);
            assert!(d.ping && d.core == C::Attention, "{phase:?}");
        }
        let d = describe_dot_state(BlobPhase::Error, false, 0, false);
        assert!(d.ping && d.core == C::Error);
    }

    #[test]
    fn done_pings_until_seen_then_decays() {
        let unread = describe_dot_state(BlobPhase::Done, true, 0, false);
        assert_eq!((unread.core, unread.ping, unread.label.as_deref()), (C::Fresh, true, Some("Done · unread")));
        let seen = describe_dot_state(BlobPhase::Done, false, 0, false);
        assert_eq!((seen.core, seen.ping, seen.label.as_deref()), (C::Neutral, false, Some("Done")));
    }

    #[test]
    fn an_issue_keeps_its_error_core() {
        let unread = describe_dot_state(BlobPhase::Done, true, 0, true);
        assert_eq!((unread.core, unread.ping, unread.label.as_deref()), (C::Error, true, Some("Done · issue · unread")));
        let seen = describe_dot_state(BlobPhase::Done, false, 0, true);
        assert_eq!((seen.core, seen.ping, seen.label.as_deref()), (C::Error, false, Some("Done · issue")));
    }
}
