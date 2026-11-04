//! The usage charts: `usage-bar-chart.tsx` (stacked bars, plain boxes as
//! in TS), `usage-area-chart.tsx` (stacked monotone areas, GPUI paths) and
//! `usage-radar-chart.tsx` (a weekly radar, GPUI paths). Each is a
//! stateless element; hover state lives in the section that draws it and
//! comes back through `on_hover`.

use std::cell::Cell;
use std::f32::consts::PI;
use std::rc::Rc;

use gpui::{
    AnyElement, App, Bounds, Hsla, InteractiveElement, IntoElement, MouseMoveEvent, ParentElement, PathBuilder,
    Pixels, Point, RenderOnce, SharedString, StatefulInteractiveElement as _, Styled, Window, canvas, div, point,
    prelude::FluentBuilder as _, px,
};
use notefig_ui::{rem, sp, tokens};

use crate::model::{ChartBar, ChartColor, ChartSeries};

pub type OnHover = Rc<dyn Fn(Option<usize>, &mut Window, &mut App)>;
pub type Format = Rc<dyn Fn(f64) -> String>;

/// The chart tokens (`--chart-1…4`) and "Other"'s muted colour.
pub fn chart_color(color: ChartColor, cx: &App) -> Hsla {
    let t = tokens(cx);
    let hsl = |h: f32, s: f32, l: f32| gpui::hsla(h / 360., s / 100., l / 100., 1.);
    match color {
        ChartColor::Other => t.muted_foreground.opacity(0.45),
        ChartColor::Palette(i) if t.dark => {
            [hsl(220., 70., 50.), hsl(160., 60., 45.), hsl(30., 80., 55.), hsl(280., 65., 60.)][i % 4]
        }
        ChartColor::Palette(i) => [hsl(220., 70., 50.), hsl(173., 58., 39.), hsl(197., 37., 24.), hsl(43., 74., 66.)][i % 4],
    }
}

const TICKS: usize = 4;

/// 1, 2, 2.5 or 5 × a power of ten, at least `x`.
pub fn nice_step(x: f64) -> f64 {
    if !(x > 0.0) {
        return 1.0;
    }
    let power = 10f64.powf(x.log10().floor());
    let fraction = x / power;
    let nice = if fraction <= 1.0 {
        1.0
    } else if fraction <= 2.0 {
        2.0
    } else if fraction <= 2.5 {
        2.5
    } else if fraction <= 5.0 {
        5.0
    } else {
        10.0
    };
    nice * power
}

/// Each bar's stacked total, and an axis of four nice steps over the
/// tallest — or over `peak`, when what is drawn reaches higher.
pub fn scale_of(bars: &[ChartBar], peak: f64) -> (Vec<f64>, f64, f64) {
    let totals: Vec<f64> = bars.iter().map(|b| b.values.iter().sum()).collect();
    let max = totals.iter().copied().fold(peak, f64::max);
    let step = nice_step(max / TICKS as f64);
    (totals, step, step * TICKS as f64)
}

/// A boundary between bands: its height at each point and, per segment,
/// the cubic's two inner control heights.
#[derive(Debug, Clone, PartialEq)]
pub struct Curve {
    pub at: Vec<f64>,
    pub c1: Vec<f64>,
    pub c2: Vec<f64>,
}

/// Monotone tangents (Fritsch–Carlson) for evenly spaced values.
fn tangents_of(values: &[f64]) -> Vec<f64> {
    let n = values.len();
    let slopes: Vec<f64> = values.windows(2).map(|w| w[1] - w[0]).collect();
    (0..n)
        .map(|i| {
            if i == 0 {
                return slopes.first().copied().unwrap_or(0.0);
            }
            if i == n - 1 {
                return slopes[n - 2];
            }
            let (a, b) = (slopes[i - 1], slopes[i]);
            if a * b <= 0.0 { 0.0 } else { 2.0 * a * b / (a + b) }
        })
        .collect()
}

