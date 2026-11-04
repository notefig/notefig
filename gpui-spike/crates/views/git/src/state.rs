//! The panel's pure derivations, as `checkpoint-panel.tsx` writes them:
//! what state the panel is in, what an error says, which recovery actions
//! it offers. No GPUI here, so they are tested directly.

use notefig_git::{GitCheckpointRow, GitSummary, SyncState};
use notefig_history::{HistoryError, HistoryErrorCode};
use notefig_i18n::t;

/// `PanelState`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PanelState {
    Uninitialized,
    Error,
    Empty,
    Ready,
}

/// `CheckpointListItem`: a row as the list shows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckpointItem {
    /// The oid, or `"pending-save"` for an in-flight save.
    pub id: String,
    /// Epoch ms.
    pub timestamp: i64,
    /// 7 chars, or `"pending"`.
    pub hash: String,
    pub message: String,
}

impl CheckpointItem {
    pub fn is_pending(&self) -> bool {
        self.hash == "pending"
    }
}

/// `RecoveryAction`'s id: what a recovery button does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActionKind {
    Initialize,
    Repair,
    Retry,
    /// The empty state's "Commit" (TS gives it the id `"retry"` but saves).
    Save,
    Abort,
    Dismiss,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecoveryAction {
    pub kind: ActionKind,
    pub label: String,
    pub disabled: bool,
}

impl RecoveryAction {
    fn new(kind: ActionKind, label: String) -> Self {
        Self { kind, label, disabled: false }
    }
}

/// `getErrorPresentation`: a title and a message for an error.
pub fn error_presentation(error: &HistoryError) -> (String, String) {
    match error.code {
        HistoryErrorCode::RepoNotFound => {
            (t("timelineNotInitializedTitle"), t("timelineNotInitializedMessage"))
        }
        HistoryErrorCode::LockUnavailable => (t("timelineBusyTitle"), t("timelineBusyMessage")),
        HistoryErrorCode::CorruptRepository => {
            (t("timelineCorruptTitle"), t("timelineCorruptMessage"))
        }
        HistoryErrorCode::MergeRequired => {
            (t("timelineMergeRequiredTitle"), t("timelineMergeRequiredMessage"))
        }
        HistoryErrorCode::InvalidInput => (t("timelineInvalidInputTitle"), error.message.clone()),
        // TS `UnsupportedOperation` never arises from the native repo.
        HistoryErrorCode::Io | HistoryErrorCode::Unknown => (t("timelineUnexpectedTitle"), error.message.clone()),
    }
}

/// `firstPanelError`.
pub fn first_panel_error(summary: Option<&GitSummary>, initialize_error: Option<&HistoryError>) -> Option<HistoryError> {
    initialize_error
        .cloned()
        .or_else(|| summary.and_then(|s| s.status_error.clone()))
        .or_else(|| summary.and_then(|s| s.log_error.clone()))
}

/// `visiblePanelError`: only once the panel is in error state.
pub fn visible_panel_error(
    render_state: PanelState,
    summary: Option<&GitSummary>,
    initialize_error: Option<&HistoryError>,
) -> Option<HistoryError> {
    if render_state != PanelState::Error {
        return None;
    }
    first_panel_error(summary, initialize_error)
}

/// `deriveCanSave`.
pub fn derive_can_save(render_state: PanelState, summary: Option<&GitSummary>) -> bool {
    render_state != PanelState::Uninitialized && summary.is_some_and(|s| s.has_changes)
}

/// `derivePanelState`.
pub fn derive_panel_state(
    summary: Option<&GitSummary>,
    initialize_error: Option<&HistoryError>,
    checkpoints: &[CheckpointItem],
) -> PanelState {
    let empty = checkpoints.is_empty();
    if summary.is_some_and(|s| !s.initialized) && empty {
        return PanelState::Uninitialized;
    }
    if first_panel_error(summary, initialize_error).is_some() {
        return PanelState::Error;
    }
    if empty { PanelState::Empty } else { PanelState::Ready }
}

/// `getSyncStatePresentation`: the status chip's label and Lucide icon.
pub fn sync_state_presentation(state: SyncState) -> (String, &'static str) {
    match state {
        SyncState::Uncommitted => (t("timelineStateUncommitted"), "circle-dashed"),
        SyncState::Unsynced => (t("timelineStateUnsynced"), "cloud-upload"),
        SyncState::Synced => (t("timelineStateSynced"), "check"),
    }
}

