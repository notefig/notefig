//! Notefig's agent protocol and process layer, runtime-agnostic and
//! gpui-free (the TS `packages/agent` plus `src-tauri`'s `agent_proc` and
//! `mcp_bridge`): the ACP client, newline JSON-RPC, the harness process host
//! (login-shell PATH, env scrub, sidecar resolution, process-group kill),
//! harness definitions and install discovery, the app MCP server and its
//! stdio relay, prompt composition, the markdown joiner, the shared agent
//! row shapes and usage normalization.
//!
//! The agent service (tasks, turns, the store, the facade) is the `agents`
//! module (`notefig-agents`); harness quirks are `notefig-harness-adapters`.

pub mod acp;
pub mod harness;
pub mod ids;
pub mod joiner;
pub mod mcp;
pub mod model;
pub mod paths;
pub mod process;
pub mod prompt;
pub mod rpc;
pub mod services;
pub mod usage;

pub use model::*;
pub use prompt::{PromptExtras, WidgetPromptSource};
pub use services::{AppToolCall, ChannelServices, ClientRequest, ClientServices, DiskServices, Reply};