/// The stack's boundaries, from zero up, one per series. Each series is
/// smoothed on its own values and the curves are added, so a band is never
/// thinner than zero and can't cross the one beneath it.
pub fn stacked_curves(bars: &[ChartBar], series_count: usize) -> Vec<Curve> {
    let n = bars.len();
    let segments = n.saturating_sub(1);
    let mut curve = Curve { at: vec![0.0; n], c1: vec![0.0; segments], c2: vec![0.0; segments] };
    let mut curves = vec![curve.clone()];
    for s in 0..series_count {
        let values: Vec<f64> = bars.iter().map(|b| b.values.get(s).copied().unwrap_or(0.0)).collect();
        let m = tangents_of(&values);
        curve = Curve {
            at: curve.at.iter().enumerate().map(|(i, y)| y + values[i]).collect(),
            c1: curve.c1.iter().enumerate().map(|(i, y)| y + values[i] + m[i] / 3.0).collect(),
            c2: curve.c2.iter().enumerate().map(|(i, y)| y + values[i + 1] - m[i + 1] / 3.0).collect(),
        };
        curves.push(curve.clone());
    }
    curves
}

/// The highest a curve can reach: its points and control heights.
pub fn curve_peak(curve: &Curve) -> f64 {
    curve.at.iter().chain(&curve.c1).chain(&curve.c2).copied().fold(0.0, f64::max)
}

// ─── shared frame ───────────────────────────────────────────────────────────

/// The value axis: four steps, as tall as the plot beside it.
fn axis_labels(step: f64, format: &Format, hidden: bool, cx: &App) -> AnyElement {
    let t = tokens(cx);
    div()
        .relative()
        .w(rem(2.5))
        .h_full()
        .flex_none()
        .when(!hidden, |d| {
            d.children((0..=TICKS).map(|i| {
                let label = if i == 0 { "0".to_string() } else { format(step * i as f64) };
                div()
                    .absolute()
                    .right_0()
                    // `bottom: i/TICKS` then `translate-y-1/2`: centred on the line.
                    .bottom(gpui::relative(i as f32 / TICKS as f32))
                    .mb(-rem(0.6875) * 0.6)
                    .text_color(t.muted_foreground)
                    .whitespace_nowrap()
                    .child(label)
            }))
        })
        .into_any_element()
}

/// The plot's gridlines, one per tick: solid at zero, dashed above.
fn grid_lines(cx: &App) -> Vec<AnyElement> {
    let t = tokens(cx);
    (0..=TICKS)
        .map(|i| {
            div()
                .absolute()
                .left_0()
                .right_0()
                .bottom(gpui::relative(i as f32 / TICKS as f32))
                .h(px(1.))
                .border_t_1()
                .border_color(t.border)
                .when(i > 0, |d| d.border_dashed())
                .into_any_element()
        })
        .collect()
}

fn tooltip(bar: &ChartBar, total: f64, series: &[ChartSeries], format: &Format, cx: &App) -> gpui::Div {
    let t = tokens(cx);
    let mut rows: Vec<(ChartSeries, f64)> =
        series.iter().cloned().zip(bar.values.iter().copied()).collect();
    rows.reverse();
    div()
        .flex()
        .flex_col()
        .gap(sp(1.))
        .min_w(sp(40.))
        .rounded(t.radius_md)
        .border_1()
        .border_color(t.border)
        .bg(t.popover)
        .text_color(t.popover_foreground)
        .shadow_md()
        .p(sp(2.))
        .child(div().font_weight(gpui::FontWeight::MEDIUM).child(bar.title.clone()))
        .children(rows.into_iter().map(|(s, value)| {
            div()
                .flex()
                .items_center()
                .gap(sp(2.))
                .child(div().size(sp(2.)).flex_none().rounded_full().bg(chart_color(s.color, cx)))
                .child(div().flex_1().whitespace_nowrap().text_color(t.muted_foreground).child(s.name))
                .child(div().font_weight(gpui::FontWeight::MEDIUM).child(format(value)))
        }))
        .when(series.len() > 1, |d| {
            d.child(
                div()
                    .mt(sp(0.5))
                    .flex()
                    .justify_between()
                    .gap(sp(2.))
                    .border_t_1()
                    .border_color(t.border)
                    .pt(sp(1.))
                    .child(div().font_weight(gpui::FontWeight::MEDIUM).child(notefig_i18n::t("usageTotal")))
                    .child(div().font_weight(gpui::FontWeight::MEDIUM).child(format(total))),
            )
        })
}

