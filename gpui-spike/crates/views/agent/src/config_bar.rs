//! `session-config-bar.tsx`: the composer's session-setting pickers
//! (MET-81), one per switchable option the agent advertises (model first,
//! effort second), read off the task row's `configOptions` and switched
//! through the agents facade. Only the model and effort categories show;
//! nothing renders for a harness that advertises none or for a restored
//! (not yet revived) row.
//!
//! A picker is a popover over a filterable list: long catalogues (more
//! than [`FILTER_THRESHOLD`] choices) get a filter box at the top. Closing
//! a picker hands focus back to the composer ([`ConfigBarEvent::Closed`]).
//!
//! Deviation: the TS filter box is cmdk's input; here the open list takes
//! the keys itself (typing filters, ↑/↓ move, ⏎ picks, Esc closes).

use gpui::{
    AnyElement, App, Context, EventEmitter, FocusHandle, Focusable, FontWeight, InteractiveElement,
    IntoElement, KeyDownEvent, ParentElement, Render, SharedString, StatefulInteractiveElement,
    Styled, Window, div, prelude::FluentBuilder as _,
};
use gpui_kit::component::WindowExt as _;
use notefig_agent::model::{AgentTaskRow, ConfigChoice, ConfigOptions, SessionConfigSelect, TaskStatus};
use notefig_agents::AgentsModule;
use notefig_i18n::{t as tr, t_args};
use notefig_ui::{CoreExt as _, icon, observe, rem, sp, tokens};

use crate::style::{PopoverSide, anchored_popover, popover_frame, radius_default, text_9, text_10, text_11};

/// Model first, effort second.
const CATEGORY_ORDER: &[&str] = &["model", "thought_level"];
/// The only categories the toolbar shows for now.
const VISIBLE_CATEGORIES: &[&str] = CATEGORY_ORDER;
/// Categories whose value reads on its own ("Sonnet 4.5", "High").
const SELF_DESCRIBING_CATEGORIES: &[&str] = &["model", "thought_level"];
/// Lists longer than this get the filter box.
pub const FILTER_THRESHOLD: usize = 6;

fn category_rank(option: &SessionConfigSelect) -> usize {
    let cat = option.category.as_deref().unwrap_or("");
    CATEGORY_ORDER.iter().position(|c| *c == cat).unwrap_or(CATEGORY_ORDER.len())
}

/// `orderConfigOptions`: by category rank, then as advertised.
pub fn order_config_options(options: &[SessionConfigSelect]) -> Vec<SessionConfigSelect> {
    let mut indexed: Vec<(usize, &SessionConfigSelect)> = options.iter().enumerate().collect();
    indexed.sort_by(|(ia, a), (ib, b)| category_rank(a).cmp(&category_rank(b)).then(ia.cmp(ib)));
    indexed.into_iter().map(|(_, o)| o.clone()).collect()
}

/// `visibleConfigOptions`.
pub fn visible_config_options(options: &[SessionConfigSelect]) -> Vec<SessionConfigSelect> {
    let visible: Vec<SessionConfigSelect> = options
        .iter()
        .filter(|o| VISIBLE_CATEGORIES.contains(&o.category.as_deref().unwrap_or("")))
        .cloned()
        .collect();
    order_config_options(&visible)
}

/// The options a row shows: none while restored.
pub fn row_config_options(row: Option<&AgentTaskRow>) -> Vec<SessionConfigSelect> {
    match row {
        Some(row) if row.status != TaskStatus::Restored => {
            visible_config_options(row.config_options.as_deref().unwrap_or(&[]))
        }
        _ => Vec::new(),
    }
}

/// One labelled group of choices (`ChoiceGroup`).
#[derive(Clone, Debug, PartialEq)]
pub struct ChoiceGroup {
    pub name: Option<String>,
    pub choices: Vec<ConfigChoice>,
}

/// `choiceGroups`: ungrouped and grouped options as labelled groups.
pub fn choice_groups(option: &SessionConfigSelect) -> Vec<ChoiceGroup> {
    match &option.options {
        ConfigOptions::Flat(choices) => {
            if choices.is_empty() {
                Vec::new()
            } else {
                vec![ChoiceGroup { name: None, choices: choices.clone() }]
            }
        }
        ConfigOptions::Grouped(groups) => groups
            .iter()
            .map(|g| ChoiceGroup { name: Some(g.name.clone()), choices: g.options.clone() })
            .collect(),
    }
}

/// `currentChoiceName`: the raw id when the agent moved to a value it never
/// listed, so the trigger never goes blank.
pub fn current_choice_name(option: &SessionConfigSelect) -> String {
    let current = option.current().unwrap_or_default();
    choice_groups(option)
        .iter()
        .flat_map(|g| g.choices.iter())
        .find(|c| c.value == current)
        .map(|c| c.name.clone())
        .unwrap_or_else(|| current.to_string())
}

