//! `PlatformUpdater` (`adapters/platform-adapter.interface.ts`): the
//! platform's `updates` surface. The native build has no update channel
//! yet, so it carries [`NoopUpdater`], which answers "up to date".

use futures::FutureExt;
use futures::future::LocalBoxFuture;
use futures::stream::LocalBoxStream;
use serde::{Deserialize, Serialize};

/// `UpdateFlow`: a desktop downloads then restarts; the web reloads.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UpdateFlow {
    #[default]
    DownloadRestart,
    Refresh,
}

/// `UpdateCheckResult`.
#[derive(Debug, Clone, PartialEq)]
pub enum UpdateCheckResult {
    Available { flow: UpdateFlow, version: String, body: Option<String> },
    UpToDate { flow: UpdateFlow },
    Error { error: String },
}

/// `UpdateApplyProgress`.
#[derive(Debug, Clone, PartialEq)]
pub enum UpdateApplyProgress {
    Downloading { downloaded: u64, total: Option<u64> },
    Ready,
    Applied,
    Error { error: String },
}

/// `UpdateRestartResult`.
#[derive(Debug, Clone, PartialEq)]
pub enum UpdateRestartResult {
    Restarted,
    Error { error: String },
}

/// `PlatformUpdater`.
pub trait PlatformUpdater {
    fn check(&self) -> LocalBoxFuture<'static, UpdateCheckResult>;
    /// `apply(): AsyncGenerator<UpdateApplyProgress>`.
    fn apply(&self) -> LocalBoxStream<'static, UpdateApplyProgress>;
    fn restart(&self) -> LocalBoxFuture<'static, UpdateRestartResult>;
}

/// A build with no update channel: always up to date.
pub struct NoopUpdater;

impl PlatformUpdater for NoopUpdater {
    fn check(&self) -> LocalBoxFuture<'static, UpdateCheckResult> {
        futures::future::ready(UpdateCheckResult::UpToDate { flow: UpdateFlow::DownloadRestart }).boxed_local()
    }

    fn apply(&self) -> LocalBoxStream<'static, UpdateApplyProgress> {
        Box::pin(futures::stream::iter([UpdateApplyProgress::Error {
            error: "this build has no update channel".into(),
        }]))
    }

    fn restart(&self) -> LocalBoxFuture<'static, UpdateRestartResult> {
        futures::future::ready(UpdateRestartResult::Error { error: "this build has no update channel".into() })
            .boxed_local()
    }
}
