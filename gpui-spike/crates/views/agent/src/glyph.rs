//! `status-glyph.tsx` and `harness-logo.tsx`: the one vocabulary for "what
//! state is this agent thing in" (a hairline ring for anything settled, a
//! filled dot for anything asking, the thin thinking orb for anything
//! moving), and a harness's brand mark.

use std::sync::Arc;
use std::time::Duration;

use gpui::{
    Animation, AnimationExt as _, AnyElement, App, Bounds, ElementId, Hsla, Image, ImageFormat,
    IntoElement, ParentElement, Pixels, Styled, canvas, div, img, point, size,
};
use notefig_agent::model::{AgentTaskRow, TaskStatus, TurnStatus};
use notefig_ui::{icon, sp, tokens};

/// `StatusGlyphState` (= the platform's `StatusMark`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum StatusGlyphState {
    Starting,
    Running,
    Queued,
    Idle,
    Done,
    Cancelled,
    Error,
    Unavailable,
    Auth,
    AttentionBau,
    AttentionError,
}

impl StatusGlyphState {
    /// The TS string (`data-status-glyph`).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Running => "running",
            Self::Queued => "queued",
            Self::Idle => "idle",
            Self::Done => "done",
            Self::Cancelled => "cancelled",
            Self::Error => "error",
            Self::Unavailable => "unavailable",
            Self::Auth => "auth",
            Self::AttentionBau => "attention-bau",
            Self::AttentionError => "attention-error",
        }
    }
}

