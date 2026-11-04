//! Task status glyphs (`status-glyph.tsx`): sign-in outranks status;
//! settled = hairline ring, asking = filled dot, moving = pulsing orb.

use std::time::Duration;

use gpui::{
    Animation, AnimationExt as _, App, IntoElement, SharedString, Styled, div,
    px,
};
use gpui_kit::component::ActiveTheme as _;
use notefig_agent::{AgentTaskRow, TaskStatus};

use crate::theme::BrandColors;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Glyph {
    SignIn,
    Asking,
    Moving,
    Settled,
    Error,
    Unavailable,
}

pub fn glyph_for(row: &AgentTaskRow, pending_permission: bool) -> Glyph {
    if row.auth_required {
        return Glyph::SignIn;
    }
    if pending_permission {
        return Glyph::Asking;
    }
    match row.status {
        TaskStatus::Starting | TaskStatus::Running => Glyph::Moving,
        TaskStatus::Error => Glyph::Error,
        TaskStatus::Unavailable => Glyph::Unavailable,
        TaskStatus::Idle | TaskStatus::Cancelled | TaskStatus::Restored => Glyph::Settled,
    }
}

pub fn label(glyph: Glyph) -> &'static str {
    match glyph {
        Glyph::SignIn => "Sign-in needed",
        Glyph::Asking => "Waiting for you",
        Glyph::Moving => "Working",
        Glyph::Settled => "Idle",
        Glyph::Error => "Error",
        Glyph::Unavailable => "Unavailable",
    }
}

pub fn render(glyph: Glyph, id: impl Into<SharedString>, cx: &App) -> impl IntoElement {
    let theme = cx.theme();
    let brand = BrandColors::get(cx);
    let size = px(8.);
    let base = div().size(size).flex_none().rounded_full();
    match glyph {
        Glyph::Settled => base.border_1().border_color(theme.muted_foreground).into_any_element(),
        Glyph::Asking => base.bg(brand.brand).into_any_element(),
        Glyph::SignIn => base.border_2().border_color(brand.warning).into_any_element(),
        Glyph::Error => base.bg(brand.warning).into_any_element(),
        Glyph::Unavailable => base.bg(theme.muted_foreground.opacity(0.4)).into_any_element(),
        Glyph::Moving => {
            let id: SharedString = id.into();
            base.bg(brand.brand)
                .with_animation(
                    gpui::ElementId::Name(id),
                    Animation::new(Duration::from_millis(1200)).repeat(),
                    |el, t| el.opacity(0.35 + 0.65 * (1.0 - (t * 2.0 - 1.0).abs())),
                )
                .into_any_element()
        }
    }
}
