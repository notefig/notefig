//! The document minimap (TS `packages/widgets/src/minimap`, MET-172): one
//! dot per prompt widget on a short rail beside the editor. The editor
//! owns where dots go and how they look; the host says what each dot says
//! (title and live state) through a [`MinimapSource`].

use std::{rc::Rc, time::Duration};

use gpui::prelude::FluentBuilder as _;
use gpui::{
    Animation, AppContext as _, AnimationExt as _, App, Entity, Hsla, InteractiveElement as _, IntoElement,
    ParentElement as _, Render, RenderOnce, SharedString, StatefulInteractiveElement as _,
    Styled as _, Window, div, px, rems,
};

use super::{
    editor::BlockEditorModel, id::BlockId, notefig::PromptWidget, state::BlockEditorState,
};

/// Where the element's round is (TS `MinimapDotCore`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum MinimapDotCore {
    /// Settled and working states.
    #[default]
    Neutral,
    /// Blocked on the user.
    Attention,
    Error,
    /// Holds a result the user hasn't seen.
    Fresh,
}

/// A dot's live state: the two-axis vocabulary (TS `MinimapDotState`).
#[derive(Clone, Debug, Default, PartialEq, Eq, Hash)]
pub struct MinimapDotState {
    pub core: MinimapDotCore,
    /// Phase description: the tooltip's first line.
    pub label: Option<SharedString>,
    /// A background punch in the centre: an empty vessel.
    pub hollow: bool,
    /// The bump breathes (system busy).
    pub breathe: bool,
    /// The hollow punch pulses (waiting).
    pub pulse: bool,
    /// A wave bursts past the bump (a human must act).
    pub ping: bool,
}

impl MinimapDotState {
    /// A dot with nothing to say (TS `MINIMAP_STILL_DOT`).
    pub fn still() -> Self {
        Self::default()
    }
}

/// What the host says about one widget's dot.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MinimapDot {
    /// Short handle for the tooltip (clamped by [`dot_title`]).
    pub title: SharedString,
    pub state: MinimapDotState,
}

/// The host's dots: called for each widget on every render of the rail,
/// so it reads live state (the widget's phase, its round).
pub type MinimapSource = Rc<dyn Fn(&PromptWidget, &App) -> MinimapDot>;

/// What a dot's click does after the editor reveals the block (TS's
/// `reveal` option: the registry's `revealWidget`, focusing the composer).
/// Handed the editor the rail maps, as TS's `reveal` is handed its view.
pub type MinimapJump = Rc<dyn Fn(&Entity<BlockEditorState>, BlockId, &PromptWidget, &mut Window, &mut App)>;

/// One mapped widget, placed on the rail.
#[derive(Clone, Debug, PartialEq)]
pub struct MinimapEntry {
    pub block: BlockId,
    pub widget: PromptWidget,
    /// 0..1 position on the rail (document order kept, crowding spread).
    pub ratio: f32,
}

const TITLE_MAX_CHARS: usize = 48;
const RATIO_LO: f32 = 0.01;
const RATIO_HI: f32 = 0.99;
/// Minimum rail distance between adjacent dots.
const MIN_GAP: f32 = 0.07;

/// A dot's title as the rail shows it: clamped, with an ellipsis.
pub fn dot_title(title: &str) -> String {
    match title.char_indices().nth(TITLE_MAX_CHARS) {
        Some((cut, _)) => format!("{}…", &title[..cut]),
        None => title.to_string(),
    }
}

/// Nudge crowded dots apart, keeping document order (TS `spreadRatios`):
/// forward pushes each below its predecessor's minimum, backward pulls up
/// from the clamped end; the gap shrinks when the rail is genuinely full.
pub fn spread_ratios(ratios: &[f32]) -> Vec<f32> {
    let mut out = ratios.to_vec();
    if out.len() < 2 {
        return out;
    }
    let gap = MIN_GAP.min((RATIO_HI - RATIO_LO) / (out.len() - 1) as f32);
    for i in 1..out.len() {
        out[i] = out[i].max(out[i - 1] + gap);
    }
    let last = out.len() - 1;
    out[last] = out[last].min(RATIO_HI);
    for i in (0..last).rev() {
        out[i] = out[i].min(out[i + 1] - gap);
    }
    out
}

