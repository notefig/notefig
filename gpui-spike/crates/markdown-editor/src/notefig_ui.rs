//! Editor-owned UI: the frontmatter properties panel and the code-block
//! language picker.

use gpui::prelude::FluentBuilder as _;
use gpui::{
    AnyElement, App, AppContext as _, Bounds, Context, Entity, Focusable as _, InteractiveElement as _, StatefulInteractiveElement as _,
    IntoElement as _, ParentElement as _, Pixels, SharedString, Styled as _, Window, div, px,
};
use gpui_kit::component::input::{Input, InputState};

use super::{
    command::EditorCommand, kind::BlockKindData, state::BlockEditorState,
};

/// Languages the picker offers (spec §3.6), plus plain text.
pub const CODE_LANGUAGES: &[&str] = &[
    "bash", "c", "cpp", "csharp", "css", "diff", "go", "html", "java", "javascript", "json", "jsx",
    "kotlin", "markdown", "php", "python", "ruby", "rust", "sql", "swift", "toml", "tsx",
    "typescript", "yaml",
];

/// One `key: value` line of the frontmatter.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Property {
    pub key: String,
    pub value: String,
    /// The YAML line it came from (`None` for a new one).
    pub line: Option<usize>,
}

fn property_line(line: &str) -> Option<(String, String)> {
    if line.starts_with([' ', '\t', '#', '-']) {
        return None;
    }
    let (key, value) = line.split_once(':')?;
    if key.is_empty()
        || !key
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | '.' | ' '))
    {
        return None;
    }
    Some((key.trim().to_string(), value.trim().to_string()))
}

/// The single-line `key: value` properties of a YAML frontmatter. Keys with
/// a nested value (an empty value followed by indented lines) are not
/// listed; they, comments and anything else stay untouched on apply.
pub fn parse_properties(yaml: &str) -> Vec<Property> {
    let lines: Vec<&str> = yaml.lines().collect();
    lines
        .iter()
        .enumerate()
        .filter_map(|(ix, line)| {
            let (key, value) = property_line(line)?;
            let nested = value.is_empty()
                && lines
                    .get(ix + 1)
                    .is_some_and(|next| next.starts_with([' ', '\t', '-']));
            (!nested).then_some(Property {
                key,
                value,
                line: Some(ix),
            })
        })
        .collect()
}

/// Write `properties` back into `yaml`: edited lines are replaced, removed
/// ones dropped, new ones appended; unchanged lines (comments, nested
/// values, untouched keys) keep their bytes.
pub fn apply_properties(yaml: &str, properties: &[Property]) -> String {
    let original = parse_properties(yaml);
    let mut out: Vec<String> = Vec::new();
    for (ix, line) in yaml.lines().enumerate() {
        let listed = original.iter().any(|p| p.line == Some(ix));
        if !listed {
            out.push(line.to_string());
            continue;
        }
        match properties.iter().find(|p| p.line == Some(ix)) {
            Some(p) => {
                let before = original.iter().find(|o| o.line == Some(ix));
                if before.is_some_and(|b| b.key == p.key && b.value == p.value) {
                    out.push(line.to_string());
                } else if !p.key.trim().is_empty() {
                    out.push(format!("{}: {}", p.key.trim(), p.value.trim()));
                }
            }
            None => {}
        }
    }
    for p in properties.iter().filter(|p| p.line.is_none()) {
        if !p.key.trim().is_empty() {
            out.push(format!("{}: {}", p.key.trim(), p.value.trim()));
        }
    }
    out.join("\n")
}

/// The open properties panel.
pub(crate) struct PropertiesPanel {
    rows: Vec<(Entity<InputState>, Entity<InputState>, Option<usize>)>,
}

#[cfg(test)]
impl PropertiesPanel {
    pub(crate) fn rows_for_test(&self) -> &[(Entity<InputState>, Entity<InputState>, Option<usize>)] {
        &self.rows
    }
}

/// The open language picker (its block).
#[derive(Clone, Copy)]
pub(crate) struct LanguagePicker {
    pub(crate) block: super::id::BlockId,
}

impl BlockEditorState {
    /// Open the frontmatter properties panel above the document.
    pub fn open_properties(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let yaml = self.model.frontmatter().unwrap_or("").to_string();
        let rows = parse_properties(&yaml)
            .into_iter()
            .map(|p| {
                let key = cx.new(|cx| {
                    let mut input = InputState::new(window, cx).placeholder("key");
                    input.set_value(p.key.clone(), window, cx);
                    input
                });
                let value = cx.new(|cx| {
                    let mut input = InputState::new(window, cx).placeholder("value");
                    input.set_value(p.value.clone(), window, cx);
                    input
                });
                (key, value, p.line)
            })
            .collect();
        self.notefig.properties = Some(PropertiesPanel { rows });
        cx.notify();
    }

    pub fn is_properties_open(&self) -> bool {
        self.notefig.properties.is_some()
    }

