//! Per-file-type icons (`file-type-icon.tsx`): `@pierre/trees`' standard
//! set, monochrome, resolved by file name then extension, with markdown in
//! the logo colour. The glyphs are the library's own SVGs, rendered as
//! images tinted by baking the colour in (GPUI's `svg()` reads from the
//! app's asset source, which this crate does not own).

use std::collections::HashMap;
use std::sync::Arc;

use gpui::{App, Global, Hsla, Image, ImageFormat, Img, Pixels, Rgba, Styled as _, img};

use crate::icon_table::{BY_EXTENSION, BY_FILE_NAME, ICONS};

/// The icon a file shows: the resolver's token for its name, else its
/// extension (longest first, as `f.mdx.tsx` → `mdx.tsx`), else default.
pub fn icon_name_for(path: &str) -> &'static str {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path).to_lowercase();
    if let Some((_, icon)) = BY_FILE_NAME.iter().find(|(n, _)| *n == name) {
        return icon;
    }
    let mut rest = name.as_str();
    while let Some((_, ext)) = rest.split_once('.') {
        if let Some((_, icon)) = BY_EXTENSION.iter().find(|(e, _)| *e == ext) {
            return icon;
        }
        rest = ext;
    }
    "file-tree-builtin-default"
}

pub fn is_markdown_icon(name: &str) -> bool {
    name == "file-tree-builtin-markdown"
}

#[derive(Default)]
struct IconCache(HashMap<(String, u32, bool), Arc<Image>>);
impl Global for IconCache {}

fn hex(c: Hsla) -> (String, u32) {
    let rgba: Rgba = c.into();
    let v = ((rgba.r * 255.).round() as u32) << 16 | ((rgba.g * 255.).round() as u32) << 8 | (rgba.b * 255.).round() as u32;
    (format!("#{v:06x}"), v)
}

/// The named glyph in `color`; `rotate_right_angle` turns it -90° (a
/// collapsed chevron).
pub fn glyph(name: &str, color: Hsla, rotated: bool, cx: &mut App) -> Arc<Image> {
    let (hex_str, key) = hex(color);
    let cache = cx.default_global::<IconCache>();
    if let Some(image) = cache.0.get(&(name.to_string(), key, rotated)) {
        return image.clone();
    }
    let svg = ICONS
        .iter()
        .find(|(n, _)| *n == name)
        .or_else(|| ICONS.iter().find(|(n, _)| *n == "file-tree-builtin-default"))
        .map(|(_, b)| String::from_utf8_lossy(b).into_owned())
        .unwrap_or_default();
    let mut svg = svg.replace("currentColor", &hex_str).replace("currentcolor", &hex_str);
    if rotated && let (Some(open), Some(close)) = (svg.find('>'), svg.rfind("</svg>")) {
        svg = format!("{}<g transform=\"rotate(-90 8 8)\">{}</g></svg>", &svg[..=open], &svg[open + 1..close]);
    }
    let image = Arc::new(Image::from_bytes(ImageFormat::Svg, svg.into_bytes()));
    cache.0.insert((name.to_string(), key, rotated), image.clone());
    image
}

/// `<FileTypeIcon path=…>`: the file's glyph, markdown in the logo colour,
/// others in `color`.
pub fn file_type_icon(path: &str, size: Pixels, color: Hsla, cx: &mut App) -> Img {
    let name = icon_name_for(path);
    let color = if is_markdown_icon(name) { notefig_ui::tokens(cx).logo } else { color };
    img(glyph(name, color, false, cx)).size(size).flex_none()
}

/// The scratchpads row's mark: the `#` glyph over a 20% tinted square, in
/// the orange the coloured set gives html (`tree-model.ts`'s unsafe CSS).
pub fn scratchpads_mark(size: Pixels, dark: bool, cx: &mut App) -> Img {
    let color: Hsla = gpui::rgb(if dark { 0xffa359 } else { 0xd47628 }).into();
    let cache_key = if dark { "scratchpads-dark" } else { "scratchpads-light" };
    let (hex_str, key) = hex(color);
    let cache = cx.default_global::<IconCache>();
    let image = cache
        .0
        .entry((cache_key.to_string(), key, false))
        .or_insert_with(|| {
            let svg = format!(
                r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="{hex_str}" d="M8 1C2.24 1 1 2.24 1 8s1.24 7 7 7 7-1.24 7-7-1.24-7-7-7" opacity=".2"/><path fill="{hex_str}" d="M10.48 3.76a.5.5 0 0 1 .4.58L10.6 5.8h1.14a.5.5 0 0 1 0 1h-1.32L10 9.2h1.08a.5.5 0 0 1 0 1H9.8l-.3 1.64a.5.5 0 1 1-.98-.18l.27-1.46H6.4l-.3 1.64a.5.5 0 1 1-.98-.18l.27-1.46H4.25a.5.5 0 0 1 0-1h1.32L6 6.8H4.93a.5.5 0 0 1 0-1H6.2l.3-1.64a.5.5 0 1 1 .98.18L7.2 5.8h2.4l.3-1.64a.5.5 0 0 1 .58-.4M6.58 9.2h2.4l.44-2.4h-2.4z"/></svg>"#
            );
            Arc::new(Image::from_bytes(ImageFormat::Svg, svg.into_bytes()))
        })
        .clone();
    img(image).size(size).flex_none()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_like_the_ts_resolver() {
        assert_eq!(icon_name_for("/ws/README.md"), "file-tree-builtin-markdown");
        assert_eq!(icon_name_for("a.tsx"), "file-tree-builtin-typescript");
        assert_eq!(icon_name_for("Makefile"), "file-tree-builtin-default");
        assert_eq!(icon_name_for("x/.gitignore"), "file-tree-builtin-git");
        assert_eq!(icon_name_for("photo.PNG"), "file-tree-builtin-image");
    }
}