/// `useCheckpointItems`: the rows shaped for the list, an in-flight save
/// first as a pending entry. Render-level only — never a row in the git
/// module (see `notefig_git`'s save race).
pub fn checkpoint_items(rows: &[GitCheckpointRow], pending_save: Option<&str>, now_ms: i64) -> Vec<CheckpointItem> {
    let mut items: Vec<CheckpointItem> = rows
        .iter()
        .map(|row| CheckpointItem {
            id: if row.oid.is_empty() { row.id.clone() } else { row.oid.clone() },
            timestamp: row.timestamp,
            hash: row.hash.clone(),
            message: row.message.clone(),
        })
        .collect();
    if let Some(description) = pending_save {
        let message = description.trim();
        items.insert(
            0,
            CheckpointItem {
                id: "pending-save".into(),
                timestamp: now_ms,
                hash: "pending".into(),
                message: if message.is_empty() { "Commit".into() } else { message.into() },
            },
        );
    }
    items
}

/// `getRecoveryActions`.
pub fn recovery_actions(error: &HistoryError) -> Vec<RecoveryAction> {
    match error.code {
        HistoryErrorCode::RepoNotFound => vec![RecoveryAction::new(ActionKind::Initialize, t("initializeTimeline"))],
        HistoryErrorCode::CorruptRepository => vec![RecoveryAction::new(ActionKind::Repair, t("repairTimeline"))],
        _ => vec![RecoveryAction::new(ActionKind::Retry, t("retry"))],
    }
}

/// `buildRevertActions`.
pub fn revert_actions(revert_error: Option<&HistoryError>, aborting: bool) -> Vec<RecoveryAction> {
    match revert_error {
        None => vec![],
        Some(e) if e.code == HistoryErrorCode::MergeRequired => {
            vec![RecoveryAction { kind: ActionKind::Abort, label: t("abortRevert"), disabled: aborting }]
        }
        Some(_) => vec![RecoveryAction::new(ActionKind::Dismiss, t("dismiss"))],
    }
}

/// `buildListActions`.
pub fn list_actions(
    state: PanelState,
    panel_error: Option<&HistoryError>,
    can_save: bool,
    saving: bool,
) -> Vec<RecoveryAction> {
    match state {
        PanelState::Uninitialized => vec![RecoveryAction::new(ActionKind::Initialize, t("initializeTimeline"))],
        PanelState::Empty => {
            vec![RecoveryAction { kind: ActionKind::Save, label: t("saveCheckpoint"), disabled: !can_save || saving }]
        }
        _ => panel_error.map(recovery_actions).unwrap_or_default(),
    }
}

/// `buildListMessage`.
pub fn list_message(state: PanelState, error: Option<&HistoryError>) -> Option<String> {
    match state {
        PanelState::Uninitialized => Some(t("timelineNotInitializedMessage")),
        PanelState::Empty => Some(t("noCheckpointsYet")),
        _ => error.map(|e| error_presentation(e).1),
    }
}

