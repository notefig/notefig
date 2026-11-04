//! The composition root: the one place the app's core is assembled — a
//! port of `packages/desktop/src/core/app-core.ts`. Core orders modules by
//! their `needs`, so a list reads as "what this root runs", not "in which
//! order". Other owners add their module markers here, one line each, once
//! their crate is green.

use std::rc::Rc;

use notefig_core::{Core, CoreConfigError, CreateCoreOptions, Executor, ModuleRef, Services};
use notefig_layout::{UrlService, UrlState};
use notefig_platform::{Platform, PlatformService};

/// What every root that renders a workspace needs running.
pub fn runtime_modules() -> Vec<ModuleRef> {
    vec![
        ModuleRef::of::<notefig_kv::KvModule>(),
        ModuleRef::of::<notefig_workspaces::WorkspacesModule>(),
        ModuleRef::of::<notefig_layout::LayoutModule>(),
        ModuleRef::of::<notefig_tabs::TabsModule>(),
        ModuleRef::of::<notefig_editors::EditorsModule>(),
        ModuleRef::of::<notefig_documents::DocumentsModule>(),
        ModuleRef::of::<notefig_sidebar_view::SidebarViewModule>(),
        // Per open workspace: `core.workspace(ws).get::<FilesModule>()`…
        ModuleRef::of::<notefig_files::FilesModule>(),
        ModuleRef::of::<notefig_tree_model::TreeModelModule>(),
        ModuleRef::of::<notefig_tree_expansion::TreeExpansionModule>(),
        ModuleRef::of::<notefig_tree_inline_edit::TreeInlineEditModule>(),
        ModuleRef::of::<notefig_scratchpads::ScratchpadsModule>(),
        // Entering a workspace lands on its most recent scratchpad.
        ModuleRef::of::<notefig_scratchpads::ScratchpadLandingModule>(),
        ModuleRef::of::<notefig_project_settings::ProjectSettingsModule>(),
        ModuleRef::of::<notefig_recent_documents::RecentDocumentsModule>(),
        ModuleRef::of::<notefig_seen::SeenModule>(),
        // Diff fences in rendered markdown draw as diffs.
        ModuleRef::of::<notefig_diff_blocks::DiffBlocksModule>(),
        ModuleRef::of::<notefig_sidebar_view::LastToolModule>(),
        // Per open workspace: its checkpoint repo and timeline (the Git tab).
        ModuleRef::of::<notefig_history_module::HistoryModule>(),
        ModuleRef::of::<notefig_git::GitModule>(),
        ModuleRef::of::<notefig_usage::UsageModule>(),
        // `history_*` MCP tools for agents, over the per-workspace history.
        ModuleRef::of::<notefig_history_module::HistoryToolsModule>(),
        ModuleRef::of::<notefig_prompt_rounds::PromptRoundsModule>(),
        ModuleRef::of::<notefig_turn_writes::TurnWritesModule>(),
        ModuleRef::of::<notefig_agents::AgentStoreModule>(),
        // `@model:` and `@skill:` in the composers.
        ModuleRef::of::<notefig_directives::AgentDirectivesModule>(),
        // Every prompt widget's state.
        ModuleRef::of::<notefig_prompt_widgets::PromptWidgetsModule>(),
        ModuleRef::of::<notefig_harness_adapters::HarnessAdaptersModule>(),
        ModuleRef::of::<notefig_agents::AgentsModule>(),
        ModuleRef::of::<notefig_shared_sessions::SharedSessionsModule>(),
        // Settled turns the user hasn't seen: sessions, rail badge, menu-bar status.
        ModuleRef::of::<notefig_attention::AttentionModule>(),
        ModuleRef::of::<notefig_i18n::I18nModule>(),
        // "Send Feedback": available only in builds given a support URL.
        ModuleRef::of::<notefig_feedback::FeedbackModule>(),
    ]
}

/// The desktop shell.
pub fn desktop_modules() -> Vec<ModuleRef> {
    let mut modules = runtime_modules();
    modules.extend([
        // Reopen the workspaces the user left open.
        ModuleRef::of::<notefig_workspaces::RestoreWorkspacesModule>(),
        // Restore and record the last session's URL.
        ModuleRef::of::<notefig_session::SessionModule>(),
        ModuleRef::of::<notefig_telemetry::TelemetryModule>(),
        ModuleRef::of::<notefig_tunnel::TunnelModule>(),
        ModuleRef::of::<notefig_app_status::AppStatusModule>(),
        ModuleRef::of::<notefig_dictation::DictationModule>(),
        ModuleRef::of::<notefig_updater::UpdaterModule>(),
        ModuleRef::of::<notefig_migration::MigrationModule>(),
    ]);
    modules
}

/// `workspaceKey`: one key per workspace however its path is spelled.
pub fn workspace_key(path: &str) -> String {
    notefig_files::paths::workspace_key(path)
}

/// Build the root's core: the platform and the URL are its services, handed
/// to every module that names them (`createAppCore`).
pub fn create_app_core(
    modules: Vec<ModuleRef>,
    platform: Rc<Platform>,
    url: Rc<dyn UrlState>,
    executor: Rc<dyn Executor>,
) -> Result<Core, CoreConfigError> {
    Core::new(
        CreateCoreOptions::new(executor)
            .services(Services::new().with::<PlatformService>(platform).with::<UrlService>(url))
            .modules(modules)
            .workspace_key(workspace_key)
            .on_error(|err, hook| log::error!("{hook}: {err:#}")),
    )
}
