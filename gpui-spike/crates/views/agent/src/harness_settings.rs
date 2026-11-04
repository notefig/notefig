//! The Settings dialog's "Harnesses" section: a port of
//! `components/agent/harness-settings.tsx` (with `harness-settings-form.ts`
//! in [`form`] and `harness-logo.tsx` in [`logo`]).
//!
//! A unified list of every configured harness — including ones the pickers
//! hide — as single-line rows (status dot, logo, name; controls behind a …
//! menu), with an add-row at the bottom and an icon-only rescan. Editing
//! expands that row inline into a form (the rest of the list stays
//! visible); the add-row expands the same way for a new custom entry. Every
//! edit goes through `core.agents` (`save_override`, `save_custom`,
//! `set_harness_enabled`, `remove_custom_harness`, `rescan_harnesses`), so
//! the pickers update live.
//!
//! The settings owner composes it: [`init`] registers it as the
//! `"harnesses"` section of `notefig_view_settings`.
//!
//! Deviations:
//! - `harnesses.rescan()` resolves `null` on failure in TS (a toast says so);
//!   `rescan_harnesses()` here reports nothing, so there is no failure toast.
//! - The … menu and the MCP select are drawn with the agent views' popover
//!   frame (`style::popover_frame`), as the TS `DropdownMenu`/`Select` are.

pub mod form;
pub mod logo;

use gpui::{
    AnimationExt as _, AnyElement, App, AppContext as _, Context, ElementId, Entity, FontWeight,
    InteractiveElement, IntoElement, ParentElement, Render, StatefulInteractiveElement as _, Styled,
    Subscription, Window, div, prelude::FluentBuilder as _,
};
use gpui_kit::component::WindowExt as _;
use gpui_kit::component::button::ButtonVariant as KitButtonVariant;
use gpui_kit::component::input::{Input, InputEvent, InputState, Textarea, TextareaState};
use gpui_kit::component::tooltip::Tooltip;
use notefig_agent::harness::{HarnessOrigin, HarnessSettingsRow};
use notefig_agents::{AgentStoreModule, AgentsModule};
use notefig_i18n::{t, t_args};
use notefig_kv::KvModule;
use notefig_ui::{CoreExt as _, icon, observe, rem, sp, tokens};

use crate::style::{self, ButtonSize, ButtonVariant, PopoverSide};
use form::{
    HarnessFormErrors, HarnessFormState, McpOptIn, built_in_harness, definition_to_form,
    form_to_custom_entry, form_to_override, new_custom_harness_id, validate_harness_form,
};
pub use logo::harness_logo_element;

/// The KV namespace and key of the remembered default harness
/// (`use-harness-selection.ts`).
pub(crate) const AGENT_KV_NAMESPACE: &str = "agent";
pub(crate) const DEFAULT_HARNESS_KEY: &str = "default-harness";

/// Register the section with the Settings dialog.
pub fn init(cx: &mut App) {
    notefig_view_settings::register_section(cx, "harnesses", |window, cx| {
        cx.new(|cx| HarnessSettings::new(window, cx)).into()
    });
}

/// What the enabled state would be with no explicit setting: found (or
/// never probed) ⇒ on, affirmatively not found ⇒ off.
fn natural_enabled(row: &HarnessSettingsRow) -> bool {
    row.discovery.as_ref().is_none_or(|d| d.found)
}

/// `useDefaultHarness()`: the stored default when it is still active, else
/// the first active harness (`useActiveHarnesses`: the pickable list, or
/// every built-in when nothing is pickable).
pub(crate) fn default_harness(cx: &App) -> Option<String> {
    let core = cx.core();
    let agents = core.use_::<AgentsModule>();
    let stored: Option<String> = core
        .use_::<KvModule>()
        .collection(AGENT_KV_NAMESPACE)
        .get_as(DEFAULT_HARNESS_KEY);
    let mut active: Vec<String> = agents.pickable_harnesses().into_iter().map(|h| h.id).collect();
    if active.is_empty() {
        active = notefig_agent::harness::built_in_harnesses().into_iter().map(|h| h.id).collect();
    }
    stored.filter(|id| active.contains(id)).or_else(|| active.first().cloned())
}

