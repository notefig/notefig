//! The scripted driver: `NOTEFIG_SCRIPT` (steps separated by `;` or new
//! lines) or `NOTEFIG_SCRIPT_FILE`, run against the main window after it
//! opens. Coordinates are logical pixels (a 2x screenshot's pixels / 2).
//!
//! | step | does |
//! |---|---|
//! | `wait:<ms>` | sleep |
//! | `key:<keystroke>` | e.g. `key:cmd-shift-p`, `key:escape`, `key:enter` |
//! | `type:<text>` | one keystroke per character |
//! | `action:<name>` | dispatch a registered action, e.g. `action:workspace::NewScratchpad` |
//! | `action:<name>:<json>` | with data |
//! | `click:<x>,<y>` / `dblclick:` / `rclick:` | mouse at a point; append `,cmd` / `,shift` / `,alt` / `,ctrl` for modifiers |
//! | `drag:<x1>,<y1>,<x2>,<y2>` | press at the first point, move to the second in steps, release |
//! | `drag:<x1>,<y1>,<x2>,<y2>,hold` | the same without the release, so a `shot:` sees the drag in flight |
//! | `release:<x>,<y>` | let go of a held drag there |
//! | `move:<x>,<y>` | hover |
//! | `scroll:<x>,<y>,<dy>` | wheel |
//! | `resize:<w>,<h>` | the window's content size |
//! | `shot:<path.png>` | render the window to a PNG (needs `--features screenshot`) |
//! | `quit` | quit the app |
//!
//! Each step is followed by a short settle so the frame redraws.

use std::time::Duration;

use gpui::{
    AnyWindowHandle, AsyncApp, Keystroke, Modifiers, MouseButton, MouseDownEvent, MouseMoveEvent,
    MouseUpEvent, PlatformInput, ScrollDelta, ScrollWheelEvent, TouchPhase, point, px,
};

#[derive(Debug, Clone, PartialEq)]
pub enum Step {
    Wait(u64),
    Key(String),
    Type(String),
    Action(String, Option<serde_json::Value>),
    Click { x: f32, y: f32, count: usize, button: MouseButton, modifiers: Modifiers },
    Drag(f32, f32, f32, f32),
    /// A drag left pressed at its end point.
    DragHold(f32, f32, f32, f32),
    Release(f32, f32),
    Move(f32, f32),
    Scroll(f32, f32, f32),
    Resize(f32, f32),
    Shot(String),
    Quit,
}

pub fn parse(script: &str) -> anyhow::Result<Vec<Step>> {
    let mut steps = Vec::new();
    for raw in script.split(['\n', ';']) {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (op, arg) = line.split_once(':').unwrap_or((line, ""));
        let nums = |s: &str| -> anyhow::Result<Vec<f32>> {
            s.split(',').map(|n| n.trim().parse::<f32>().map_err(Into::into)).collect()
        };
        let step = match op {
            "wait" => Step::Wait(arg.trim().parse()?),
            "key" => Step::Key(arg.trim().to_string()),
            "type" => Step::Type(arg.to_string()),
            // `name::Path` contains colons; data starts at the first `:{`, `:[` or `:"`.
            "action" => match [":{", ":[", ":\""].iter().filter_map(|m| arg.find(m)).min() {
                Some(i) => Step::Action(arg[..i].trim().to_string(), Some(serde_json::from_str(&arg[i + 1..])?)),
                None => Step::Action(arg.trim().to_string(), None),
            },
            "click" | "dblclick" | "rclick" => {
                let parts: Vec<&str> = arg.split(',').map(str::trim).collect();
                anyhow::ensure!(parts.len() >= 2, "{op} needs x,y");
                let n = nums(&parts[..2].join(","))?;
                let mut modifiers = Modifiers::default();
                for m in &parts[2..] {
                    match *m {
                        "cmd" => modifiers.platform = true,
                        "shift" => modifiers.shift = true,
                        "alt" => modifiers.alt = true,
                        "ctrl" => modifiers.control = true,
                        other => anyhow::bail!("unknown modifier `{other}`"),
                    }
                }
                Step::Click {
                    x: n[0],
                    y: n[1],
                    count: if op == "dblclick" { 2 } else { 1 },
                    button: if op == "rclick" { MouseButton::Right } else { MouseButton::Left },
                    modifiers,
                }
            }
            "drag" => {
                let (coords, hold) = match arg.trim().strip_suffix(",hold") {
                    Some(c) => (c, true),
                    None => (arg, false),
                };
                let n = nums(coords)?;
                anyhow::ensure!(n.len() == 4, "drag needs x1,y1,x2,y2[,hold]");
                if hold { Step::DragHold(n[0], n[1], n[2], n[3]) } else { Step::Drag(n[0], n[1], n[2], n[3]) }
            }
            "release" => {
                let n = nums(arg)?;
                anyhow::ensure!(n.len() == 2, "release needs x,y");
                Step::Release(n[0], n[1])
            }
            "move" => {
                let n = nums(arg)?;
                Step::Move(n[0], n[1])
            }
            "scroll" => {
                let n = nums(arg)?;
                Step::Scroll(n[0], n[1], n[2])
            }
            "resize" => {
                let n = nums(arg)?;
                Step::Resize(n[0], n[1])
            }
            "shot" => Step::Shot(arg.trim().to_string()),
            "quit" => Step::Quit,
            other => anyhow::bail!("unknown script step `{other}`"),
        };
        steps.push(step);
    }
    Ok(steps)
}

