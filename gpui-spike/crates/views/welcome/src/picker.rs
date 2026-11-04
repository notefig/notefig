//! `directory-picker.tsx`: an "Open Folder" button over the platform's
//! picker, with the current folder's name beside it.

use std::rc::Rc;

use gpui::{App, IntoElement, ParentElement, RenderOnce, SharedString, Styled, Window, div};
use notefig_platform::PlatformService;
use notefig_ui::{CoreExt as _, IconButton, icon, sp, tokens};

type OnSelect = Rc<dyn Fn(&str, &mut App)>;

#[derive(IntoElement)]
pub struct DirectoryPicker {
    current: Option<String>,
    on_select: OnSelect,
}

impl DirectoryPicker {
    pub fn new(on_select: impl Fn(&str, &mut App) + 'static) -> Self {
        Self { current: None, on_select: Rc::new(on_select) }
    }

    pub fn current_directory(mut self, path: Option<String>) -> Self {
        self.current = path;
        self
    }
}

impl RenderOnce for DirectoryPicker {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = tokens(cx).clone();
        let on_select = self.on_select.clone();
        let button = IconButton::with_content(
            "pick-directory",
            div()
                .flex()
                .items_center()
                .gap(sp(2.))
                .px(sp(3.))
                .text_size(t.text_xs)
                .text_color(t.foreground)
                .child(icon("folder").size(sp(4.)).text_color(t.foreground))
                .child("Open Folder")
                .into_any_element(),
        )
        .size(sp(28.), sp(8.))
        .on_click(move |_, _, cx| {
            let pick = cx.core().service::<PlatformService>().ui.pick_directory("Pick a directory");
            let on_select = on_select.clone();
            cx.spawn(async move |cx| {
                if let Some(path) = pick.await {
                    let _ = cx.update(|cx| on_select(&path, cx));
                }
            })
            .detach();
        });
        let name: Option<SharedString> =
            self.current.as_deref().map(|p| p.rsplit(['/', '\\']).find(|s| !s.is_empty()).unwrap_or(p).to_string().into());
        div()
            .flex()
            .items_center()
            .gap(sp(2.))
            .p(sp(2.))
            .border_b_1()
            .border_color(t.border)
            .child(button)
            .children(name.map(|n| {
                div()
                    .flex()
                    .flex_1()
                    .min_w_0()
                    .items_center()
                    .gap(sp(1.))
                    .child(icon("folder").size(sp(3.)).text_color(t.muted_foreground))
                    .child(div().truncate().text_size(t.text_xs).text_color(t.muted_foreground).child(n))
            }))
    }
}