/// `setDefaultHarness(id)`.
pub(crate) fn set_default_harness(id: &str, cx: &mut App) {
    let write = cx.core().use_::<KvModule>().write(AGENT_KV_NAMESPACE, DEFAULT_HARNESS_KEY, &id.to_string());
    cx.spawn(async move |_| {
        if let Err(err) = write.await {
            log::warn!("harness settings: saving the default harness failed: {err:#}");
        }
    })
    .detach();
}

/// Which list entry is expanded into its form.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Editing {
    Row(String),
    New,
}

/// `HarnessEditorFields`' mode.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mode {
    Builtin,
    Custom,
    Create,
}

/// The open inline form: one input per field, the TS `HarnessFormState`
/// read off them on demand.
struct Editor {
    mode: Mode,
    label: Entity<InputState>,
    command: Entity<InputState>,
    args: Entity<TextareaState>,
    env: Entity<TextareaState>,
    probe: Entity<InputState>,
    resume: Entity<InputState>,
    mcp: McpOptIn,
    mcp_open: bool,
    errors: HarnessFormErrors,
    /// A save was attempted: errors re-validate per keystroke from now on.
    touched: bool,
    _subs: Vec<Subscription>,
}

fn line_input(value: &str, placeholder: String, window: &mut Window, cx: &mut Context<HarnessSettings>) -> Entity<InputState> {
    let value = value.to_string();
    cx.new(|cx| {
        let mut s = InputState::new(window, cx).placeholder(placeholder);
        s.set_value(value, window, cx);
        s
    })
}

fn area_input(value: &str, placeholder: String, window: &mut Window, cx: &mut Context<HarnessSettings>) -> Entity<TextareaState> {
    let value = value.to_string();
    cx.new(|cx| {
        let mut s = TextareaState::new(window, cx).placeholder(placeholder).rows(3);
        s.set_value(value, window, cx);
        s
    })
}

impl Editor {
    fn new(mode: Mode, initial: HarnessFormState, window: &mut Window, cx: &mut Context<HarnessSettings>) -> Self {
        let label = line_input(&initial.label, t("harnessLabelPlaceholder"), window, cx);
        let command = line_input(&initial.command, t("harnessCommandPlaceholder"), window, cx);
        let args = area_input(&initial.args_text, t("harnessArgsPlaceholder"), window, cx);
        let env = area_input(&initial.env_text, t("harnessEnvPlaceholder"), window, cx);
        let probe = line_input(&initial.probe_command, t("harnessProbePlaceholder"), window, cx);
        let resume = line_input(&initial.resume_command, t("harnessResumePlaceholder"), window, cx);
        fn on_change(this: &mut HarnessSettings, e: &InputEvent, cx: &mut Context<HarnessSettings>) {
            if matches!(e, InputEvent::Change) {
                this.form_changed(cx);
            }
        }
        let subs = vec![
            cx.subscribe(&label, |this, _, e: &InputEvent, cx| on_change(this, e, cx)),
            cx.subscribe(&command, |this, _, e: &InputEvent, cx| on_change(this, e, cx)),
            cx.subscribe(&args, |this, _, e: &InputEvent, cx| on_change(this, e, cx)),
            cx.subscribe(&env, |this, _, e: &InputEvent, cx| on_change(this, e, cx)),
            cx.subscribe(&probe, |this, _, e: &InputEvent, cx| on_change(this, e, cx)),
            cx.subscribe(&resume, |this, _, e: &InputEvent, cx| on_change(this, e, cx)),
        ];
        Self {
            mode,
            label,
            command,
            args,
            env,
            probe,
            resume,
            mcp: initial.mcp_opt_in,
            mcp_open: false,
            errors: HarnessFormErrors::default(),
            touched: false,
            _subs: subs,
        }
    }

    fn form(&self, cx: &App) -> HarnessFormState {
        HarnessFormState {
            label: self.label.read(cx).value().to_string(),
            command: self.command.read(cx).value().to_string(),
            args_text: self.args.read(cx).value().to_string(),
            env_text: self.env.read(cx).value().to_string(),
            probe_command: self.probe.read(cx).value().to_string(),
            resume_command: self.resume.read(cx).value().to_string(),
            mcp_opt_in: self.mcp,
        }
    }

    fn require_label(&self) -> bool {
        self.mode != Mode::Builtin
    }
}