/// What `utils/attention.ts` points the user at.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum AttentionKind {
    /// A turn finished.
    Bau,
    /// A failure, or a question the run is blocked on.
    Error,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Shape {
    /// The thinking orb; `connecting` while the harness spawns.
    Orb { connecting: bool },
    Ring,
    Dot,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Tone {
    Muted,
    Foreground,
    Warning,
    /// `text-muted-foreground/70`.
    MutedSoft,
    Success,
}

/// `GLYPHS`.
fn spec(state: StatusGlyphState) -> (Shape, Tone) {
    use StatusGlyphState::*;
    match state {
        Starting => (Shape::Orb { connecting: true }, Tone::Muted),
        Running => (Shape::Orb { connecting: false }, Tone::Foreground),
        Queued => (Shape::Ring, Tone::Warning),
        Idle | Done | Cancelled => (Shape::Ring, Tone::MutedSoft),
        Error | Unavailable | Auth | AttentionError => (Shape::Dot, Tone::Warning),
        AttentionBau => (Shape::Dot, Tone::Success),
    }
}

fn tone_color(tone: Tone, cx: &App) -> Hsla {
    let t = tokens(cx);
    match tone {
        Tone::Muted => t.muted_foreground,
        Tone::Foreground => t.foreground,
        Tone::Warning => t.warning,
        Tone::MutedSoft => t.muted_foreground.opacity(0.7),
        Tone::Success => t.success,
    }
}

/// `taskGlyphState`: sign-in blocks everything else, then the status (a
/// restored session is idle-equivalent).
pub fn task_glyph_state(task: &AgentTaskRow) -> StatusGlyphState {
    if task.auth_required {
        return StatusGlyphState::Auth;
    }
    match task.status {
        TaskStatus::Starting => StatusGlyphState::Starting,
        TaskStatus::Running => StatusGlyphState::Running,
        TaskStatus::Idle | TaskStatus::Restored => StatusGlyphState::Idle,
        TaskStatus::Cancelled => StatusGlyphState::Cancelled,
        TaskStatus::Error => StatusGlyphState::Error,
        TaskStatus::Unavailable => StatusGlyphState::Unavailable,
    }
}

/// `turnGlyphState`.
pub fn turn_glyph_state(status: TurnStatus) -> StatusGlyphState {
    match status {
        TurnStatus::Running => StatusGlyphState::Running,
        TurnStatus::Queued => StatusGlyphState::Queued,
        TurnStatus::Completed => StatusGlyphState::Done,
        TurnStatus::Cancelled => StatusGlyphState::Cancelled,
        TurnStatus::Error => StatusGlyphState::Error,
    }
}

/// `attentionGlyphState`.
pub fn attention_glyph_state(kind: AttentionKind) -> StatusGlyphState {
    match kind {
        AttentionKind::Bau => StatusGlyphState::AttentionBau,
        AttentionKind::Error => StatusGlyphState::AttentionError,
    }
}

/// `<StatusGlyph state>`: a `size-1.5` ring or dot, or the `size-3` orb.
pub fn status_glyph(state: StatusGlyphState, id: impl Into<ElementId>, cx: &App) -> AnyElement {
    let (shape, tone) = spec(state);
    let color = tone_color(tone, cx);
    match shape {
        Shape::Ring => div()
            .flex_none()
            .size(sp(1.5))
            .rounded_full()
            .border_1()
            .border_color(color)
            .into_any_element(),
        Shape::Dot => div().flex_none().size(sp(1.5)).rounded_full().bg(color).into_any_element(),
        Shape::Orb { connecting } => orb(id.into(), sp(3.), color, connecting).into_any_element(),
    }
}

/// The thinking orb (`OrbLoader`): a dotted sphere, rotating, its dots
/// shaded by depth, in the text colour. `connecting` turns slower and
/// breathes.
pub fn orb(id: ElementId, diameter: Pixels, color: Hsla, connecting: bool) -> impl IntoElement {
    let period = if connecting { 2600 } else { 1600 };
    div()
        .flex_none()
        .size(diameter)
        .with_animation(id, Animation::new(Duration::from_millis(period)).repeat(), move |el, t| {
            el.child(
                canvas(|_, _, _| (), move |bounds, _, window, _| paint_orb(bounds, t, color, connecting, window))
                    .size_full(),
            )
        })
}

/// The orb's dots at phase `t` (0..1): a Fibonacci sphere turned about a
/// tilted axis, projected orthographically. `(x, y, depth 0..1)` in a unit
/// square.
pub(crate) fn orb_dots(t: f32, connecting: bool) -> Vec<(f32, f32, f32)> {
    const N: usize = 14;
    let golden = std::f32::consts::PI * (3. - 5f32.sqrt());
    let angle = t * std::f32::consts::TAU;
    let tilt = 0.45f32;
    let breathe = if connecting { 0.82 + 0.12 * (angle * 2.).sin() } else { 1. };
    (0..N)
        .map(|i| {
            let y = 1. - (i as f32 + 0.5) / N as f32 * 2.;
            let r = (1. - y * y).sqrt();
            let theta = golden * i as f32 + angle;
            let (x, z) = (r * theta.cos(), r * theta.sin());
            // Tilt about the x axis.
            let (y2, z2) = (y * tilt.cos() - z * tilt.sin(), y * tilt.sin() + z * tilt.cos());
            (0.5 + 0.42 * x * breathe, 0.5 + 0.42 * y2 * breathe, (z2 + 1.) / 2.)
        })
        .collect()
}

fn paint_orb(bounds: Bounds<Pixels>, t: f32, color: Hsla, connecting: bool, window: &mut gpui::Window) {
    let mut dots = orb_dots(t, connecting);
    dots.sort_by(|a, b| a.2.total_cmp(&b.2));
    let side = bounds.size.width.min(bounds.size.height);
    for (x, y, depth) in dots {
        let radius = side * (0.045 + 0.05 * depth);
        let center = point(bounds.origin.x + side * x, bounds.origin.y + side * y);
        let dot = Bounds::new(point(center.x - radius, center.y - radius), size(radius * 2., radius * 2.));
        window.paint_quad(gpui::fill(dot, color.opacity(0.25 + 0.75 * depth)).corner_radii(radius));
    }
}

/// `<HarnessLogo>`: the adapter's mark in the surrounding text colour, or
/// the generic bot for a harness without one. `size-3.5` by default.
pub fn harness_logo(harness_id: &str, size_px: Pixels, color: Hsla) -> AnyElement {
    match notefig_harness_adapters::harness_logo(harness_id) {
        Some(mark) => {
            let svg = logo_svg(&mark, color);
            img(Arc::new(Image::from_bytes(ImageFormat::Svg, svg.into_bytes())))
                .flex_none()
                .size(size_px)
                .into_any_element()
        }
        None => icon("bot").size(size_px).text_color(color).into_any_element(),
    }
}

/// The mark as an SVG document filled with `color` (GPUI has no
/// `currentColor` for an image).
pub(crate) fn logo_svg(mark: &notefig_harness_adapters::HarnessMark, color: Hsla) -> String {
    let rgba = gpui::Rgba::from(color);
    let hex = format!(
        "#{:02x}{:02x}{:02x}",
        (rgba.r * 255.).round() as u8,
        (rgba.g * 255.).round() as u8,
        (rgba.b * 255.).round() as u8
    );
    let rule = if mark.fill_rule_evenodd { " fill-rule=\"evenodd\"" } else { "" };
    let mut out = format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"{}\" fill=\"{hex}\" fill-opacity=\"{}\"{rule}>",
        mark.view_box, rgba.a
    );
    for (d, opacity) in mark.paths {
        match opacity {
            Some(o) => out.push_str(&format!("<path d=\"{d}\" opacity=\"{o}\"/>")),
            None => out.push_str(&format!("<path d=\"{d}\"/>")),
        }
    }
    out.push_str("</svg>");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(status: TaskStatus, auth: bool) -> AgentTaskRow {
        serde_json::from_value(serde_json::json!({
            "taskId": "task_1", "workspacePath": "/ws", "title": "t", "status": status,
            "harnessId": "claude-code", "createdAt": 0, "updatedAt": 0, "authRequired": auth,
        }))
        .unwrap()
    }

    #[test]
    fn sign_in_outranks_status() {
        assert_eq!(task_glyph_state(&row(TaskStatus::Running, true)), StatusGlyphState::Auth);
        assert_eq!(task_glyph_state(&row(TaskStatus::Running, false)), StatusGlyphState::Running);
    }

    #[test]
    fn restored_reads_as_idle() {
        assert_eq!(task_glyph_state(&row(TaskStatus::Restored, false)), StatusGlyphState::Idle);
        assert_eq!(task_glyph_state(&row(TaskStatus::Unavailable, false)), StatusGlyphState::Unavailable);
    }

    #[test]
    fn turn_and_attention_states() {
        assert_eq!(turn_glyph_state(TurnStatus::Completed), StatusGlyphState::Done);
        assert_eq!(turn_glyph_state(TurnStatus::Queued), StatusGlyphState::Queued);
        assert_eq!(attention_glyph_state(AttentionKind::Bau).as_str(), "attention-bau");
        assert_eq!(attention_glyph_state(AttentionKind::Error).as_str(), "attention-error");
    }

    #[test]
    fn shapes_follow_the_vocabulary() {
        assert_eq!(spec(StatusGlyphState::Queued), (Shape::Ring, Tone::Warning));
        assert_eq!(spec(StatusGlyphState::Error).0, Shape::Dot);
        assert_eq!(spec(StatusGlyphState::Starting).0, Shape::Orb { connecting: true });
    }

    #[test]
    fn orb_dots_stay_inside_their_box() {
        for t in [0., 0.25, 0.5, 0.9] {
            for (x, y, d) in orb_dots(t, true) {
                assert!((0. ..=1.).contains(&x) && (0. ..=1.).contains(&y) && (0. ..=1.).contains(&d));
            }
        }
    }

    #[test]
    fn logo_svg_carries_the_paths() {
        let mark = notefig_harness_adapters::harness_logo("claude-code").expect("claude has a mark");
        let svg = logo_svg(&mark, gpui::hsla(0., 0., 1., 1.));
        assert!(svg.starts_with("<svg") && svg.contains("fill=\"#ffffff\"") && svg.contains("<path"));
    }
}