/// `triggerLabel`: a self-describing value alone; any other option needs
/// its name ("Fast mode: Off").
pub fn trigger_label(option: &SessionConfigSelect) -> String {
    let value = current_choice_name(option);
    if SELF_DESCRIBING_CATEGORIES.contains(&option.category.as_deref().unwrap_or("")) {
        value
    } else {
        format!("{}: {value}", option.name)
    }
}

/// cmdk's filter, roughly: every word of the query in `name value`.
pub fn choice_matches(choice: &ConfigChoice, query: &str) -> bool {
    let hay = format!("{} {}", choice.name, choice.value).to_lowercase();
    query.to_lowercase().split_whitespace().all(|w| hay.contains(w))
}

pub enum ConfigBarEvent {
    /// A picker closed: the composer takes focus back.
    Closed,
}

/// The pickers of one session (`SessionConfigBar`).
pub struct ConfigBar {
    task_id: String,
    open: Option<String>,
    filter: String,
    highlighted: usize,
    focus: FocusHandle,
    _sub: notefig_core::Subscription,
}

impl EventEmitter<ConfigBarEvent> for ConfigBar {}

impl ConfigBar {
    pub fn new(task_id: String, cx: &mut Context<Self>) -> Self {
        let store = cx.core().use_::<notefig_agents::AgentStoreModule>();
        let id = task_id.clone();
        let sub = observe(cx, move |notify| store.subscribe_task(&id, move || notify()));
        Self { task_id, open: None, filter: String::new(), highlighted: 0, focus: cx.focus_handle(), _sub: sub }
    }

    #[allow(dead_code)]
    pub fn is_open(&self) -> bool {
        self.open.is_some()
    }

    fn options(&self, cx: &App) -> Vec<SessionConfigSelect> {
        let row = cx.core().use_::<notefig_agents::AgentStoreModule>().task(&self.task_id);
        row_config_options(row.as_ref())
    }

    fn toggle(&mut self, option_id: &str, window: &mut Window, cx: &mut Context<Self>) {
        if self.open.as_deref() == Some(option_id) {
            self.close(window, cx);
            return;
        }
        self.open = Some(option_id.to_string());
        self.filter.clear();
        // Start on the current value.
        self.highlighted = self
            .options(cx)
            .iter()
            .find(|o| o.id == option_id)
            .and_then(|o| {
                let cur = o.current().unwrap_or_default().to_string();
                choice_groups(o).iter().flat_map(|g| g.choices.clone()).position(|c| c.value == cur)
            })
            .unwrap_or(0);
        window.focus(&self.focus, cx);
        cx.notify();
    }

    fn close(&mut self, _: &mut Window, cx: &mut Context<Self>) {
        if self.open.take().is_some() {
            cx.emit(ConfigBarEvent::Closed);
        }
        cx.notify();
    }

    /// The open picker's choices after the filter, flattened.
    fn visible_choices(&self, option: &SessionConfigSelect) -> Vec<ConfigChoice> {
        choice_groups(option)
            .into_iter()
            .flat_map(|g| g.choices)
            .filter(|c| choice_matches(c, &self.filter))
            .collect()
    }

    /// `choose`: switch through the facade; a failure toasts.
    fn choose(&mut self, option: SessionConfigSelect, value: String, window: &mut Window, cx: &mut Context<Self>) {
        self.close(window, cx);
        if option.current() == Some(value.as_str()) {
            return;
        }
        let agents = cx.core().use_::<AgentsModule>();
        let pending = agents.task(&self.task_id).set_config_option(&option.id, &value);
        let name = option.name.clone();
        cx.spawn_in(window, async move |_, cx| {
            if let Err(error) = pending.await {
                let message = t_args("agentSettingSwitchFailed", &[("name", &name), ("error", &error)]);
                let _ = cx.update(|window, cx| {
                    window.push_notification(gpui_kit::component::notification::Notification::error(message), cx)
                });
            }
        })
        .detach();
    }