/// `HarnessSettings` — the section entity the settings owner composes.
pub struct HarnessSettings {
    rows: Vec<HarnessSettingsRow>,
    default_harness: Option<String>,
    editing: Option<Editing>,
    editor: Option<Editor>,
    /// The row whose … menu is open.
    menu: Option<String>,
    scanning: bool,
    _subs: Vec<notefig_core::Subscription>,
}

impl HarnessSettings {
    pub fn new(_window: &mut Window, cx: &mut Context<Self>) -> Self {
        let core = cx.core();
        let store = core.use_::<AgentStoreModule>();
        let kv = core.use_::<KvModule>().collection(AGENT_KV_NAMESPACE);
        let harnesses = observe(cx, |notify| store.subscribe_harnesses(move || notify()));
        let rows_changed = observe(cx, |notify| store.subscribe(move || notify()));
        let preload = kv.preload();
        cx.spawn(async move |_, _| preload.await).detach();
        let default = observe(cx, |notify| kv.subscribe(move || notify()));
        let mut this = Self {
            rows: Vec::new(),
            default_harness: None,
            editing: None,
            editor: None,
            menu: None,
            scanning: false,
            _subs: vec![harnesses, rows_changed, default],
        };
        this.refresh(cx);
        this
    }

    /// `useHarnessSettingsRows()` and `useDefaultHarness()`.
    fn refresh(&mut self, cx: &App) {
        self.rows = cx.core().use_::<AgentsModule>().harness_settings();
        self.default_harness = default_harness(cx);
    }

    fn rescan(&mut self, cx: &mut Context<Self>) {
        if self.scanning {
            return;
        }
        self.scanning = true;
        cx.notify();
        let scan = cx.core().use_::<AgentsModule>().rescan_harnesses();
        cx.spawn(async move |this, cx| {
            scan.await;
            let _ = this.update(cx, |this, cx| {
                this.scanning = false;
                cx.notify();
            });
        })
        .detach();
    }

    fn open_editor(&mut self, target: Editing, window: &mut Window, cx: &mut Context<Self>) {
        if self.editing.as_ref() == Some(&target) {
            self.close_editor(cx);
            return;
        }
        let (mode, initial) = match &target {
            Editing::New => (Mode::Create, HarnessFormState::default()),
            Editing::Row(id) => {
                let Some(row) = self.rows.iter().find(|r| &r.definition.id == id) else { return };
                let mode = if row.origin == HarnessOrigin::Custom { Mode::Custom } else { Mode::Builtin };
                (mode, definition_to_form(&row.definition))
            }
        };
        self.editor = Some(Editor::new(mode, initial, window, cx));
        self.editing = Some(target);
        cx.notify();
    }

    fn close_editor(&mut self, cx: &mut Context<Self>) {
        self.editing = None;
        self.editor = None;
        cx.notify();
    }

    fn form_changed(&mut self, cx: &mut Context<Self>) {
        let Some(editor) = self.editor.as_mut() else { return };
        // Once a save attempt surfaced errors, re-validate per keystroke so
        // errors clear as the user types.
        if editor.touched {
            editor.errors = validate_harness_form(&editor.form(cx), editor.require_label()).0;
            cx.notify();
        }
    }

    /// `handleSave` + `saveRow` (and the create path).
    fn save(&mut self, cx: &mut Context<Self>) {
        let (Some(editing), Some(editor)) = (self.editing.clone(), self.editor.as_mut()) else { return };
        editor.touched = true;
        let form = editor.form(cx);
        let (errors, parsed) = validate_harness_form(&form, editor.require_label());
        let Some(parsed) = parsed else {
            editor.errors = errors;
            cx.notify();
            return;
        };
        let agents = cx.core().use_::<AgentsModule>();
        // Saving re-checks the install: the verdict is keyed by harness id
        // alone (the runtime re-probes on save).
        let saved = match editing {
            Editing::New => {
                let id = new_custom_harness_id();
                agents.save_custom(&id, form_to_custom_entry(&parsed, &form, &id, true))
            }
            Editing::Row(id) => {
                let Some(row) = self.rows.iter().find(|r| r.definition.id == id).cloned() else { return };
                if row.origin == HarnessOrigin::Custom {
                    agents.save_custom(&id, form_to_custom_entry(&parsed, &form, &id, row.enabled))
                } else {
                    let Some(builtin) = built_in_harness(&id) else { return };
                    agents.save_override(&id, form_to_override(&parsed, &builtin, row.enabled, natural_enabled(&row)))
                }
            }
        };
        cx.spawn(async move |_, _| {
            saved.await;
        })
        .detach();
        self.close_editor(cx);
    }