/// date-fns' `formatDistanceToNow(…, { addSuffix: true })`, for a row with
/// no message (rows always fall back to "Commit", so this is rare).
pub fn distance_to_now(then_ms: i64, now_ms: i64) -> String {
    let secs = ((now_ms - then_ms).abs() / 1000) as f64;
    let mins = (secs / 60.0).round();
    let phrase = if secs < 30.0 {
        "less than a minute".to_string()
    } else if mins < 2.0 {
        "1 minute".into()
    } else if mins < 45.0 {
        format!("{mins} minutes")
    } else if mins < 90.0 {
        "about 1 hour".into()
    } else if mins < 1440.0 {
        format!("about {} hours", (mins / 60.0).round())
    } else if mins < 2520.0 {
        "1 day".into()
    } else if mins < 43200.0 {
        format!("{} days", (mins / 1440.0).round())
    } else if mins < 86400.0 {
        "about 1 month".into()
    } else if mins < 525600.0 {
        format!("{} months", (mins / 43200.0).round())
    } else {
        format!("about {} years", (mins / 525600.0).floor())
    };
    if now_ms >= then_ms { format!("{phrase} ago") } else { format!("in {phrase}") }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summary(initialized: bool, has_changes: bool) -> GitSummary {
        GitSummary {
            initialized,
            branch: "main".into(),
            ahead: None,
            behind: None,
            status_error: if initialized {
                None
            } else {
                Some(HistoryError::new(HistoryErrorCode::RepoNotFound, "no repo"))
            },
            log_error: None,
            has_changes,
        }
    }

    fn item(id: &str) -> CheckpointItem {
        CheckpointItem { id: id.into(), timestamp: 0, hash: id[..7.min(id.len())].into(), message: "m".into() }
    }

    #[test]
    fn an_uninitialized_repo_with_no_rows_asks_to_initialize() {
        let s = summary(false, false);
        let state = derive_panel_state(Some(&s), None, &[]);
        assert_eq!(state, PanelState::Uninitialized);
        assert_eq!(list_actions(state, None, false, false)[0].kind, ActionKind::Initialize);
        assert_eq!(list_message(state, None).unwrap(), "Project commit history is not initialized.");
        assert!(!derive_can_save(state, Some(&s)));
    }

    #[test]
    fn errors_win_over_empty_and_offer_recovery() {
        let mut s = summary(true, false);
        s.log_error = Some(HistoryError::new(HistoryErrorCode::CorruptRepository, "bad"));
        let state = derive_panel_state(Some(&s), None, &[]);
        assert_eq!(state, PanelState::Error);
        let err = visible_panel_error(state, Some(&s), None).unwrap();
        assert_eq!(list_actions(state, Some(&err), false, false)[0].kind, ActionKind::Repair);
        assert_eq!(list_message(state, Some(&err)).unwrap(), "Project commit history metadata is inconsistent.");
        // An initialize failure comes first.
        let init = HistoryError::new(HistoryErrorCode::LockUnavailable, "busy");
        assert_eq!(first_panel_error(Some(&s), Some(&init)), Some(init.clone()));
        assert_eq!(recovery_actions(&init)[0].kind, ActionKind::Retry);
    }

    #[test]
    fn empty_offers_a_commit_only_when_there_are_changes() {
        let s = summary(true, true);
        let state = derive_panel_state(Some(&s), None, &[]);
        assert_eq!(state, PanelState::Empty);
        let can = derive_can_save(state, Some(&s));
        assert!(can);
        assert!(!list_actions(state, None, can, false)[0].disabled);
        assert!(list_actions(state, None, can, true)[0].disabled);
        assert!(list_actions(state, None, false, false)[0].disabled);
    }

    #[test]
    fn a_pending_save_shows_first_and_makes_the_list_ready() {
        let rows = vec![GitCheckpointRow {
            id: "cp:abc".into(),
            oid: "abcdef0123".into(),
            hash: "abcdef0".into(),
            message: "old".into(),
            timestamp: 5,
        }];
        let items = checkpoint_items(&rows, Some("  "), 99);
        assert_eq!(items.len(), 2);
        assert!(items[0].is_pending());
        assert_eq!(items[0].message, "Commit");
        assert_eq!(items[1].id, "abcdef0123");
        assert_eq!(derive_panel_state(Some(&summary(true, false)), None, &items), PanelState::Ready);
        assert_eq!(derive_panel_state(Some(&summary(false, false)), None, &[item("pending")]), PanelState::Error);
    }

    #[test]
    fn a_merge_conflict_offers_abort_anything_else_dismiss() {
        let merge = HistoryError::new(HistoryErrorCode::MergeRequired, "x");
        assert_eq!(revert_actions(Some(&merge), true), vec![RecoveryAction {
            kind: ActionKind::Abort,
            label: "Abort revert".into(),
            disabled: true
        }]);
        let other = HistoryError::new(HistoryErrorCode::Io, "disk");
        assert_eq!(revert_actions(Some(&other), false)[0].kind, ActionKind::Dismiss);
        assert!(revert_actions(None, false).is_empty());
        assert_eq!(error_presentation(&other), ("Timeline error".to_string(), "disk".into()));
    }

    #[test]
    fn sync_chip_reads_the_summary() {
        assert_eq!(sync_state_presentation(SyncState::Synced), ("Synced".to_string(), "check"));
        assert_eq!(sync_state_presentation(SyncState::Uncommitted).0, "Unchecked");
    }

    #[test]
    fn distance_reads_like_date_fns() {
        assert_eq!(distance_to_now(0, 10_000), "less than a minute ago");
        assert_eq!(distance_to_now(0, 5 * 60_000), "5 minutes ago");
        assert_eq!(distance_to_now(0, 3 * 3_600_000), "about 3 hours ago");
        assert_eq!(distance_to_now(0, 3 * 86_400_000), "3 days ago");
    }
}