/// A tooltip beside the hovered x (a fraction of the plot): to its right
/// in the left 60%, else to its left.
fn place_tooltip(tip: gpui::Div, at: f32, gap: Pixels) -> AnyElement {
    if at < 0.6 {
        div().absolute().top_0().left(gpui::relative(at)).ml(gap).child(tip).into_any_element()
    } else {
        div().absolute().top_0().right(gpui::relative(1. - at)).mr(gap).child(tip).into_any_element()
    }
}

/// `CHART_GRID`: axis beside the plot, labels under it.
fn frame(height: Pixels, axis: AnyElement, plot: AnyElement, labels: AnyElement, cx: &App) -> gpui::Div {
    let _ = cx;
    div()
        .flex()
        .flex_col()
        .gap(sp(1.5))
        .h(height)
        .text_size(rem(0.6875))
        .child(div().flex().flex_1().min_h_0().gap(sp(2.)).child(axis).child(plot))
        .child(div().flex().h(rem(1.)).gap(sp(2.)).child(div().w(rem(2.5)).flex_none()).child(labels))
}

// ─── bar chart ──────────────────────────────────────────────────────────────

/// `UsageBarChart`: one bar per period (or hour of day), one segment per
/// series, a hover tooltip; greyed under `overlay`.
#[derive(IntoElement)]
pub struct BarChart {
    pub id: SharedString,
    pub series: Vec<ChartSeries>,
    pub bars: Vec<ChartBar>,
    pub format: Format,
    pub format_axis: Format,
    pub height: Pixels,
    pub overlay: Option<String>,
    pub hovered: Option<usize>,
    pub on_hover: OnHover,
}

impl RenderOnce for BarChart {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = tokens(cx).clone();
        let (totals, step, top) = scale_of(&self.bars, 0.0);
        let count = self.bars.len();
        let gap = px(if count > 60 { 2. } else if count > 20 { 3. } else { 8. });
        let radius = px(if count > 40 { 2. } else { 3. });
        let ghost = self.overlay.is_some();
        let hover = if ghost { None } else { self.hovered.filter(|h| *h < count) };

        let bars = self.bars.iter().enumerate().map(|(index, bar)| {
            let on_hover = self.on_hover.clone();
            let height = if top > 0.0 { (totals[index] / top) as f32 } else { 0. };
            div()
                .id(SharedString::from(format!("{}-bar-{index}", self.id)))
                .flex()
                .flex_col()
                .flex_1()
                .min_w_0()
                .h_full()
                .items_center()
                .justify_end()
                .rounded(radius)
                .when(hover == Some(index), |d| d.bg(t.foreground.opacity(0.05)))
                .on_hover(move |on, w, cx| if *on { on_hover(Some(index), w, cx) })
                .child(
                    div()
                        .flex()
                        .flex_col_reverse()
                        .w(gpui::relative(0.7))
                        .max_w(sp(14.))
                        .h(gpui::relative(height))
                        .overflow_hidden()
                        .rounded_t(radius)
                        .children(self.series.iter().enumerate().map(|(si, s)| {
                            let share = if totals[index] > 0.0 { (bar.values[si] / totals[index]) as f32 } else { 0. };
                            div().flex_none().w_full().h(gpui::relative(share)).bg(if ghost {
                                t.muted_foreground.opacity(0.25)
                            } else {
                                chart_color(s.color, cx)
                            })
                        })),
                )
        });

