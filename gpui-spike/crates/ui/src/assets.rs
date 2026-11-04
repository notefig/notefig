//! The app's asset source: Notefig's own files under `notefig/` (the logo),
//! then the whole Lucide catalog under `icons/<name>.svg` (gpui-kit's
//! `AllAssets`, which the TS app's `lucide-react` matches name for name).

use std::borrow::Cow;

use gpui::{AssetSource, SharedString};
use gpui_kit::assets::AllAssets;

pub struct NotefigAssets;

const OWN: &[(&str, &[u8])] = &[
    ("notefig/logo.svg", include_bytes!("../assets/logo.svg")),
    ("notefig/logo-light.svg", include_bytes!("../assets/logo-light.svg")),
    ("notefig/logo-dark.svg", include_bytes!("../assets/logo-dark.svg")),
];

impl AssetSource for NotefigAssets {
    fn load(&self, path: &str) -> gpui::Result<Option<Cow<'static, [u8]>>> {
        if let Some((_, bytes)) = OWN.iter().find(|(p, _)| *p == path) {
            return Ok(Some(Cow::Borrowed(bytes)));
        }
        AllAssets.load(path)
    }

    fn list(&self, path: &str) -> gpui::Result<Vec<SharedString>> {
        let mut out: Vec<SharedString> = OWN
            .iter()
            .filter(|(p, _)| p.starts_with(path))
            .map(|(p, _)| SharedString::from(*p))
            .collect();
        out.extend(AllAssets.list(path)?);
        Ok(out)
    }
}