impl BlockEditorModel {
    /// Every prompt widget placed on the rail, in document order (TS
    /// `deriveMinimapEntries`): its position among the document's leaves,
    /// clamped in from the edges and spread apart.
    pub fn minimap_entries(&self) -> Vec<MinimapEntry> {
        let widgets = self.doc.prompt_widgets();
        if widgets.is_empty() {
            return Vec::new();
        }
        let size = self.doc.leaves().len().max(1) as f32;
        let ratios: Vec<f32> = widgets
            .iter()
            .map(|(block, _)| {
                let rank = self.doc.order.rank(*block).unwrap_or(0) as f32;
                (rank / size).clamp(RATIO_LO, RATIO_HI)
            })
            .collect();
        widgets
            .into_iter()
            .zip(spread_ratios(&ratios))
            .map(|((block, widget), ratio)| MinimapEntry { block, widget, ratio })
            .collect()
    }
}

impl BlockEditorState {
    /// The rail's entries, derived once per document revision.
    pub fn minimap_entries(&self) -> Rc<Vec<MinimapEntry>> {
        let revision = self.model.revision();
        let mut cache = self.notefig.minimap_cache.borrow_mut();
        if let Some((rev, entries)) = cache.as_ref()
            && *rev == revision
        {
            return entries.clone();
        }
        let entries = Rc::new(self.model.minimap_entries());
        *cache = Some((revision, entries.clone()));
        entries
    }
}

/// The rail: a short vertical line with one dot per widget, pinned to the
/// top right of its (relatively positioned) parent. Place it over the
/// editor's scroll viewport, not inside the scrolled content. Hidden when
/// the document has no widgets. A dot's click reveals its widget
/// (`reveal_block`), then runs the jump hook.
#[derive(IntoElement)]
pub struct MinimapRail {
    editor: Entity<BlockEditorState>,
    source: MinimapSource,
    jump: Option<MinimapJump>,
}

impl MinimapRail {
    pub fn new(editor: &Entity<BlockEditorState>, source: MinimapSource) -> Self {
        Self {
            editor: editor.clone(),
            source,
            jump: None,
        }
    }

    pub fn on_jump(mut self, jump: MinimapJump) -> Self {
        self.jump = Some(jump);
        self
    }
}

/// `a` over `b` at `t` (CSS `color-mix(in oklab, a t, b)`, approximated).
fn mix(a: Hsla, b: Hsla, t: f32) -> Hsla {
    b.blend(a.opacity(t))
}