        let on_leave = self.on_hover.clone();
        let mut plot = div()
            .id(SharedString::from(format!("{}-plot", self.id)))
            .relative()
            .flex_1()
            .min_w_0()
            .h_full()
            .on_hover(move |on, w, cx| if !*on { on_leave(None, w, cx) })
            .children(grid_lines(cx))
            .child(div().absolute().inset_0().flex().gap(gap).children(bars));
        if let Some(h) = hover {
            let at = (h as f32 + 0.5) / count as f32;
            let anchor = if at < 0.6 { (h + 1) as f32 / count as f32 } else { h as f32 / count as f32 };
            let tip = tooltip(&self.bars[h], totals[h], &self.series, &self.format, cx);
            plot = plot.child(if at < 0.6 {
                div().absolute().top_0().left(gpui::relative(anchor)).ml(px(8.)).child(tip).into_any_element()
            } else {
                div().absolute().top_0().right(gpui::relative(1. - anchor)).mr(px(8.)).child(tip).into_any_element()
            });
        }
        if let Some(overlay) = &self.overlay {
            plot = plot.child(
                div().absolute().inset_0().flex().items_center().justify_center().child(
                    div()
                        .rounded_full()
                        .border_1()
                        .border_color(t.border)
                        .bg(t.background)
                        .px(sp(3.))
                        .py(sp(1.))
                        .text_size(t.text_xs)
                        .text_color(t.muted_foreground)
                        .child(overlay.clone()),
                ),
            );
        }
        let labels = div().flex().flex_1().min_w_0().gap(gap).children(self.bars.iter().map(|bar| {
            div()
                .flex()
                .flex_1()
                .min_w_0()
                .justify_center()
                .whitespace_nowrap()
                .text_color(t.muted_foreground)
                .child(bar.axis_label.clone())
        }));
        frame(
            self.height,
            axis_labels(step, &self.format_axis, ghost, cx),
            plot.into_any_element(),
            labels.into_any_element(),
            cx,
        )
    }
}

// ─── area chart ─────────────────────────────────────────────────────────────

/// `UsageAreaChart`: one point per period, one band per series, smoothed,
/// and a hover guide with the period's breakdown.
#[derive(IntoElement)]
pub struct AreaChart {
    pub id: SharedString,
    pub series: Vec<ChartSeries>,
    pub bars: Vec<ChartBar>,
    pub format: Format,
    pub format_axis: Format,
    pub height: Pixels,
    pub hovered: Option<usize>,
    pub on_hover: OnHover,
}

impl RenderOnce for AreaChart {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = tokens(cx).clone();
        let count = self.bars.len();
        let curves = stacked_curves(&self.bars, self.series.len());
        let (totals, step, top) = scale_of(&self.bars, curves.last().map(curve_peak).unwrap_or(0.0));
        let hover = self.hovered.filter(|h| *h < count);
        let fraction = move |i: usize| if count > 1 { i as f32 / (count - 1) as f32 } else { 0. };
        let colors: Vec<Hsla> = self.series.iter().map(|s| chart_color(s.color, cx)).collect();
        let bounds_cell: Rc<Cell<Bounds<Pixels>>> = Rc::new(Cell::new(Bounds::default()));

        let paint_curves = curves.clone();
        let paint_colors = colors.clone();
        let measure = bounds_cell.clone();
        let area = canvas(
            move |b, _, _| {
                measure.set(b);
                b
            },
            move |_, b, window, _| {
                let x_of = |i: usize| b.origin.x + b.size.width * fraction(i);
                let y_of = |v: f64| b.origin.y + b.size.height * (1. - if top > 0.0 { (v / top) as f32 } else { 0. });
                // A boundary traced left to right (or back).
                let trace = |builder: &mut PathBuilder, c: &Curve, back: bool, start: bool| {
                    if count == 1 {
                        let y = y_of(c.at[0]);
                        let (a, z) = if back { (b.right(), b.left()) } else { (b.left(), b.right()) };
                        if start { builder.move_to(point(a, y)) } else { builder.line_to(point(a, y)) }
                        builder.line_to(point(z, y));
                        return;
                    }
                    let dx = (x_of(1) - x_of(0)) / 3.;
                    if !back {
                        let p0 = point(x_of(0), y_of(c.at[0]));
                        if start { builder.move_to(p0) } else { builder.line_to(p0) }
                        for i in 0..count - 1 {
                            builder.cubic_bezier_to(
                                point(x_of(i + 1), y_of(c.at[i + 1])),
                                point(x_of(i) + dx, y_of(c.c1[i])),
                                point(x_of(i + 1) - dx, y_of(c.c2[i])),
                            );
                        }
                    } else {
                        builder.line_to(point(x_of(count - 1), y_of(c.at[count - 1])));
                        for i in (0..count - 1).rev() {
                            builder.cubic_bezier_to(
                                point(x_of(i), y_of(c.at[i])),
                                point(x_of(i + 1) - dx, y_of(c.c2[i])),
                                point(x_of(i) + dx, y_of(c.c1[i])),
                            );
                        }
                    }
                };
                for (index, color) in paint_colors.iter().enumerate() {
                    let mut fill = PathBuilder::fill();
                    trace(&mut fill, &paint_curves[index + 1], false, true);
                    trace(&mut fill, &paint_curves[index], true, false);
                    fill.close();
                    if let Ok(path) = fill.build() {
                        window.paint_path(path, color.opacity(0.35));
                    }
                    let mut line = PathBuilder::stroke(px(1.5));
                    trace(&mut line, &paint_curves[index + 1], false, true);
                    if let Ok(path) = line.build() {
                        window.paint_path(path, *color);
                    }
                }
            },
        )
        .absolute()
        .size_full();