/// The script from the environment, if any.
pub fn from_env() -> Option<anyhow::Result<Vec<Step>>> {
    if let Ok(script) = std::env::var("NOTEFIG_SCRIPT") {
        return Some(parse(&script));
    }
    let path = std::env::var_os("NOTEFIG_SCRIPT_FILE")?;
    Some(std::fs::read_to_string(path).map_err(Into::into).and_then(|s| parse(&s)))
}

/// Run `NOTEFIG_SCRIPT` against `window`, if set. Logs each step to stderr.
pub fn run_from_env(window: AnyWindowHandle, cx: &mut gpui::App) {
    let Some(steps) = from_env() else { return };
    let steps = match steps {
        Ok(steps) => steps,
        Err(err) => {
            eprintln!("notefig: bad NOTEFIG_SCRIPT: {err:#}");
            return;
        }
    };
    cx.spawn(async move |cx| {
        // Let the first frames land.
        cx.background_executor().timer(Duration::from_millis(600)).await;
        for step in steps {
            // A wait is drawn through in frames, so async work that lands
            // during it reaches the screen and later clicks hit real
            // hitboxes even where the OS is not driving frames.
            if let Step::Wait(ms) = step {
                let mut left = ms;
                while left > 0 {
                    let slice = left.min(100);
                    cx.background_executor().timer(Duration::from_millis(slice)).await;
                    left -= slice;
                    redraw(window, cx);
                }
            } else if let Err(err) = run_step(&step, window, cx).await {
                eprintln!("notefig: script step {step:?} failed: {err:#}");
            }
            cx.background_executor().timer(Duration::from_millis(120)).await;
            redraw(window, cx);
        }
    })
    .detach();
}

/// Draw a frame now (screenshot builds only; a normal build leaves frame
/// pacing to the platform).
fn redraw(window: AnyWindowHandle, cx: &mut AsyncApp) {
    #[cfg(feature = "screenshot")]
    let _ = window.update(cx, |_, window, cx| {
        window.refresh();
        let _ = window.draw(cx);
    });
    #[cfg(not(feature = "screenshot"))]
    let _ = (window, cx);
}

fn mouse(window: AnyWindowHandle, cx: &mut AsyncApp, event: PlatformInput) -> anyhow::Result<()> {
    window.update(cx, |_, window, cx| {
        window.dispatch_event(event, cx);
    })
}