    fn confirm_delete(&mut self, row: &HarnessSettingsRow, window: &mut Window, cx: &mut Context<Self>) {
        let id = row.definition.id.clone();
        let title = t_args("harnessDeleteConfirmTitle", &[("label", &row.definition.label)]);
        window.open_alert_dialog(cx, move |alert, _, _| {
            let id = id.clone();
            alert
                .title(title.clone())
                .description(t("harnessDeleteConfirmDescription"))
                .show_cancel(true)
                .cancel_text(t("cancel"))
                .ok_text(t("harnessDelete"))
                .ok_variant(KitButtonVariant::Danger)
                .on_ok(move |_, _, cx| {
                    cx.core().use_::<AgentsModule>().remove_custom_harness(&id);
                    true
                })
        });
    }

    fn confirm_reset(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(Editing::Row(id)) = self.editing.clone() else { return };
        let Some(row) = self.rows.iter().find(|r| r.definition.id == id) else { return };
        let title = t_args("harnessResetConfirmTitle", &[("label", &row.definition.label)]);
        let this = cx.entity().downgrade();
        window.open_alert_dialog(cx, move |alert, _, _| {
            let (id, this) = (id.clone(), this.clone());
            alert
                .title(title.clone())
                .description(t("harnessResetConfirmDescription"))
                .show_cancel(true)
                .cancel_text(t("cancel"))
                .ok_text(t("harnessResetDefaults"))
                .on_ok(move |_, _, cx| {
                    let saved = cx.core().use_::<AgentsModule>().save_override(&id, None);
                    cx.spawn(async move |_| {
                        saved.await;
                    })
                    .detach();
                    let _ = this.update(cx, |this, cx| this.close_editor(cx));
                    true
                })
        });
    }

    // ── rendering ──

    fn render_header(&self, cx: &mut Context<Self>) -> AnyElement {
        let tk = tokens(cx).clone();
        let scanning = self.scanning;
        let glyph = icon(if scanning { "loader-circle" } else { "refresh-cw" })
            .size(tk.icon_md)
            .text_color(tk.muted_foreground);
        let glyph = if scanning {
            glyph
                .with_animation(
                    "harness-rescan-spin",
                    gpui::Animation::new(std::time::Duration::from_secs(1)).repeat(),
                    |svg, delta| svg.with_transformation(gpui::Transformation::rotate(gpui::percentage(delta))),
                )
                .into_any_element()
        } else {
            glyph.into_any_element()
        };
        div()
            .flex()
            .items_start()
            .justify_between()
            .gap(sp(4.))
            .child(
                div()
                    .min_w_0()
                    .child(
                        div()
                            .text_size(rem(1.125))
                            .line_height(rem(1.75))
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(t("harnessSettingsTitle")),
                    )
                    .child(
                        div()
                            .text_size(tk.text_sm)
                            .line_height(rem(1.25))
                            .text_color(tk.muted_foreground)
                            .child(t("harnessSettingsDescription")),
                    ),
            )
            .child(
                style::button("harness-rescan", ButtonVariant::Ghost, ButtonSize::Icon, scanning, cx)
                    .text_color(tk.muted_foreground)
                    .tooltip(|window, cx| Tooltip::new(t("harnessRescan")).build(window, cx))
                    .child(glyph)
                    .when(!scanning, |b| b.on_click(cx.listener(|this, _, _, cx| this.rescan(cx)))),
            )
            .into_any_element()
    }

