//! Settings tab: harnesses (`harness-settings.tsx`: found/not found, enable,
//! edit command/args/env, add custom, rescan) and a simple usage view (by
//! day and harness, from the hourly usage buckets).

use std::collections::BTreeMap;

use gpui::{
    AppContext as _, Context, Entity, InteractiveElement, IntoElement, ParentElement, Render,
    SharedString, StatefulInteractiveElement as _, Styled, Subscription, Window, div,
    prelude::FluentBuilder as _, px,
};
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::component::switch::Switch;
use gpui_kit::component::{ActiveTheme as _, Disableable as _, Sizable as _, h_flex, v_flex};
use notefig_agent::harness::{
    Availability, CustomHarnessEntry, HarnessOrigin, HarnessOverride, HarnessSettingsRow,
    McpRegistration,
};

use super::Agents;
use super::chat::compact;
use crate::theme::BrandColors;

struct EditForm {
    /// The harness being edited; `None` = a new custom entry.
    id: Option<String>,
    id_input: Entity<InputState>,
    label: Entity<InputState>,
    command: Entity<InputState>,
    args: Entity<InputState>,
    env: Entity<InputState>,
}

pub struct SettingsView {
    agents: Entity<Agents>,
    form: Option<EditForm>,
    rescanning: bool,
    status: Option<SharedString>,
    _sub: Subscription,
}

fn parse_env(text: &str) -> BTreeMap<String, String> {
    text.split([',', '\n'])
        .filter_map(|kv| {
            let (k, v) = kv.trim().split_once('=')?;
            (!k.trim().is_empty()).then(|| (k.trim().to_string(), v.trim().to_string()))
        })
        .collect()
}

fn split_args(text: &str) -> Vec<String> {
    text.split_whitespace().map(String::from).collect()
}

impl SettingsView {
    pub fn new(agents: Entity<Agents>, cx: &mut Context<Self>) -> Self {
        let sub = cx.observe(&agents, |_, _, cx| cx.notify());
        Self {
            agents,
            form: None,
            rescanning: false,
            status: None,
            _sub: sub,
        }
    }

    fn input(value: &str, placeholder: &str, window: &mut Window, cx: &mut Context<Self>) -> Entity<InputState> {
        let (value, placeholder) = (value.to_string(), placeholder.to_string());
        cx.new(|cx| InputState::new(window, cx).placeholder(placeholder).default_value(value))
    }

    fn edit(&mut self, row: Option<HarnessSettingsRow>, window: &mut Window, cx: &mut Context<Self>) {
        let def = row.as_ref().map(|r| r.definition.clone());
        let env = def
            .as_ref()
            .map(|d| d.env.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join(", "))
            .unwrap_or_default();
        self.form = Some(EditForm {
            id: def.as_ref().map(|d| d.id.clone()),
            id_input: Self::input("", "id (e.g. my-agent)", window, cx),
            label: Self::input(def.as_ref().map(|d| d.label.as_str()).unwrap_or(""), "Label", window, cx),
            command: Self::input(def.as_ref().map(|d| d.command.as_str()).unwrap_or(""), "Command", window, cx),
            args: Self::input(&def.as_ref().map(|d| d.args.join(" ")).unwrap_or_default(), "Arguments", window, cx),
            env: Self::input(&env, "KEY=value, KEY2=value", window, cx),
        });
        cx.notify();
    }

    fn save_form(&mut self, cx: &mut Context<Self>) {
        let Some(form) = self.form.take() else { return };
        let read = |i: &Entity<InputState>| i.read(cx).value().trim().to_string();
        let handle = self.agents.read(cx).handle.clone();
        let (label, command, args, env) = (read(&form.label), read(&form.command), read(&form.args), read(&form.env));
        let row = form.id.as_ref().and_then(|id| handle.harness_settings().into_iter().find(|r| &r.definition.id == id));
        match row {
            Some(row) if row.origin != HarnessOrigin::Custom => {
                let _ = handle.save_override(
                    &row.definition.id,
                    Some(HarnessOverride {
                        id: row.definition.id.clone(),
                        enabled: row.enabled,
                        command: Some(command).filter(|c| !c.is_empty()),
                        args: Some(split_args(&args)),
                        env: Some(parse_env(&env)),
                        probe_command: None,
                        resume_command: None,
                    }),
                );
            }
            row => {
                let id = row
                    .as_ref()
                    .map(|r| r.definition.id.clone())
                    .unwrap_or_else(|| read(&form.id_input));
                if id.is_empty() || command.is_empty() {
                    self.status = Some("A custom harness needs an id and a command.".into());
                    cx.notify();
                    return;
                }
                let _ = handle.save_custom(
                    &id,
                    CustomHarnessEntry {
                        id: id.clone(),
                        label: if label.is_empty() { id.clone() } else { label },
                        command,
                        args: split_args(&args),
                        env: parse_env(&env),
                        probe_command: None,
                        auth_hint: None,
                        resume_command: None,
                        mcp_registration_override: McpRegistration::SessionNew,
                        enabled: true,
                    },
                );
            }
        }
        self.status = Some("Saved.".into());
        cx.notify();
    }