        let on_move = self.on_hover.clone();
        let on_leave = self.on_hover.clone();
        let hit = bounds_cell.clone();
        let mut plot = div()
            .id(SharedString::from(format!("{}-plot", self.id)))
            .relative()
            .flex_1()
            .min_w_0()
            .h_full()
            .on_mouse_move(move |e: &MouseMoveEvent, w, cx| {
                let b = hit.get();
                if b.size.width <= px(0.) || count == 0 {
                    return;
                }
                let at = ((e.position.x - b.origin.x) / b.size.width).clamp(0., 1.);
                let index = (at * (count.saturating_sub(1)) as f32).round() as usize;
                on_move(Some(index.min(count - 1)), w, cx);
            })
            .on_hover(move |on, w, cx| if !*on { on_leave(None, w, cx) })
            .children(grid_lines(cx))
            .child(area);
        if let Some(h) = hover {
            let at = fraction(h);
            plot = plot.child(
                div().absolute().top_0().bottom_0().left(gpui::relative(at)).w(px(1.)).bg(t.foreground.opacity(0.3)),
            );
            for (index, color) in colors.iter().enumerate() {
                let y = if top > 0.0 { 1. - (curves[index + 1].at[h] / top) as f32 } else { 1. };
                plot = plot.child(
                    div()
                        .absolute()
                        .left(gpui::relative(at))
                        .top(gpui::relative(y))
                        .ml(px(-4.))
                        .mt(px(-4.))
                        .size(px(8.))
                        .rounded_full()
                        .border_2()
                        .border_color(t.background)
                        .bg(*color),
                );
            }
            let tip = tooltip(&self.bars[h], totals[h], &self.series, &self.format, cx);
            plot = plot.child(place_tooltip(tip, at, px(12.)));
        }
        let labels = div().relative().flex_1().min_w_0().children(self.bars.iter().enumerate().filter_map(|(index, bar)| {
            if bar.axis_label.is_empty() {
                return None;
            }
            let at = fraction(index);
            let label = div().absolute().whitespace_nowrap().text_color(t.muted_foreground).child(bar.axis_label.clone());
            Some(if index == 0 {
                label.left_0()
            } else if index == count - 1 {
                label.right_0()
            } else {
                // `translateX(-50%)`: centred on its point, by an estimate
                // of the label's width (GPUI has no percentage transform).
                let half = rem(0.6875) * (bar.axis_label.chars().count() as f32 * 0.28);
                label.left(gpui::relative(at)).ml(-half)
            })
        }));
        frame(
            self.height,
            axis_labels(step, &self.format_axis, false, cx),
            plot.into_any_element(),
            labels.into_any_element(),
            cx,
        )
    }
}

// ─── radar chart ────────────────────────────────────────────────────────────

/// One shape: 0–1 per spoke, or `None` when there was nothing to measure.
#[derive(Debug, Clone, PartialEq)]
pub struct RadarShape {
    pub color: ChartColor,
    pub values: Vec<Option<f64>>,
}

const SIZE: f32 = 240.;
const RADIUS: f32 = 84.;
const RINGS: [f32; 4] = [0.25, 0.5, 0.75, 1.];