    /// `HarnessRow`.
    fn render_row(&self, row: &HarnessSettingsRow, cx: &mut Context<Self>) -> AnyElement {
        let tk = tokens(cx).clone();
        let id = row.definition.id.clone();
        let is_default = self.default_harness.as_deref() == Some(id.as_str());
        let is_editing = self.editing == Some(Editing::Row(id.clone()));
        let enabled = row.enabled;
        let found = row.discovery.as_ref().is_some_and(|d| d.found);
        let logo_color = if enabled { tk.foreground } else { tk.foreground.opacity(0.5) };
        let menu_open = self.menu.as_deref() == Some(id.as_str());
        let origin = match row.origin {
            HarnessOrigin::Builtin => None,
            HarnessOrigin::Custom => Some(t("harnessOriginCustom")),
            HarnessOrigin::Overridden => Some(t("harnessOriginOverridden")),
        };
        let trigger_id = ElementId::Name(format!("harness-menu-{id}").into());
        let menu_id = id.clone();
        div()
            .flex()
            .items_center()
            .gap(sp(2.5))
            .px(sp(3.))
            .py(sp(2.5))
            .child(
                div()
                    .size(sp(2.))
                    .flex_none()
                    .rounded_full()
                    .bg(if found { tk.success } else { tk.muted_foreground.opacity(0.3) }),
            )
            .child(harness_logo_element(&id, sp(4.), logo_color))
            .child(
                div()
                    .min_w_0()
                    .flex_1()
                    .flex()
                    .items_center()
                    .overflow_hidden()
                    .text_size(tk.text_sm)
                    .font_weight(FontWeight::MEDIUM)
                    .when(!enabled, |d| d.text_color(tk.muted_foreground))
                    .child(div().truncate().child(row.definition.label.clone()))
                    .when_some(origin, |d, origin| {
                        d.child(
                            div()
                                .ml(sp(1.5))
                                .flex_none()
                                .text_size(rem(0.625))
                                .font_weight(FontWeight::NORMAL)
                                .text_color(tk.muted_foreground)
                                .child(origin),
                        )
                    }),
            )
            .when(is_default, |d| d.child(icon("check").size(tk.icon_md).text_color(tk.muted_foreground)))
            .child(
                div()
                    .relative()
                    .flex_none()
                    .child(
                        style::button(trigger_id, ButtonVariant::Ghost, ButtonSize::Icon, false, cx)
                            .size(sp(7.))
                            .text_color(tk.muted_foreground)
                            .when(menu_open, |b| b.bg(tk.accent))
                            .tooltip(|window, cx| Tooltip::new(t("harnessRowActions")).build(window, cx))
                            .child(icon("ellipsis").size(tk.icon_md).text_color(tk.muted_foreground))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.menu = if this.menu.as_deref() == Some(menu_id.as_str()) {
                                    None
                                } else {
                                    Some(menu_id.clone())
                                };
                                cx.notify();
                            })),
                    )
                    .when(menu_open, |d| d.child(self.render_menu(row, is_default, is_editing, cx))),
            )
            .into_any_element()
    }

    /// The row's `DropdownMenuContent align="end"`.
    fn render_menu(&self, row: &HarnessSettingsRow, is_default: bool, is_editing: bool, cx: &mut Context<Self>) -> AnyElement {
        let tk = tokens(cx).clone();
        let id = row.definition.id.clone();
        let item = |key: &str, label: String, cx: &mut Context<Self>| {
            style::menu_item(ElementId::Name(format!("harness-menu-{id}-{key}").into()), false, cx).child(label)
        };
        let mut menu = style::popover_frame(cx)
            .min_w(rem(8.))
            .p(sp(1.))
            .on_mouse_down_out(cx.listener(|this, _, _, cx| {
                this.menu = None;
                cx.notify();
            }));
        menu = menu.child(
            item("edit", if is_editing { t("harnessCollapse") } else { t("harnessEdit") }, cx).on_click(cx.listener({
                let id = id.clone();
                move |this, _, window, cx| {
                    this.menu = None;
                    this.open_editor(Editing::Row(id.clone()), window, cx);
                }
            })),
        );
        if !is_default && row.enabled {
            menu = menu.child(item("default", t("harnessMakeDefault"), cx).on_click(cx.listener({
                let id = id.clone();
                move |this, _, _, cx| {
                    this.menu = None;
                    set_default_harness(&id, cx);
                    cx.notify();
                }
            })));
        }
        menu = menu.child(
            item("enable", if row.enabled { t("harnessDisable") } else { t("harnessEnable") }, cx).on_click(cx.listener({
                let (id, enabled) = (id.clone(), row.enabled);
                move |this, _, _, cx| {
                    this.menu = None;
                    cx.core().use_::<AgentsModule>().set_harness_enabled(&id, !enabled);
                    cx.notify();
                }
            })),
        );
        if row.origin == HarnessOrigin::Custom {
            let row = row.clone();
            menu = menu
                .child(div().my(sp(1.)).child(style::rule(cx)))
                .child(item("delete", t("harnessDelete"), cx).text_color(tk.destructive).on_click(cx.listener(
                    move |this, _, window, cx| {
                        this.menu = None;
                        this.confirm_delete(&row, window, cx);
                        cx.notify();
                    },
                )));
        }
        style::anchored_popover(PopoverSide::BelowEnd, menu)
    }

    /// `HarnessEditorFields` in its `border-t bg-muted/30 p-4` well.
    fn render_editor(&self, last: bool, cx: &mut Context<Self>) -> AnyElement {
        let Some(editor) = self.editor.as_ref() else { return div().into_any_element() };
        let tk = tokens(cx).clone();
        let field = |label: String, control: AnyElement, extra: Vec<AnyElement>| {
            div()
                .flex()
                .flex_col()
                .gap(sp(1.5))
                .child(div().text_size(tk.text_sm).text_color(tk.muted_foreground).child(label))
                .child(control)
                .children(extra)
                .into_any_element()
        };
        let error = |text: String| div().text_size(tk.text_xs).text_color(tk.destructive).child(text).into_any_element();
        let mono = |el: AnyElement| div().font_family(style::mono()).text_size(tk.text_xs).child(el).into_any_element();
        let mut fields: Vec<AnyElement> = Vec::new();
        if editor.mode != Mode::Builtin {
            fields.push(field(
                t("harnessLabelField"),
                Input::new(&editor.label).into_any_element(),
                editor.errors.label.then(|| error(t("harnessLabelRequired"))).into_iter().collect(),
            ));
        }
        fields.push(field(
            t("harnessCommandField"),
            mono(Input::new(&editor.command).into_any_element()),
            editor.errors.command.then(|| error(t("harnessCommandRequired"))).into_iter().collect(),
        ));
        fields.push(field(t("harnessArgsField"), mono(Textarea::new(&editor.args).into_any_element()), vec![]));
        fields.push(field(
            t("harnessEnvField"),
            mono(Textarea::new(&editor.env).into_any_element()),
            editor
                .errors
                .env
                .iter()
                .map(|e| error(t_args(e.kind.message_key(), &[("line", &e.line.to_string())])))
                .collect(),
        ));
        fields.push(field(t("harnessProbeField"), mono(Input::new(&editor.probe).into_any_element()), vec![]));
        fields.push(field(t("harnessResumeField"), mono(Input::new(&editor.resume).into_any_element()), vec![]));
        if editor.mode == Mode::Create {
            fields.push(field(
                t("harnessMcpField"),
                self.render_mcp_select(editor, cx),
                (editor.mcp == McpOptIn::SessionNew)
                    .then(|| div().text_size(tk.text_xs).text_color(tk.warning).child(t("harnessMcpOptInWarning")).into_any_element())
                    .into_iter()
                    .collect(),
            ));
        }
        let save_disabled = editor.touched && !editor.errors.is_empty();
        let can_reset = matches!(&self.editing, Some(Editing::Row(id))
            if self.rows.iter().any(|r| &r.definition.id == id && r.origin == HarnessOrigin::Overridden));
        let buttons = div()
            .flex()
            .items_center()
            .gap(sp(2.))
            .child(
                style::button("harness-save", ButtonVariant::Default, ButtonSize::Default, save_disabled, cx)
                    .child(t("harnessSave"))
                    .when(!save_disabled, |b| b.on_click(cx.listener(|this, _, _, cx| this.save(cx)))),
            )
            .child(
                style::button("harness-cancel", ButtonVariant::Ghost, ButtonSize::Default, false, cx)
                    .child(t("cancel"))
                    .on_click(cx.listener(|this, _, _, cx| this.close_editor(cx))),
            )
            .when(can_reset, |d| {
                d.child(
                    style::button("harness-reset", ButtonVariant::Ghost, ButtonSize::Default, false, cx)
                        .ml_auto()
                        .text_color(tk.muted_foreground)
                        .child(t("harnessResetDefaults"))
                        .on_click(cx.listener(|this, _, window, cx| this.confirm_reset(window, cx))),
                )
            });
        div()
            .border_t_1()
            .border_color(tk.border)
            .bg(tk.muted.opacity(0.3))
            .p(sp(4.))
            .when(last, |d| d.rounded_b(tk.radius_lg))
            .flex()
            .flex_col()
            .gap(sp(4.))
            .child(div().flex().flex_col().gap(sp(4.)).children(fields))
            .child(buttons)
            .into_any_element()
    }

    /// The MCP opt-in `<Select>` (`w-64`).
    fn render_mcp_select(&self, editor: &Editor, cx: &mut Context<Self>) -> AnyElement {
        let tk = tokens(cx).clone();
        let label = |v: McpOptIn| match v {
            McpOptIn::None => t("harnessMcpNone"),
            McpOptIn::SessionNew => t("harnessMcpSessionNew"),
        };
        let current = editor.mcp;
        let mut select = div().relative().w(sp(64.)).child(
            div()
                .id("harness-mcp-select")
                .flex()
                .items_center()
                .justify_between()
                .h(sp(10.))
                .px(sp(3.))
                .rounded(tk.radius_md)
                .border_1()
                .border_color(tk.input)
                .bg(tk.background)
                .text_size(tk.text_sm)
                .cursor_pointer()
                .child(label(current))
                .child(icon("chevron-down").size(tk.icon_md).text_color(tk.muted_foreground.opacity(0.5)))
                .on_click(cx.listener(|this, _, _, cx| {
                    if let Some(e) = this.editor.as_mut() {
                        e.mcp_open = !e.mcp_open;
                    }
                    cx.notify();
                })),
        );
        if editor.mcp_open {
            let mut list = style::popover_frame(cx).w(sp(64.)).p(sp(1.)).on_mouse_down_out(cx.listener(|this, _, _, cx| {
                if let Some(e) = this.editor.as_mut() {
                    e.mcp_open = false;
                }
                cx.notify();
            }));
            for (ix, v) in [McpOptIn::None, McpOptIn::SessionNew].into_iter().enumerate() {
                list = list.child(
                    style::menu_item(ElementId::Name(format!("harness-mcp-{ix}").into()), false, cx)
                        .child(div().flex_1().child(label(v)))
                        .when(v == current, |d| d.child(icon("check").size(tk.icon_md).text_color(tk.popover_foreground)))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            if let Some(e) = this.editor.as_mut() {
                                e.mcp = v;
                                e.mcp_open = false;
                            }
                            this.form_changed(cx);
                            cx.notify();
                        })),
                );
            }
            select = select.child(style::anchored_popover(PopoverSide::BelowStart, list));
        }
        select.into_any_element()
    }
}

