//! The in-document prompt widget: a port of `@notefig/widgets` `prompt/**`
//! (the view half) and `components/agent/prompt-widget-{host,boundary}.tsx`.
//!
//! | TS | here |
//! |---|---|
//! | `prompt-widget-host.tsx`, `prompt-widget-boundary.tsx`, `node-view.tsx` (summon, keeper, binding), `change-gutter.ts`, `change-navigator.ts` | [`host`] — [`PromptWidgetHost`] |
//! | `ui/prompt-blob.tsx`, `ui/widget-response-view.tsx`, `ui/copy-text-button.tsx` | [`view`] |
//! | `state.ts` (the face's derivations) | [`face`] |
//! | `composer/*` (mentions and directives) | [`draft`] |
//! | `minimap.ts` | [`minimap`] |
//! | `modules/shared-sessions` (not ported yet) | `sessions` |
//! | `machine.ts`, `widgets-service.ts`, `change-store.ts`, the outcome | `notefig_prompt_widgets` (`core.promptWidgets`) |
//!
//! The editor host calls [`PromptWidgetHost::attach`] once per markdown
//! editor; that installs [`prompt_widget_view`] as the editor's node-view
//! renderer. Agent writes into a document are tracked per round: the editors
//! module applies a widget round's write with
//! `EditOrigin::Agent { round: Some(prompt_round_id(turn_id)) }`.

mod draft;
pub mod face;
pub mod host;
pub mod minimap;
mod sessions;
mod view;

use gpui::{AnyElement, App, Entity, Window};
use markdown_editor::{NodeViewCtx, RoundId};

pub use host::PromptWidgetHost;
pub use view::PromptWidgetView;

/// Render the widget a node-view block holds (the editor's
/// `NodeViewRenderer`). [`PromptWidgetHost::attach`] installs it; call it
/// directly only when composing a renderer of your own.
pub fn prompt_widget_view(host: &Entity<PromptWidgetHost>, ctx: &NodeViewCtx, window: &mut Window, cx: &mut App) -> AnyElement {
    host::render_widget(host, ctx, window, cx)
}

/// The editor's change-tracking id of a widget round: a stable hash of the
/// turn id, so whoever applies the round's writes (the editors module,
/// `EditOrigin::Agent { round }`) and the widget agree without sharing state.
pub fn prompt_round_id(turn_id: &str) -> RoundId {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in turn_id.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    RoundId(h)
}

pub fn init(_cx: &mut App) {}
