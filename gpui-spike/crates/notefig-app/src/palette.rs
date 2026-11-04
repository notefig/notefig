//! Quick open (Cmd+P) and the command palette (Cmd+Shift+P): an input over
//! a fuzzy-ranked list, as an overlay the workspace shows.

use gpui::{
    Action, AppContext as _, Context, Entity, EventEmitter, InteractiveElement, IntoElement,
    KeyDownEvent, MouseButton, ParentElement, Render, SharedString,
    StatefulInteractiveElement as _, Styled, Subscription, Window, div, prelude::FluentBuilder as _,
    px,
};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::{ActiveTheme as _, h_flex, v_flex};

use crate::fuzzy;

const LIMIT: usize = 60;

pub enum PaletteMode {
    /// Workspace-relative file paths.
    Files(Vec<String>),
    Commands(Vec<(&'static str, Box<dyn Action>)>),
}

pub enum PaletteEvent {
    OpenFile(String),
    Run(Box<dyn Action>),
    Dismissed,
}

pub struct Palette {
    mode: PaletteMode,
    pub input: Entity<InputState>,
    matches: Vec<usize>,
    selected: usize,
    _sub: Subscription,
}

impl EventEmitter<PaletteEvent> for Palette {}

impl Palette {
    pub fn new(mode: PaletteMode, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let placeholder = match mode {
            PaletteMode::Files(_) => "Go to file…",
            PaletteMode::Commands(_) => "Run a command…",
        };
        let input = cx.new(|cx| InputState::new(window, cx).placeholder(placeholder));
        let sub = cx.subscribe(&input, |this: &mut Self, _, event: &InputEvent, cx| {
            match event {
                InputEvent::Change => this.refilter(cx),
                InputEvent::PressEnter { .. } => this.confirm(cx),
                _ => {}
            }
        });
        input.update(cx, |input, cx| input.focus(window, cx));
        let mut this = Self {
            mode,
            input,
            matches: Vec::new(),
            selected: 0,
            _sub: sub,
        };
        this.refilter(cx);
        this
    }

    fn labels(&self) -> Vec<&str> {
        match &self.mode {
            PaletteMode::Files(files) => files.iter().map(String::as_str).collect(),
            PaletteMode::Commands(cmds) => cmds.iter().map(|(l, _)| *l).collect(),
        }
    }

    pub fn query(&self, cx: &gpui::App) -> String {
        self.input.read(cx).value().to_string()
    }

    pub fn refilter(&mut self, cx: &mut Context<Self>) {
        let query = self.query(cx);
        let paths = matches!(self.mode, PaletteMode::Files(_));
        self.matches = fuzzy::rank(&self.labels(), &query, paths, LIMIT);
        self.selected = 0;
        cx.notify();
    }

    pub fn match_labels(&self) -> Vec<String> {
        let labels = self.labels();
        self.matches.iter().map(|&i| labels[i].to_string()).collect()
    }

    fn move_selection(&mut self, delta: isize, cx: &mut Context<Self>) {
        let n = self.matches.len() as isize;
        if n > 0 {
            self.selected = (((self.selected as isize + delta) % n + n) % n) as usize;
            cx.notify();
        }
    }

    pub fn confirm(&mut self, cx: &mut Context<Self>) {
        self.pick(self.selected, cx);
    }

    fn pick(&mut self, at: usize, cx: &mut Context<Self>) {
        let Some(&ix) = self.matches.get(at) else {
            return;
        };
        let event = match &self.mode {
            PaletteMode::Files(files) => PaletteEvent::OpenFile(files[ix].clone()),
            PaletteMode::Commands(cmds) => PaletteEvent::Run(cmds[ix].1.boxed_clone()),
        };
        cx.emit(event);
    }

    fn on_key(&mut self, event: &KeyDownEvent, _: &mut Window, cx: &mut Context<Self>) {
        match event.keystroke.key.as_str() {
            "up" => self.move_selection(-1, cx),
            "down" => self.move_selection(1, cx),
            "escape" => cx.emit(PaletteEvent::Dismissed),
            "enter" => self.confirm(cx),
            _ => return,
        }
        cx.stop_propagation();
    }
}

impl Render for Palette {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let labels = self.labels();
        let is_files = matches!(self.mode, PaletteMode::Files(_));
        let rows: Vec<_> = self
            .matches
            .iter()
            .enumerate()
            .map(|(row, &ix)| {
                let label = labels[ix];
                let (name, dir) = if is_files {
                    let name = notefig_workspace::file_name(label).to_string();
                    let dir = notefig_workspace::parent_rel(label).to_string();
                    (name, dir)
                } else {
                    (label.to_string(), String::new())
                };
                h_flex()
                    .id(("palette-row", row))
                    .px_3()
                    .py_1()
                    .gap_2()
                    .rounded_md()
                    .text_sm()
                    .when(row == self.selected, |this| {
                        this.bg(theme.list_active).text_color(theme.accent_foreground)
                    })
                    .hover(|this| this.bg(theme.list_hover))
                    .child(SharedString::from(name))
                    .when(!dir.is_empty(), |this| {
                        this.child(
                            div()
                                .text_xs()
                                .text_color(theme.muted_foreground)
                                .child(SharedString::from(dir)),
                        )
                    })
                    .on_click(cx.listener(move |this, _, _, cx| this.pick(row, cx)))
            })
            .collect();
        let empty = rows.is_empty();
        // Backdrop: a click outside dismisses.
        div()
            .id("palette-backdrop")
            .absolute()
            .inset_0()
            .flex()
            .justify_center()
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|_, _, _, cx| cx.emit(PaletteEvent::Dismissed)),
            )
            .child(
                v_flex()
                    .id("palette")
                    .key_context("Palette")
                    .capture_key_down(cx.listener(Self::on_key))
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .mt(px(64.))
                    .w(px(560.))
                    .max_h(px(420.))
                    .p_2()
                    .gap_1()
                    .rounded_lg()
                    .border_1()
                    .border_color(theme.border)
                    .bg(theme.popover)
                    .text_color(theme.popover_foreground)
                    .shadow_lg()
                    .child(Input::new(&self.input))
                    .child(
                        v_flex()
                            .id("palette-list")
                            .overflow_y_scroll()
                            .children(rows)
                            .when(empty, |this| {
                                this.child(
                                    div()
                                        .p_3()
                                        .text_sm()
                                        .text_color(theme.muted_foreground)
                                        .child("No matches"),
                                )
                            }),
                    ),
            )
    }
}
