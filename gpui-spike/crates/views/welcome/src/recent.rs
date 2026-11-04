//! Recent projects and opening one: `hooks/use-recent-projects.ts` and
//! `hooks/use-open-project.ts`. The rows live in the KV namespace
//! `recentProjects` (path → name, last opened), as in TS.

use std::rc::Rc;

use futures::FutureExt;
use futures::future::LocalBoxFuture;
use notefig_core::Core;
use notefig_kv::{KvApi, KvModule};
use notefig_platform::PlatformService;
use serde::{Deserialize, Serialize};

pub const RECENT_PROJECTS_NAMESPACE: &str = "recentProjects";
const MAX_RECENT_PROJECTS: usize = 20;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentProject {
    pub name: String,
    pub last_opened_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecentProjectDisplay {
    pub path: String,
    pub name: String,
    pub last_opened_at: i64,
    pub last_modified: String,
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// `deriveProjectName`: the folder's name.
pub fn derive_project_name(path: &str) -> String {
    path.split(['/', '\\']).filter(|s| !s.is_empty()).next_back().unwrap_or("Untitled").to_string()
}

/// `formatTimeAgo`.
pub fn format_time_ago(timestamp: i64, now: i64) -> String {
    let seconds = (now - timestamp).max(0) / 1000;
    let (minutes, hours) = (seconds / 60, seconds / 3600);
    let (days, weeks) = (hours / 24, hours / 24 / 7);
    let plural = |n: i64, unit: &str| format!("{n} {unit}{} ago", if n == 1 { "" } else { "s" });
    if seconds < 60 {
        "just now".into()
    } else if minutes < 60 {
        plural(minutes, "minute")
    } else if hours < 24 {
        plural(hours, "hour")
    } else if days < 7 {
        plural(days, "day")
    } else if weeks < 4 {
        plural(weeks, "week")
    } else {
        // `toLocaleDateString` (en-US): M/D/YYYY.
        let days_since_epoch = timestamp / 86_400_000;
        let (y, m, d) = civil_from_days(days_since_epoch);
        format!("{m}/{d}/{y}")
    }
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

/// The recent projects, newest first (`getRecentProjects`).
pub fn recent_projects(kv: &KvApi, now: i64) -> Vec<RecentProjectDisplay> {
    let rows = kv.collection(RECENT_PROJECTS_NAMESPACE);
    let mut out: Vec<RecentProjectDisplay> = rows
        .entries()
        .into_iter()
        .filter_map(|(path, v)| {
            let p: RecentProject = serde_json::from_value(v).ok()?;
            Some(RecentProjectDisplay { last_modified: format_time_ago(p.last_opened_at, now), path, name: p.name, last_opened_at: p.last_opened_at })
        })
        .collect();
    out.sort_by(|a, b| b.last_opened_at.cmp(&a.last_opened_at));
    out
}

/// `addRecentProject`: record it, keeping the newest 20.
pub fn add_recent_project(kv: &Rc<KvApi>, path: &str, now: i64) -> LocalBoxFuture<'static, ()> {
    let kv = kv.clone();
    let path = path.to_string();
    async move {
        let row = RecentProject { name: derive_project_name(&path), last_opened_at: now };
        if let Err(err) = kv.write(RECENT_PROJECTS_NAMESPACE, &path, &row).await {
            log::error!("recording recent project failed: {err:#}");
        }
        let mut all: Vec<(String, i64)> = kv
            .read_all::<RecentProject>(RECENT_PROJECTS_NAMESPACE)
            .await
            .into_iter()
            .map(|(k, v)| (k, v.last_opened_at))
            .collect();
        if all.len() > MAX_RECENT_PROJECTS {
            all.sort_by_key(|(_, at)| *at);
            let excess = all.len() - MAX_RECENT_PROJECTS;
            for (key, _) in all.into_iter().take(excess) {
                let _ = kv.remove(RECENT_PROJECTS_NAMESPACE, &key).await;
            }
        }
    }
    .boxed_local()
}

/// `useOpenProject`: record it as recent, then open (and enter) it.
/// Resolves to whether it opened.
pub fn open_project(core: &Core, path: &str) -> LocalBoxFuture<'static, bool> {
    let record = add_recent_project(&core.use_::<KvModule>(), path, now_ms());
    let open = core.workspace(path).open();
    let path = path.to_string();
    async move {
        record.await;
        match open.await {
            Ok(()) => true,
            Err(err) => {
                log::error!("Failed to open {path}: {err}");
                false
            }
        }
    }
    .boxed_local()
}

/// `useOpenProjectFromPicker`: the platform's folder picker, then
/// [`open_project`]. A cancelled picker opens nothing.
pub fn open_project_from_picker(core: &Core) -> LocalBoxFuture<'static, bool> {
    let pick = core.service::<PlatformService>().ui.pick_directory("Open Workspace");
    let core = core.clone();
    async move {
        match pick.await {
            Some(path) => open_project(&core, &path).await,
            None => false,
        }
    }
    .boxed_local()
}

#[cfg(test)]
mod tests {
    use super::*;
    use notefig_core::testing::TestExecutor;
    use notefig_kv::create_kv;
    use notefig_platform::fake::FakePlatform;

    #[test]
    fn records_newest_first_and_caps_at_twenty() {
        let exec = TestExecutor::new();
        let fake = FakePlatform::new();
        let kv = Rc::new(create_kv(fake.db.clone()));
        for i in 0..22 {
            exec.block_on(add_recent_project(&kv, &format!("/p/ws{i}"), 1_000 * i));
        }
        let list = recent_projects(&kv, 30_000);
        assert_eq!(list.len(), 20);
        assert_eq!(list[0].path, "/p/ws21");
        assert_eq!(list[0].name, "ws21");
        assert_eq!(list[0].last_modified, "just now");
        assert!(!list.iter().any(|p| p.path == "/p/ws0"));
    }

    #[test]
    fn time_ago_matches_format_ts() {
        let now = 10 * 86_400_000;
        assert_eq!(format_time_ago(now - 61_000, now), "1 minute ago");
        assert_eq!(format_time_ago(now - 2 * 3_600_000, now), "2 hours ago");
        assert_eq!(format_time_ago(now - 3 * 86_400_000, now), "3 days ago");
        assert_eq!(format_time_ago(0, 40 * 86_400_000), "1/1/1970");
        assert_eq!(derive_project_name("/a/b/"), "b");
    }
}
