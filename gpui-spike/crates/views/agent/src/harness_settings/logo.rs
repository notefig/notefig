//! `components/agent/harness-logo.tsx`: a harness's brand mark, drawn from
//! its adapter's `logo` (`notefig_harness_adapters::harness_logo`); a
//! harness without one (a user-configured one) gets Lucide's `bot`.
//!
//! Deviation: TS draws the mark as inline `<svg>` path data filled with
//! `currentColor`. GPUI's `svg()` only loads from the asset source (owned by
//! `notefig-ui`), so the mark is serialised to an SVG document with the
//! colour baked in and drawn with `img()`; documents are cached per
//! (harness, colour).

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;

use gpui::{AnyElement, Hsla, Image, ImageFormat, IntoElement, Pixels, Rgba, Styled, img};
use notefig_harness_adapters::harness_logo;

thread_local! {
    static CACHE: RefCell<HashMap<(String, u32), Arc<Image>>> = RefCell::default();
}

fn hex(color: Hsla) -> (String, f32) {
    let c = Rgba::from(color);
    let to = |v: f32| (v.clamp(0., 1.) * 255.).round() as u8;
    (format!("#{:02x}{:02x}{:02x}", to(c.r), to(c.g), to(c.b)), c.a)
}

/// The SVG document for a harness mark in `color`, if the harness has one.
pub fn logo_svg(harness_id: &str, color: Hsla) -> Option<String> {
    let mark = harness_logo(harness_id)?;
    let (fill, alpha) = hex(color);
    let rule = if mark.fill_rule_evenodd { " fill-rule=\"evenodd\"" } else { "" };
    let paths: String = mark
        .paths
        .iter()
        .map(|(d, opacity)| match opacity {
            Some(o) => format!("<path d=\"{d}\" opacity=\"{o}\"/>"),
            None => format!("<path d=\"{d}\"/>"),
        })
        .collect();
    Some(format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"{}\" fill=\"{fill}\" fill-opacity=\"{alpha}\"{rule}>{paths}</svg>",
        mark.view_box
    ))
}

/// `<HarnessLogo harnessId className="size-…">` in `color` (the text colour
/// it would inherit in TS).
pub fn harness_logo_element(harness_id: &str, size: Pixels, color: Hsla) -> AnyElement {
    let key = (harness_id.to_string(), u32::from(Rgba::from(color)));
    let image = CACHE.with(|cache| {
        if let Some(image) = cache.borrow().get(&key) {
            return Some(image.clone());
        }
        let svg = logo_svg(harness_id, color)?;
        let image = Arc::new(Image::from_bytes(ImageFormat::Svg, svg.into_bytes()));
        cache.borrow_mut().insert(key.clone(), image.clone());
        Some(image)
    });
    match image {
        Some(image) => img(image).size(size).flex_none().into_any_element(),
        None => notefig_ui::icon("bot").size(size).text_color(color).into_any_element(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn built_ins_have_marks_and_custom_ones_fall_back() {
        let white = gpui::hsla(0., 0., 1., 1.);
        for id in ["claude-code", "opencode", "devin", "gemini-cli"] {
            let svg = logo_svg(id, white).unwrap();
            assert!(svg.starts_with("<svg") && svg.contains("<path") && svg.contains("#ffffff"));
        }
        assert!(logo_svg("custom:1", white).is_none());
    }
}