impl Render for HarnessSettings {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.refresh(cx);
        // A row that went away (deleted) takes its open form with it.
        if let Some(Editing::Row(id)) = &self.editing
            && !self.rows.iter().any(|r| &r.definition.id == id)
        {
            self.editing = None;
            self.editor = None;
        }
        let tk = tokens(cx).clone();
        let rows = self.rows.clone();
        let mut list = div().flex().flex_col().rounded(tk.radius_lg).border_1().border_color(tk.border);
        for (ix, row) in rows.iter().enumerate() {
            let editing = self.editing == Some(Editing::Row(row.definition.id.clone()));
            list = list.child(
                div()
                    .when(ix > 0, |d| d.border_t_1().border_color(tk.border))
                    .child(self.render_row(row, cx))
                    .when(editing, |d| d.child(self.render_editor(false, cx))),
            );
        }
        let adding = self.editing == Some(Editing::New);
        let accent_hover = tk.accent.opacity(0.5);
        list = list.child(
            div()
                .when(!rows.is_empty(), |d| d.border_t_1().border_color(tk.border))
                .child(
                    div()
                        .id("harness-add")
                        .flex()
                        .w_full()
                        .items_center()
                        .gap(sp(2.))
                        .px(sp(3.))
                        .py(sp(2.5))
                        .text_size(tk.text_sm)
                        .text_color(tk.muted_foreground)
                        .cursor_pointer()
                        .when(!adding, |d| d.rounded_b(tk.radius_lg))
                        .hover(move |s| s.bg(accent_hover))
                        .child(icon("plus").size(tk.icon_md).text_color(tk.muted_foreground))
                        .child(t("harnessAdd"))
                        .on_click(cx.listener(|this, _, window, cx| this.open_editor(Editing::New, window, cx))),
                )
                .when(adding, |d| d.child(self.render_editor(true, cx))),
        );
        div()
            .flex()
            .flex_col()
            .gap(sp(4.))
            .text_color(tk.foreground)
            .child(self.render_header(cx))
            .child(list)
    }
}
