//! The tab-id scheme (`modules/tabs/tab-id.ts`): the one place that knows
//! how a dock tab id encodes what the tab shows. File tabs are absolute
//! paths; a scheme prefix marks every other kind.

pub const AGENT_TAB_PREFIX: &str = "agent:";
/// The singleton release-notes tab.
pub const RELEASE_NOTES_TAB_ID: &str = "release:";

/// `TabKind`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum TabKind {
    File,
    Agent,
    ReleaseNotes,
}

/// `TabRef`: a tab id decoded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TabRef {
    File { tab_id: String, path: String },
    Agent { tab_id: String, task_id: String },
    ReleaseNotes { tab_id: String },
}

impl TabRef {
    pub fn kind(&self) -> TabKind {
        match self {
            TabRef::File { .. } => TabKind::File,
            TabRef::Agent { .. } => TabKind::Agent,
            TabRef::ReleaseNotes { .. } => TabKind::ReleaseNotes,
        }
    }
}

pub fn agent_tab_id(task_id: &str) -> String {
    format!("{AGENT_TAB_PREFIX}{task_id}")
}

pub fn is_agent_tab_id(tab_id: &str) -> bool {
    tab_id.starts_with(AGENT_TAB_PREFIX)
}

pub fn agent_task_id_from_tab_id(tab_id: &str) -> Option<&str> {
    tab_id.strip_prefix(AGENT_TAB_PREFIX)
}

pub fn is_release_notes_tab_id(tab_id: &str) -> bool {
    tab_id == RELEASE_NOTES_TAB_ID
}

/// The single place that decodes a tab id.
pub fn parse_tab_id(tab_id: &str) -> TabRef {
    if is_release_notes_tab_id(tab_id) {
        return TabRef::ReleaseNotes { tab_id: tab_id.into() };
    }
    if let Some(task_id) = agent_task_id_from_tab_id(tab_id) {
        return TabRef::Agent { tab_id: tab_id.into(), task_id: task_id.into() };
    }
    TabRef::File { tab_id: tab_id.into(), path: tab_id.into() }
}

pub fn tab_kind(tab_id: &str) -> TabKind {
    parse_tab_id(tab_id).kind()
}

pub fn is_file_tab_id(tab_id: &str) -> bool {
    tab_kind(tab_id) == TabKind::File
}

/// The file a tab shows: its id when it is a file tab.
pub fn file_tab_path(tab_id: Option<&str>) -> Option<&str> {
    tab_id.filter(|t| is_file_tab_id(t))
}
