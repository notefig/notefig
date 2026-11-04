//! Probe: does a gpui-kit `Popover`'s content take pointer and keyboard
//! input in a window opened like the app's (`gpui_kit::open_window`)?
//! Run headless with NOTEFIG_SCRIPT; it prints what reached the content.

use gpui::{AppContext as _, Context, Entity, IntoElement, ParentElement, Render, Styled, Window, WindowOptions, div, px};
use gpui_kit::component::button::Button;
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::component::popover::Popover;

struct Probe {
    input: Entity<InputState>,
}

impl Render for Probe {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let input = self.input.clone();
        div().size_full().p(px(40.)).child(
            Popover::new("probe")
                .trigger(Button::new("open").label("Open"))
                .content(move |_, _, _| {
                    div()
                        .w(px(240.))
                        .child(Button::new("inside").label("Inside").on_click(|_, _, _| eprintln!("PROBE: inside clicked")))
                        .child(Input::new(&input))
                        .into_any_element()
                }),
        )
    }
}

fn main() {
    gpui_kit::application().with_assets(notefig_ui::NotefigAssets).run(|cx| {
        notefig_ui::init(cx);
        let options = WindowOptions { show: std::env::var_os("NOTEFIG_HEADLESS").is_none(), ..Default::default() };
        let (window, _) = gpui_kit::open_window(options, cx, |window, cx| {
            let input = cx.new(|cx| InputState::new(window, cx));
            cx.subscribe(&input, |state, _: &gpui_kit::component::input::InputEvent, cx| {
                eprintln!("PROBE: input now {:?}", state.read(cx).value());
            })
            .detach();
            cx.new(|_| Probe { input })
        })
        .unwrap();
        notefig_ui::driver::run_from_env(window, cx);
    });
}
