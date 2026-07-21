//! Library crate for the Metrists desktop backend.
//!
//! Holds the Tauri command modules and the single `register_handlers`
//! registration shared by three consumers so the 27-command handler list has
//! exactly one source of truth (MET-73):
//!   - the app binary (`main.rs`) on the real `Wry` runtime,
//!   - the `MockRuntime` dispatch tests (`test_support`),
//!   - the real-backend e2e shim (`bin/test-shim.rs`).

pub mod agent_proc;
pub mod file_watcher;
pub mod fs_ops;
pub mod mcp_bridge;
pub mod search;
pub mod walkdir_utils;

#[cfg(test)]
mod test_support;

/// Registers every `#[tauri::command]` the app exposes on a builder. Generic
/// over the runtime so the same registration drives the real `Wry` runtime, the
/// test `MockRuntime`, and the shim's mock app — no mirrored copy to drift.
pub fn register_handlers<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.invoke_handler(tauri::generate_handler![
        // File system commands (errors-as-values pattern)
        fs_ops::read_directory,
        fs_ops::create_directories,
        fs_ops::delete_directories,
        fs_ops::move_directory,
        fs_ops::read_files,
        fs_ops::read_binary_files,
        fs_ops::write_files,
        fs_ops::create_files,
        fs_ops::delete_files,
        fs_ops::move_file,
        fs_ops::copy_file,
        fs_ops::check_exists,
        fs_ops::get_metadata,
        fs_ops::write_binary_files,
        // File watcher commands
        file_watcher::start_watching_metadata,
        file_watcher::start_watching_content,
        file_watcher::stop_watching,
        // Search commands
        search::search_content,
        // Agent process host (errors-as-values pattern)
        agent_proc::spawn_agent,
        agent_proc::write_agent_stdin,
        agent_proc::kill_agent,
        agent_proc::run_shell_command,
        // MCP tool bridge (Stage 3.5, errors-as-values pattern)
        mcp_bridge::start_mcp_relay,
        mcp_bridge::stop_mcp_relay,
        mcp_bridge::write_mcp_line,
    ])
}