    /// Close the panel; with `apply`, write the rows back into the
    /// frontmatter (one undo step).
    pub fn close_properties(&mut self, apply: bool, window: &mut Window, cx: &mut Context<Self>) {
        let Some(panel) = self.notefig.properties.take() else {
            return;
        };
        if apply {
            let properties: Vec<Property> = panel
                .rows
                .iter()
                .map(|(k, v, line)| Property {
                    key: k.read(cx).value().to_string(),
                    value: v.read(cx).value().to_string(),
                    line: *line,
                })
                .collect();
            let yaml = self.model.frontmatter().unwrap_or("").to_string();
            let next = apply_properties(&yaml, &properties);
            let _ = self.set_frontmatter(Some(&next), cx);
        }
        self.focus(window, cx);
        cx.notify();
    }

    fn add_property_row(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let key = cx.new(|cx| InputState::new(window, cx).placeholder("key"));
        let value = cx.new(|cx| InputState::new(window, cx).placeholder("value"));
        let focus = key.read(cx).focus_handle(cx);
        if let Some(panel) = &mut self.notefig.properties {
            panel.rows.push((key, value, None));
        }
        window.focus(&focus, cx);
        cx.notify();
    }

    /// The properties chip (when there is frontmatter) or the open panel.
    pub(crate) fn render_properties(
        &self,
        entity: &Entity<Self>,
        cx: &App,
    ) -> Option<AnyElement> {
        let theme = gpui_kit::base::Theme::global(cx);
        let colors = theme.tokens.colors;
        let Some(panel) = &self.notefig.properties else {
            if !self.notefig.properties_chip {
                return None;
            }
            let yaml = self.model.frontmatter()?;
            let count = parse_properties(yaml).len();
            let e = entity.downgrade();
            return Some(
                div()
                    .id("notefig-properties-chip")
                    .mb(px(8.))
                    .px(px(8.))
                    .py(px(2.))
                    .rounded(px(4.))
                    .text_xs()
                    .text_color(colors.muted_foreground)
                    .cursor_pointer()
                    .child(format!("Properties ({count})"))
                    .on_mouse_down(gpui::MouseButton::Left, move |_, window, cx| {
                        cx.stop_propagation();
                        if let Some(e) = e.upgrade() {
                            e.update(cx, |s, cx| s.open_properties(window, cx));
                        }
                    })
                    .into_any_element(),
            );
        };
        let button = |id: SharedString, label: &'static str| {
            div()
                .id(id)
                .px(px(8.))
                .py(px(2.))
                .rounded(px(4.))
                .border_1()
                .border_color(colors.border)
                .text_xs()
                .cursor_pointer()
                .child(label)
        };
        let rows = panel.rows.iter().enumerate().map(|(ix, (k, v, _))| {
            let e = entity.downgrade();
            div()
                .flex()
                .flex_row()
                .gap(px(6.))
                .child(div().w(px(140.)).child(Input::new(k)))
                .child(div().flex_1().child(Input::new(v)))
                .child(button(format!("prop-remove-{ix}").into(), "✕").on_mouse_down(
                    gpui::MouseButton::Left,
                    move |_, _, cx| {
                        cx.stop_propagation();
                        if let Some(e) = e.upgrade() {
                            e.update(cx, |s, cx| {
                                if let Some(panel) = &mut s.notefig.properties
                                    && ix < panel.rows.len()
                                {
                                    panel.rows.remove(ix);
                                }
                                cx.notify();
                            });
                        }
                    },
                ))
        });
        let (add, done, cancel) = (entity.downgrade(), entity.downgrade(), entity.downgrade());
        Some(
            div()
                .id("notefig-properties")
                .mb(px(10.))
                .p(px(10.))
                .rounded(px(6.))
                .border_1()
                .border_color(colors.border)
                .bg(colors.muted)
                .flex()
                .flex_col()
                .gap(px(6.))
                .child(div().text_xs().text_color(colors.muted_foreground).child("Properties"))
                .children(rows)
                .child(
                    div()
                        .flex()
                        .flex_row()
                        .gap(px(6.))
                        .child(button("prop-add".into(), "+ Add property").on_mouse_down(
                            gpui::MouseButton::Left,
                            move |_, window, cx| {
                                cx.stop_propagation();
                                if let Some(e) = add.upgrade() {
                                    e.update(cx, |s, cx| s.add_property_row(window, cx));
                                }
                            },
                        ))
                        .child(div().flex_1())
                        .child(button("prop-cancel".into(), "Cancel").on_mouse_down(
                            gpui::MouseButton::Left,
                            move |_, window, cx| {
                                cx.stop_propagation();
                                if let Some(e) = cancel.upgrade() {
                                    e.update(cx, |s, cx| s.close_properties(false, window, cx));
                                }
                            },
                        ))
                        .child(button("prop-done".into(), "Done").on_mouse_down(
                            gpui::MouseButton::Left,
                            move |_, window, cx| {
                                cx.stop_propagation();
                                if let Some(e) = done.upgrade() {
                                    e.update(cx, |s, cx| s.close_properties(true, window, cx));
                                }
                            },
                        )),
                )
                .into_any_element(),
        )
    }

    /// Show the "Properties" chip above a document with frontmatter (on by
    /// default).
    pub fn set_properties_chip(&mut self, on: bool, cx: &mut Context<Self>) {
        self.notefig.properties_chip = on;
        cx.notify();
    }

    // ---- language picker ---------------------------------------------------------

    /// Set the language of the code block holding the caret (`None` = plain
    /// text). Keeps a diff fence's `diff`.
    pub fn set_code_language(&mut self, lang: Option<&str>, cx: &mut Context<Self>) {
        let _ = self.run(EditorCommand::SetCodeBlock { lang: Some(lang.unwrap_or("").to_string()) }, cx);
        self.notefig.language_picker = None;
        cx.notify();
    }

    /// The code block whose picker button shows: the one holding the caret.
    fn picker_block(&self) -> Option<(super::id::BlockId, Option<SharedString>)> {
        let caret = self.model.caret()?;
        match self.model.doc.kind(caret.block) {
            Some(BlockKindData::CodeBlock { lang, .. }) => Some((caret.block, lang.clone())),
            _ => None,
        }
    }

    /// The language button (and list, when open) at the top right of the
    /// caret's code block, positioned in content coordinates.
    pub(crate) fn render_language_picker(
        &self,
        entity: &Entity<Self>,
        cx: &App,
    ) -> Option<AnyElement> {
        if !self.notefig.language_picker_enabled {
            return None;
        }
        let (block, lang) = self.picker_block()?;
        let frame = self.frame.borrow();
        let content = frame.content?;
        let leaf = frame.leaf(block)?.bounds();
        let theme = gpui_kit::base::Theme::global(cx);
        let colors = theme.tokens.colors;
        let right = content.right() - leaf.right();
        let top = leaf.top() - content.top();
        let open = self.notefig.language_picker.is_some_and(|p| p.block == block);
        let sink = self.notefig.overlay_bounds.clone();
        let toggle = entity.downgrade();
        let label: SharedString = lang.clone().unwrap_or_else(|| "plain text".into());
        let list = open.then(|| {
            let items = std::iter::once(None)
                .chain(CODE_LANGUAGES.iter().map(|l| Some(*l)))
                .map(|l| {
                    let e = entity.downgrade();
                    let current = l == lang.as_deref();
                    div()
                        .id(SharedString::from(format!("lang-{}", l.unwrap_or("text"))))
                        .px(px(8.))
                        .py(px(1.))
                        .text_xs()
                        .cursor_pointer()
                        .when(current, |d| d.bg(colors.muted))
                        .child(l.unwrap_or("plain text"))
                        .on_mouse_down(gpui::MouseButton::Left, move |_, _, cx| {
                            cx.stop_propagation();
                            if let Some(e) = e.upgrade() {
                                e.update(cx, |s, cx| s.set_code_language(l, cx));
                            }
                        })
                });
            div()
                .id("notefig-language-list")
                .max_h(px(220.))
                .overflow_y_scroll()
                .py(px(4.))
                .rounded(px(6.))
                .border_1()
                .border_color(colors.border)
                .bg(colors.background)
                .children(items)
        });
        Some(
            div()
                .absolute()
                .right(right + px(6.))
                .top(top + px(4.))
                .flex()
                .flex_col()
                .items_end()
                .gap(px(2.))
                .child(
                    div()
                        .id("notefig-language-button")
                        .px(px(6.))
                        .rounded(px(4.))
                        .text_xs()
                        .text_color(colors.muted_foreground)
                        .cursor_pointer()
                        .child(label)
                        .on_mouse_down(gpui::MouseButton::Left, move |_, _, cx| {
                            cx.stop_propagation();
                            if let Some(e) = toggle.upgrade() {
                                e.update(cx, |s, cx| {
                                    s.notefig.language_picker = match s.notefig.language_picker {
                                        Some(_) => None,
                                        None => Some(LanguagePicker { block }),
                                    };
                                    cx.notify();
                                });
                            }
                        }),
                )
                .children(list)
                .child(
                    gpui::canvas(
                        move |bounds: Bounds<Pixels>, _, _| sink.borrow_mut().push(bounds),
                        |_, _, _, _| {},
                    )
                    .absolute()
                    .top_0()
                    .left_0()
                    .size_full(),
                )
                .into_any_element(),
        )
    }

    /// Show the language picker on the caret's code block (on by default).
    pub fn set_language_picker(&mut self, on: bool, cx: &mut Context<Self>) {
        self.notefig.language_picker_enabled = on;
        cx.notify();
    }
}