fn point_at(center: Point<Pixels>, scale: f32, index: f32, count: usize, r: f32) -> Point<Pixels> {
    let angle = (index / count as f32) * 2. * PI - PI / 2.;
    point(center.x + px(r * scale * angle.cos()), center.y + px(r * scale * angle.sin()))
}

/// `UsageRadarChart`: one spoke per step clockwise from the top, the
/// centre at 0% and the rim at 100%, shapes overlaid.
#[derive(IntoElement)]
pub struct RadarChart {
    pub id: SharedString,
    pub labels: Vec<String>,
    pub shapes: Vec<RadarShape>,
    pub hovered: Option<usize>,
    pub on_hover: OnHover,
}

impl RenderOnce for RadarChart {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = tokens(cx).clone();
        let count = self.labels.len();
        let grid = t.foreground.opacity(0.1);
        let shapes: Vec<(Hsla, Vec<Option<f64>>)> =
            self.shapes.iter().map(|s| (chart_color(s.color, cx), s.values.clone())).collect();
        let fill_opacity = if self.shapes.len() > 1 { 0.12 } else { 0.25 };
        let hovered = self.hovered;
        let bounds_cell: Rc<Cell<Bounds<Pixels>>> = Rc::new(Cell::new(Bounds::default()));
        let measure = bounds_cell.clone();
        let drawing = canvas(
            move |b, _, _| {
                measure.set(b);
                b
            },
            move |_, b, window, _| {
                let scale = f32::from(b.size.width) / SIZE;
                let center = b.center();
                for ring in RINGS {
                    let pts: Vec<_> = (0..count).map(|i| point_at(center, scale, i as f32, count, ring * RADIUS)).collect();
                    let mut p = PathBuilder::stroke(px(1.));
                    p.add_polygon(&pts, true);
                    if let Ok(path) = p.build() {
                        window.paint_path(path, grid);
                    }
                }
                for i in 0..count {
                    let mut p = PathBuilder::stroke(px(1.));
                    p.move_to(center);
                    p.line_to(point_at(center, scale, i as f32, count, RADIUS));
                    if let Ok(path) = p.build() {
                        window.paint_path(path, grid);
                    }
                }
                for (color, values) in &shapes {
                    let pts: Vec<_> = values
                        .iter()
                        .enumerate()
                        .map(|(i, v)| point_at(center, scale, i as f32, count, v.unwrap_or(0.) as f32 * RADIUS))
                        .collect();
                    let mut fill = PathBuilder::fill();
                    fill.add_polygon(&pts, true);
                    if let Ok(path) = fill.build() {
                        window.paint_path(path, color.opacity(fill_opacity));
                    }
                    let mut line = PathBuilder::stroke(px(1.5));
                    line.add_polygon(&pts, true);
                    if let Ok(path) = line.build() {
                        window.paint_path(path, *color);
                    }
                    for (i, v) in values.iter().enumerate() {
                        if v.is_none() {
                            continue;
                        }
                        let r = px(if hovered == Some(i) { 3.5 } else { 2. } * scale);
                        let c = pts[i];
                        window.paint_quad(gpui::fill(Bounds::new(point(c.x - r, c.y - r), gpui::size(r * 2., r * 2.)), *color).corner_radii(r));
                    }
                }
            },
        )
        .absolute()
        .size_full();

        let measured = |i: usize| self.shapes.iter().any(|s| s.values.get(i).is_some_and(Option::is_some));
        let labels = self.labels.iter().enumerate().map(|(i, label)| {
            // As fractions of the square, so the labels follow its size.
            let at = point_at(point(px(0.5), px(0.5)), 1. / SIZE, i as f32, count, RADIUS + 16.);
            div()
                .absolute()
                .left(gpui::relative(f32::from(at.x)))
                .top(gpui::relative(f32::from(at.y)))
                .ml(px(-20.))
                .mt(px(-8.))
                .w(px(40.))
                .h(px(16.))
                .flex()
                .items_center()
                .justify_center()
                .text_size(px(11.))
                .text_color(if hovered == Some(i) { t.foreground } else { t.muted_foreground })
                .when(!measured(i), |d| d.opacity(0.5))
                .child(label.clone())
        });