async fn run_step(step: &Step, window: AnyWindowHandle, cx: &mut AsyncApp) -> anyhow::Result<()> {
    eprintln!("notefig: script {step:?}");
    match step {
        Step::Wait(ms) => cx.background_executor().timer(Duration::from_millis(*ms)).await,
        Step::Key(k) => {
            let ks = Keystroke::parse(k)?;
            window.update(cx, |_, window, cx| {
                window.dispatch_keystroke(ks, cx);
            })?;
        }
        Step::Type(text) => {
            for ch in text.chars() {
                let ks = match ch {
                    ' ' => Keystroke::parse("space")?,
                    '\n' => Keystroke::parse("enter")?,
                    c => {
                        let mut ks = Keystroke::parse(&c.to_lowercase().to_string())
                            .unwrap_or_else(|_| Keystroke::parse("a").unwrap());
                        ks.key = c.to_lowercase().to_string();
                        ks.modifiers.shift = c.is_uppercase();
                        ks.key_char = Some(c.to_string());
                        ks
                    }
                };
                window.update(cx, |_, window, cx| {
                    window.dispatch_keystroke(ks, cx);
                })?;
            }
        }
        Step::Action(name, data) => {
            window.update(cx, |_, window, cx| -> anyhow::Result<()> {
                let action = cx
                    .build_action(name, data.clone())
                    .map_err(|e| anyhow::anyhow!("{e:?}"))?;
                window.dispatch_action(action, cx);
                Ok(())
            })??;
        }
        Step::Click { x, y, count, button, modifiers } => {
            let position = point(px(*x), px(*y));
            let modifiers = *modifiers;
            mouse(window, cx, PlatformInput::MouseMove(MouseMoveEvent { position, pressed_button: None, modifiers }))?;
            for click in 1..=*count {
                mouse(window, cx, PlatformInput::MouseDown(MouseDownEvent {
                    button: *button,
                    position,
                    modifiers,
                    click_count: click,
                    first_mouse: false,
                }))?;
                mouse(window, cx, PlatformInput::MouseUp(MouseUpEvent {
                    button: *button,
                    position,
                    modifiers,
                    click_count: click,
                }))?;
            }
        }
        Step::Drag(x1, y1, x2, y2) | Step::DragHold(x1, y1, x2, y2) => {
            let from = point(px(*x1), px(*y1));
            let m = Modifiers::default();
            mouse(window, cx, PlatformInput::MouseMove(MouseMoveEvent { position: from, pressed_button: None, modifiers: m }))?;
            mouse(window, cx, PlatformInput::MouseDown(MouseDownEvent { button: MouseButton::Left, position: from, modifiers: m, click_count: 1, first_mouse: false }))?;
            let steps = 12;
            for i in 1..=steps {
                let f = i as f32 / steps as f32;
                let p = point(px(x1 + (x2 - x1) * f), px(y1 + (y2 - y1) * f));
                mouse(window, cx, PlatformInput::MouseMove(MouseMoveEvent { position: p, pressed_button: Some(MouseButton::Left), modifiers: m }))?;
                cx.background_executor().timer(Duration::from_millis(16)).await;
                redraw(window, cx);
            }
            if matches!(step, Step::Drag(..)) {
                let to = point(px(*x2), px(*y2));
                mouse(window, cx, PlatformInput::MouseUp(MouseUpEvent { button: MouseButton::Left, position: to, modifiers: m, click_count: 1 }))?;
            }
        }
        Step::Release(x, y) => {
            let at = point(px(*x), px(*y));
            let m = Modifiers::default();
            mouse(window, cx, PlatformInput::MouseMove(MouseMoveEvent { position: at, pressed_button: Some(MouseButton::Left), modifiers: m }))?;
            mouse(window, cx, PlatformInput::MouseUp(MouseUpEvent { button: MouseButton::Left, position: at, modifiers: m, click_count: 1 }))?;
        }
        Step::Move(x, y) => {
            mouse(window, cx, PlatformInput::MouseMove(MouseMoveEvent {
                position: point(px(*x), px(*y)),
                pressed_button: None,
                modifiers: Modifiers::default(),
            }))?;
        }
        Step::Scroll(x, y, dy) => {
            mouse(window, cx, PlatformInput::ScrollWheel(ScrollWheelEvent {
                position: point(px(*x), px(*y)),
                delta: ScrollDelta::Pixels(point(px(0.), px(*dy))),
                modifiers: Modifiers::default(),
                touch_phase: TouchPhase::Moved,
            }))?;
        }
        Step::Resize(w, h) => {
            window.update(cx, |_, window, _| window.resize(gpui::size(px(*w), px(*h))))?;
        }
        Step::Shot(path) => shot(window, cx, path)?,
        Step::Quit => cx.update(|cx| cx.quit()),
    }
    Ok(())
}

#[cfg(feature = "screenshot")]
fn shot(window: AnyWindowHandle, cx: &mut AsyncApp, path: &str) -> anyhow::Result<()> {
    // Draw the latest state first, then read the frame back.
    let image = window.update(cx, |_, window, cx| {
        window.refresh();
        let _ = window.draw(cx);
        window.render_to_image()
    })??;
    image.save(path)?;
    eprintln!("notefig: screenshot saved to {path}");
    Ok(())
}

#[cfg(not(feature = "screenshot"))]
fn shot(_: AnyWindowHandle, _: &mut AsyncApp, path: &str) -> anyhow::Result<()> {
    anyhow::bail!("shot:{path} needs the app built with --features screenshot")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_steps() {
        let steps = parse("wait:10; key:cmd-p\ntype:Hi there;click:10,20;action:a::B;action:a::C:{\"x\":1};shot:/tmp/x.png;quit").unwrap();
        assert_eq!(steps[0], Step::Wait(10));
        assert_eq!(steps[1], Step::Key("cmd-p".into()));
        assert_eq!(steps[2], Step::Type("Hi there".into()));
        assert!(matches!(steps[3], Step::Click { count: 1, .. }));
        let more = parse("click:1,2,cmd;drag:1,2,3,4").unwrap();
        assert!(matches!(&more[0], Step::Click { modifiers, .. } if modifiers.platform));
        assert_eq!(more[1], Step::Drag(1., 2., 3., 4.));
        let held = parse("drag:1,2,3,4,hold;release:3,4").unwrap();
        assert_eq!(held, vec![Step::DragHold(1., 2., 3., 4.), Step::Release(3., 4.)]);
        assert_eq!(steps[4], Step::Action("a::B".into(), None));
        assert_eq!(steps[5], Step::Action("a::C".into(), Some(serde_json::json!({"x": 1}))));
        assert_eq!(steps[6], Step::Shot("/tmp/x.png".into()));
        assert_eq!(steps[7], Step::Quit);
    }
}