    fn rescan(&mut self, cx: &mut Context<Self>) {
        self.rescanning = true;
        let pending = self.agents.read(cx).handle.rescan_harnesses();
        cx.spawn(async move |this, cx| {
            let result = pending.recv().await.flatten();
            let _ = this.update(cx, |this, cx| {
                this.rescanning = false;
                this.status = Some(match result {
                    Some(found) => format!(
                        "Rescanned: {} found.",
                        found.iter().filter(|r| r.found).count()
                    )
                    .into(),
                    None => "Couldn't check the login shell's PATH.".into(),
                });
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn render_form(&self, form: &EditForm, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().clone();
        let field = |label: &'static str, input: &Entity<InputState>| {
            h_flex()
                .gap_2()
                .child(div().w(px(90.)).text_xs().text_color(theme.muted_foreground).child(label))
                .child(div().flex_1().child(Input::new(input).small()))
        };
        v_flex()
            .gap_1()
            .p_2()
            .rounded_md()
            .border_1()
            .border_color(theme.border)
            .when(form.id.is_none(), |this| this.child(field("Id", &form.id_input)))
            .child(field("Label", &form.label))
            .child(field("Command", &form.command))
            .child(field("Arguments", &form.args))
            .child(field("Environment", &form.env))
            .child(
                h_flex()
                    .gap_1()
                    .child(Button::new("form-save").label("Save").small().primary().on_click(cx.listener(|this, _, _, cx| this.save_form(cx))))
                    .child(Button::new("form-cancel").label("Cancel").small().ghost().on_click(cx.listener(|this, _, _, cx| {
                        this.form = None;
                        cx.notify();
                    }))),
            )
    }

    fn render_usage(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().clone();
        let brand = BrandColors::get(cx).brand;
        let handle = self.agents.read(cx).handle.clone();
        // day → harness → (tokens, cost)
        let mut by_day: BTreeMap<String, BTreeMap<String, (f64, f64)>> = BTreeMap::new();
        for bucket in handle.usage_buckets() {
            let day = day_of(bucket.hour);
            let entry = by_day.entry(day).or_default().entry(bucket.harness_id.clone()).or_default();
            entry.0 += bucket.summary.total.tokens.total();
            entry.1 += bucket.summary.total.cost.as_ref().map(|c| c.amount).unwrap_or(0.0);
        }
        let max = by_day
            .values()
            .map(|h| h.values().map(|v| v.0).sum::<f64>())
            .fold(0.0, f64::max)
            .max(1.0);
        let days: Vec<_> = by_day.into_iter().rev().take(14).collect();
        v_flex()
            .gap_1()
            .when(days.is_empty(), |this| {
                this.child(div().text_sm().text_color(theme.muted_foreground).child("No usage recorded yet."))
            })
            .children(days.into_iter().map(|(day, harnesses)| {
                let total: f64 = harnesses.values().map(|v| v.0).sum();
                let cost: f64 = harnesses.values().map(|v| v.1).sum();
                let names = harnesses
                    .iter()
                    .map(|(h, v)| format!("{} {}", handle.harness_label(h), compact(v.0)))
                    .collect::<Vec<_>>()
                    .join(" · ");
                h_flex()
                    .gap_2()
                    .text_xs()
                    .child(div().w(px(80.)).child(day))
                    .child(
                        div().w(px(160.)).h(px(8.)).rounded_full().bg(theme.muted).child(
                            div().h_full().rounded_full().bg(brand).w(px(160. * (total / max) as f32)),
                        ),
                    )
                    .child(div().w(px(70.)).child(format!("{} tok", compact(total))))
                    .child(div().w(px(60.)).child(if cost > 0.0 { format!("${cost:.2}") } else { "—".into() }))
                    .child(div().flex_1().truncate().text_color(theme.muted_foreground).child(names))
            }))
    }
}

/// `YYYY-MM-DD` (UTC) of a millisecond timestamp.
pub fn day_of(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    // Civil-from-days (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    format!("{:04}-{:02}-{:02}", if m <= 2 { y + 1 } else { y }, m, d)
}

impl Render for SettingsView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().clone();
        let brand = BrandColors::get(cx);
        let handle = self.agents.read(cx).handle.clone();
        let rows = handle.harness_settings();
        let editing = self.form.as_ref().map(|f| f.id.clone());
        let section = |title: &'static str| {
            div()
                .pt_4()
                .pb_1()
                .text_xs()
                .font_weight(gpui::FontWeight::SEMIBOLD)
                .text_color(theme.muted_foreground)
                .child(title.to_uppercase())
        };
        let mut list = v_flex().gap_1();
        for row in rows {
            let id = row.definition.id.clone();
            let dot = match row.availability {
                Availability::Found => brand.success,
                Availability::Missing => brand.warning,
                Availability::Unknown => theme.muted_foreground,
            };
            let detail = match (&row.availability, &row.discovery) {
                (Availability::Found, Some(d)) => d.resolved_path.clone().unwrap_or_else(|| "found".into()),
                (Availability::Found, None) => "found".into(),
                (Availability::Missing, _) => format!("not found ({})", row.definition.command),
                (Availability::Unknown, _) => "not checked".into(),
            };
            let (h1, id1) = (handle.clone(), id.clone());
            let row2 = row.clone();
            let is_custom = row.origin == HarnessOrigin::Custom;
            list = list.child(
                v_flex()
                    .gap_1()
                    .child(
                        h_flex()
                            .id(SharedString::from(format!("harness-{id}")))
                            .gap_2()
                            .py_1()
                            .child(div().size(px(8.)).rounded_full().bg(dot))
                            .child(
                                v_flex()
                                    .flex_1()
                                    .child(div().text_sm().child(row.definition.label.clone()))
                                    .child(div().text_xs().text_color(theme.muted_foreground).truncate().child(detail)),
                            )
                            .when(row.origin == HarnessOrigin::Overridden, |this| {
                                this.child(div().text_xs().text_color(theme.muted_foreground).child("edited"))
                            })
                            .child(Button::new(SharedString::from(format!("edit-{id}"))).label("Edit").xsmall().ghost().on_click(
                                cx.listener(move |this, _, window, cx| this.edit(Some(row2.clone()), window, cx)),
                            ))
                            .when(is_custom, |this| {
                                let (h, i) = (handle.clone(), id.clone());
                                this.child(
                                    Button::new(SharedString::from(format!("remove-{id}")))
                                        .label("Remove")
                                        .xsmall()
                                        .ghost()
                                        .on_click(move |_, _, _| h.remove_custom_harness(&i)),
                                )
                            })
                            .child(
                                Switch::new(SharedString::from(format!("enable-{id}")))
                                    .checked(row.enabled)
                                    .on_click(move |checked, _, _| h1.set_harness_enabled(&id1, *checked)),
                            ),
                    )
                    .when(editing == Some(Some(id.clone())), |this| {
                        this.child(self.render_form(self.form.as_ref().unwrap(), cx))
                    }),
            );
        }
        v_flex()
            .id("settings")
            .size_full()
            .overflow_y_scroll()
            .bg(theme.background)
            .child(
                v_flex()
                    .w_full()
                    .max_w(px(760.))
                    .mx_auto()
                    .p_6()
                    .child(div().text_xl().font_weight(gpui::FontWeight::BOLD).child("Settings"))
                    .child(
                        h_flex()
                            .justify_between()
                            .child(section("Agent harnesses"))
                            .child(
                                h_flex()
                                    .gap_1()
                                    .child(Button::new("add-custom").label("Add custom").xsmall().ghost().on_click(
                                        cx.listener(|this, _, window, cx| this.edit(None, window, cx)),
                                    ))
                                    .child(
                                        Button::new("rescan")
                                            .label(if self.rescanning { "Rescanning…" } else { "Rescan" })
                                            .xsmall()
                                            .outline()
                                            .disabled(self.rescanning)
                                            .on_click(cx.listener(|this, _, _, cx| this.rescan(cx))),
                                    ),
                            ),
                    )
                    .when_some(self.status.clone(), |this, s| {
                        this.child(div().text_xs().text_color(theme.muted_foreground).child(s))
                    })
                    .when(editing == Some(None), |this| this.child(self.render_form(self.form.as_ref().unwrap(), cx)))
                    .child(list)
                    .child(section("Usage (last 14 days)"))
                    .child(self.render_usage(cx)),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn helpers() {
        assert_eq!(day_of(0), "1970-01-01");
        assert_eq!(day_of(1_793_432_053_300), "2026-10-31");
        assert_eq!(parse_env("A=1, B = x\nC"), BTreeMap::from([("A".into(), "1".into()), ("B".into(), "x".into())]));
        assert_eq!(split_args(" --a  b "), vec!["--a", "b"]);
    }
}