    fn on_key(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let Some(open) = self.open.clone() else { return };
        let Some(option) = self.options(cx).into_iter().find(|o| o.id == open) else {
            self.close(window, cx);
            return;
        };
        let filterable = choice_groups(&option).iter().map(|g| g.choices.len()).sum::<usize>() > FILTER_THRESHOLD;
        let choices = self.visible_choices(&option);
        let key = event.keystroke.key.as_str();
        match key {
            "escape" => self.close(window, cx),
            "up" => self.highlighted = self.highlighted.saturating_sub(1),
            "down" => self.highlighted = (self.highlighted + 1).min(choices.len().saturating_sub(1)),
            "enter" => {
                if let Some(choice) = choices.get(self.highlighted) {
                    self.choose(option.clone(), choice.value.clone(), window, cx);
                }
            }
            "backspace" if filterable => {
                self.filter.pop();
                self.highlighted = 0;
            }
            _ => {
                let typed = event.keystroke.key_char.clone().filter(|c| !c.chars().any(char::is_control));
                match typed {
                    Some(text) if filterable && !event.keystroke.modifiers.platform && !event.keystroke.modifiers.control => {
                        self.filter.push_str(&text);
                        self.highlighted = 0;
                    }
                    _ => return,
                }
            }
        }
        cx.stop_propagation();
        cx.notify();
    }

    fn render_picker(&self, option: &SessionConfigSelect, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let t = tokens(cx);
        let (muted, fg, accent) = (t.muted_foreground, t.foreground, t.accent);
        let open = self.open.as_deref() == Some(option.id.as_str());
        let id = option.id.clone();
        let title: SharedString = option.description.clone().unwrap_or_else(|| option.name.clone()).into();
        let trigger = div()
            .id(SharedString::from(format!("session-config-{}", option.id)))
            .flex()
            .h(sp(4.))
            .max_w(rem(8.))
            .items_center()
            .rounded(radius_default())
            .px(sp(1.))
            .text_size(text_10())
            .line_height(sp(4.))
            .text_color(muted)
            .cursor_pointer()
            .when(open, |d| d.bg(accent).text_color(fg))
            .hover(move |s| s.bg(accent).text_color(fg))
            .child(div().truncate().child(trigger_label(option)))
            .tooltip(move |window, cx| gpui_kit::component::tooltip::Tooltip::new(title.clone()).build(window, cx))
            .on_click(cx.listener(move |this, _, window, cx| this.toggle(&id, window, cx)));
        let panel = open.then(|| self.render_list(option, window, cx));
        div().relative().child(trigger).children(panel).into_any_element()
    }

    fn render_list(&self, option: &SessionConfigSelect, _: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let t = tokens(cx);
        let (muted, accent, border) = (t.muted_foreground, t.accent, t.border);
        let groups = choice_groups(option);
        let count: usize = groups.iter().map(|g| g.choices.len()).sum();
        let current = option.current().unwrap_or_default().to_string();
        let mut list = div().id("session-config-list").flex().flex_col().max_h(rem(14.)).overflow_y_scroll();
        let mut flat = 0usize;
        let mut any = false;
        for (gi, group) in groups.iter().enumerate() {
            let choices: Vec<&ConfigChoice> = group.choices.iter().filter(|c| choice_matches(c, &self.filter)).collect();
            if choices.is_empty() {
                continue;
            }
            any = true;
            let mut g = div().flex().flex_col().p(sp(0.5));
            if let Some(name) = &group.name {
                g = g.child(
                    div().px(sp(1.5)).py(sp(0.5)).text_size(text_9()).text_color(muted).child(name.to_uppercase()),
                );
            }
            for choice in choices {
                let ix = flat;
                flat += 1;
                let highlighted = ix == self.highlighted;
                let (opt, value) = (option.clone(), choice.value.clone());
                g = g.child(
                    div()
                        .id(SharedString::from(format!("session-config-choice-{gi}-{}", choice.value)))
                        .flex()
                        .items_center()
                        .gap(sp(1.))
                        .px(sp(1.5))
                        .py(sp(0.5))
                        .rounded(t.radius_sm)
                        .text_size(text_11())
                        .cursor_pointer()
                        .when(highlighted, |d| d.bg(accent))
                        .on_mouse_move(cx.listener(move |this, _, _, cx| {
                            if this.highlighted != ix {
                                this.highlighted = ix;
                                cx.notify();
                            }
                        }))
                        .on_click(cx.listener(move |this, _, window, cx| this.choose(opt.clone(), value.clone(), window, cx)))
                        .child(
                            div()
                                .flex()
                                .flex_col()
                                .flex_1()
                                .min_w_0()
                                .child(div().truncate().child(choice.name.clone()))
                                .when_some(choice.description.clone(), |d, desc| {
                                    d.child(div().truncate().text_size(text_9()).text_color(muted).child(desc))
                                }),
                        )
                        .when(choice.value == current, |d| d.child(icon("check").size(rem(0.625)).flex_none().text_color(t.popover_foreground))),
                );
            }
            list = list.child(g);
        }
        if !any {
            list = list.child(
                div().py(sp(2.)).text_center().text_size(text_10()).text_color(muted).child(tr("agentNoSettingMatches")),
            );
        }
        let filter_box = (count > FILTER_THRESHOLD).then(|| {
            let empty = self.filter.is_empty();
            div()
                .h(sp(5.))
                .px(sp(1.5))
                .flex()
                .items_center()
                .border_b_1()
                .border_color(border)
                .text_size(text_11())
                .when(empty, |d| {
                    d.text_color(muted).child(t_args("agentFilterSetting", &[("name", &option.name)]))
                })
                .when(!empty, |d| d.child(self.filter.clone()))
        });
        anchored_popover(
            PopoverSide::AboveStart,
            popover_frame(cx)
                .id("session-config-popover")
                .track_focus(&self.focus)
                .min_w(rem(9.))
                .max_w(rem(16.))
                .text_size(text_11())
                .font_weight(FontWeight::NORMAL)
                .on_key_down(cx.listener(Self::on_key))
                .on_mouse_down_out(cx.listener(|this, _, window, cx| this.close(window, cx)))
                .children(filter_box)
                .child(list),
        )
    }
}

