//! Compile probe: does the UI stack (gpui + web platform + gpui-kit + our
//! editor fork) build for wasm32-unknown-unknown?
pub use gpui_web as _web;
pub use markdown_editor::BlockEditorState as _Editor;