impl RenderOnce for MinimapRail {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let entries = self.editor.read(cx).minimap_entries();
        if entries.is_empty() {
            return div().into_any_element();
        }
        let colors = gpui_kit::base::Theme::global(cx).tokens.colors;
        let line = mix(colors.muted_foreground, colors.background, 0.5);
        let full = mix(colors.muted_foreground, colors.background, 0.85);
        let error_wave = mix(colors.destructive, colors.background, 0.55);
        let neutral_wave = colors.foreground.opacity(0.7);
        // The TS rail draws its dots in CSS px at a 16px root.
        let s = window.rem_size().as_f32() / 16.;
        let height = rems(7.).to_pixels(window.rem_size());
        let dots = entries.iter().enumerate().map(|(ix, entry)| {
            let dot = (self.source)(&entry.widget, cx);
            let state = dot.state.clone();
            let bump = match state.core {
                MinimapDotCore::Fresh | MinimapDotCore::Error => full,
                _ => line,
            };
            let hit = 16. * s;
            let r = 4. * s;
            let label = state.label.clone();
            let title: SharedString = dot_title(&dot.title).into();
            let editor = self.editor.clone();
            let jump = self.jump.clone();
            let widget = entry.widget.clone();
            let block = entry.block;
            let circle = |d: f32, color: Hsla| {
                div()
                    .absolute()
                    .left(px((hit - d) / 2.))
                    .top(px((hit - d) / 2.))
                    .size(px(d))
                    .rounded_full()
                    .bg(color)
            };
            let breathe = state.breathe;
            let bump_el = if breathe {
                circle(2. * r, bump)
                    .with_animation(
                        ("minimap-breathe", ix),
                        Animation::new(Duration::from_millis(2400))
                            .repeat()
                            .with_easing(gpui::ease_in_out),
                        move |el, t| {
                            let k = 1. - (2. * t - 1.).abs();
                            let d = 2. * r * (1. + 0.35 * k);
                            el.left(px((hit - d) / 2.)).top(px((hit - d) / 2.)).size(px(d))
                        },
                    )
                    .into_any_element()
            } else {
                circle(2. * r, bump).into_any_element()
            };
            let mut button = div()
                .id(("minimap-dot", ix))
                .absolute()
                .left(px((12. * s - hit) / 2.))
                .top(height * entry.ratio - px(hit / 2.))
                .size(px(hit))
                .cursor_pointer()
                .child(bump_el);
            if state.ping {
                let wave = if state.core == MinimapDotCore::Error {
                    error_wave
                } else {
                    neutral_wave
                };
                button = button.child(
                    circle(3. * s, wave).with_animation(
                        ("minimap-wave", ix),
                        Animation::new(Duration::from_millis(1800)).repeat(),
                        move |el, t| {
                            let (d, a) = if t < 0.18 {
                                (3. + 2. * t / 0.18, 0.85)
                            } else if t < 0.6 {
                                let k = (t - 0.18) / 0.42;
                                (5. + 11. * k, 0.85 * (1. - k))
                            } else {
                                (16., 0.)
                            };
                            let d = d * s;
                            el.left(px((hit - d) / 2.))
                                .top(px((hit - d) / 2.))
                                .size(px(d))
                                .opacity(a)
                        },
                    ),
                );
            }
            if state.hollow {
                let punch = circle(3.5 * s, colors.background);
                button = button.child(if state.pulse {
                    punch
                        .with_animation(
                            ("minimap-punch", ix),
                            Animation::new(Duration::from_millis(2000))
                                .repeat()
                                .with_easing(gpui::ease_in_out),
                            move |el, t| {
                                let k = 1. - (2. * t - 1.).abs();
                                let d = (3.5 - 1.5 * k) * s;
                                el.left(px((hit - d) / 2.)).top(px((hit - d) / 2.)).size(px(d))
                            },
                        )
                        .into_any_element()
                } else {
                    punch.into_any_element()
                });
            }
            button
                .tooltip(move |_, cx| {
                    let (label, title) = (label.clone(), title.clone());
                    cx.new(|_| RailTip { label, title }).into()
                })
                .on_mouse_down(gpui::MouseButton::Left, move |_, window, cx| {
                    cx.stop_propagation();
                    editor.update(cx, |e, cx| e.reveal_block(block, cx));
                    if let Some(jump) = &jump {
                        jump(&editor, block, &widget, window, cx);
                    }
                })
        });
        div()
            .id("notefig-minimap")
            .absolute()
            .right(rems(0.5))
            .top(rems(1.5))
            .w(px(12. * s))
            .h(height)
            .child(
                div()
                    .absolute()
                    .left(px(6. * s - s))
                    .top_0()
                    .w(px(2. * s))
                    .h_full()
                    .bg(line),
            )
            .children(dots)
            .into_any_element()
    }
}

struct RailTip {
    label: Option<SharedString>,
    title: SharedString,
}

impl Render for RailTip {
    fn render(&mut self, _: &mut Window, cx: &mut gpui::Context<Self>) -> impl IntoElement {
        let colors = gpui_kit::base::Theme::global(cx).tokens.colors;
        div()
            .max_w(rems(14.))
            .px(rems(0.375))
            .py(rems(0.125))
            .rounded(px(4.))
            .border_1()
            .border_color(colors.border)
            .bg(colors.background)
            .text_size(rems(0.625))
            .line_height(rems(0.8))
            .when_some(self.label.clone(), |this, label| {
                this.child(
                    div()
                        .truncate()
                        .font_weight(gpui::FontWeight::MEDIUM)
                        .text_color(colors.foreground)
                        .child(label),
                )
            })
            .child(div().truncate().text_color(colors.muted_foreground).child(self.title.clone()))
    }
}