impl Focusable for ConfigBar {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for ConfigBar {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let options = self.options(cx);
        if self.open.as_ref().is_some_and(|o| !options.iter().any(|x| &x.id == o)) {
            self.open = None;
        }
        div()
            .flex()
            .items_end()
            .gap(sp(1.))
            .children(options.iter().map(|o| self.render_picker(o, window, cx)).collect::<Vec<_>>())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn option(id: &str, category: Option<&str>, current: &str, options: serde_json::Value) -> SessionConfigSelect {
        serde_json::from_value(json!({
            "id": id, "name": id.to_uppercase(), "category": category,
            "currentValue": current, "options": options,
        }))
        .unwrap()
    }

    fn flat(values: &[(&str, &str)]) -> serde_json::Value {
        json!(values.iter().map(|(v, n)| json!({"value": v, "name": n})).collect::<Vec<_>>())
    }

    #[test]
    fn orders_model_then_effort_then_the_rest() {
        let opts = vec![
            option("mode", Some("mode"), "a", flat(&[("a", "A")])),
            option("effort", Some("thought_level"), "h", flat(&[("h", "High")])),
            option("model", Some("model"), "o", flat(&[("o", "Opus")])),
        ];
        let ids: Vec<String> = order_config_options(&opts).into_iter().map(|o| o.id).collect();
        assert_eq!(ids, ["model", "effort", "mode"]);
        let visible: Vec<String> = visible_config_options(&opts).into_iter().map(|o| o.id).collect();
        assert_eq!(visible, ["model", "effort"]);
    }

    #[test]
    fn current_name_falls_back_to_the_raw_value() {
        let o = option("model", Some("model"), "opus", flat(&[("opus", "Opus"), ("sonnet", "Sonnet")]));
        assert_eq!(current_choice_name(&o), "Opus");
        let gone = option("model", Some("model"), "haiku", flat(&[("opus", "Opus")]));
        assert_eq!(current_choice_name(&gone), "haiku");
    }

    #[test]
    fn grouped_choices_keep_their_groups() {
        let o = option(
            "model",
            Some("model"),
            "b",
            json!([{"group": "g1", "name": "Anthropic", "options": [{"value": "a", "name": "A"}]},
                   {"group": "g2", "name": "OpenAI", "options": [{"value": "b", "name": "B"}]}]),
        );
        let groups = choice_groups(&o);
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[1].name.as_deref(), Some("OpenAI"));
        assert_eq!(current_choice_name(&o), "B");
    }

    #[test]
    fn trigger_label_names_options_that_do_not_describe_themselves() {
        let model = option("model", Some("model"), "o", flat(&[("o", "Opus")]));
        assert_eq!(trigger_label(&model), "Opus");
        let fast = option("fast", Some("model_config"), "off", flat(&[("off", "Off")]));
        assert_eq!(trigger_label(&fast), "FAST: Off");
    }

    #[test]
    fn restored_rows_show_nothing() {
        let row: AgentTaskRow = serde_json::from_value(json!({
            "taskId": "t", "workspacePath": "/w", "title": "x", "status": "restored", "harnessId": "h",
            "createdAt": 0, "updatedAt": 0,
            "configOptions": [{"id": "model", "name": "Model", "category": "model", "currentValue": "o",
                               "options": [{"value": "o", "name": "Opus"}]}],
        }))
        .unwrap();
        assert!(row_config_options(Some(&row)).is_empty());
        let live = AgentTaskRow { status: TaskStatus::Idle, ..row };
        assert_eq!(row_config_options(Some(&live)).len(), 1);
    }

    #[test]
    fn filter_matches_name_or_value() {
        let c = ConfigChoice { value: "claude-sonnet-4".into(), name: "Sonnet".into(), description: None };
        assert!(choice_matches(&c, "son"));
        assert!(choice_matches(&c, "claude 4"));
        assert!(!choice_matches(&c, "opus"));
    }
}