        let on_move = self.on_hover.clone();
        let on_leave = self.on_hover.clone();
        let hit = bounds_cell.clone();
        div()
            .id(self.id.clone())
            .relative()
            .mx_auto()
            .size(px(SIZE))
            .on_mouse_move(move |e: &MouseMoveEvent, w, cx| {
                let b = hit.get();
                let scale = f32::from(b.size.width) / SIZE;
                let d = e.position - b.center();
                let (dx, dy) = (f32::from(d.x), f32::from(d.y));
                let reach = (RADIUS + 28.) * scale;
                if (dx * dx + dy * dy).sqrt() > reach || count == 0 {
                    on_move(None, w, cx);
                    return;
                }
                // Angle clockwise from the top, to the nearest spoke.
                let angle = (dx.atan2(-dy) + 2. * PI) % (2. * PI);
                let index = (angle / (2. * PI / count as f32)).round() as usize % count;
                on_move(Some(index), w, cx);
            })
            .on_hover(move |on, w, cx| if !*on { on_leave(None, w, cx) })
            .child(drawing)
            .children(labels)
    }
}

#[cfg(test)]
mod tests {
    //! Port of `usage-area-chart.test.ts`.
    use super::*;

    fn bars(series: &[&[f64]]) -> Vec<ChartBar> {
        (0..series[0].len())
            .map(|i| ChartBar { axis_label: String::new(), title: String::new(), values: series.iter().map(|s| s[i]).collect() })
            .collect()
    }

    /// The cubic's height at `t` along segment `i`.
    fn at(curve: &Curve, i: usize, t: f64) -> f64 {
        let u = 1.0 - t;
        u.powi(3) * curve.at[i] + 3.0 * u * u * t * curve.c1[i] + 3.0 * u * t * t * curve.c2[i] + t.powi(3) * curve.at[i + 1]
    }

    #[test]
    fn passes_through_the_stacked_totals() {
        let curves = stacked_curves(&bars(&[&[1.0, 2.0, 3.0], &[4.0, 0.0, 1.0]]), 2);
        let ats: Vec<_> = curves.iter().map(|c| c.at.clone()).collect();
        assert_eq!(ats, vec![vec![0.0, 0.0, 0.0], vec![1.0, 2.0, 3.0], vec![5.0, 2.0, 4.0]]);
    }

    #[test]
    fn never_lets_a_band_cross_the_one_beneath_it() {
        let curves = stacked_curves(&bars(&[&[0.0, 100.0, 100.0], &[1.0, 0.0, 100.0]]), 2);
        for i in 0..2 {
            let mut t = 0.0;
            while t <= 1.0 {
                assert!(at(&curves[1], i, t) >= at(&curves[0], i, t) - 1e-9);
                assert!(at(&curves[2], i, t) >= at(&curves[1], i, t) - 1e-9);
                t += 0.05;
            }
        }
    }

    #[test]
    fn bounds_the_top_curve_which_can_rise_above_every_point_s_total() {
        let curves = stacked_curves(&bars(&[&[0.0, 80.0, 100.0, 0.0], &[0.0, 20.0, 0.0, 100.0]]), 2);
        let top = &curves[2];
        let peak = curve_peak(top);
        let mut highest: f64 = 0.0;
        for i in 0..3 {
            let mut t = 0.0;
            while t <= 1.0 {
                highest = highest.max(at(top, i, t));
                t += 0.01;
            }
        }
        assert!(highest > 100.0);
        assert!(peak >= highest - 1e-9);
    }

    #[test]
    fn nice_steps_read_easily() {
        assert_eq!(nice_step(0.0), 1.0);
        assert_eq!(nice_step(3.0), 5.0);
        assert_eq!(nice_step(22.0), 25.0);
        assert_eq!(nice_step(1200.0), 2000.0);
        let (_, step, top) = scale_of(&bars(&[&[10.0, 30.0], &[5.0, 0.0]]), 0.0);
        assert_eq!((step, top), (10.0, 40.0));
    }
}
