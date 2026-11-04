//! Display formatting: `utils/usage-format.ts` and the label helpers of
//! `usage-settings.tsx`. TS formats with `Intl` in the user's locale; here
//! the locale is the app language's (`notefig_i18n`), as [`Locale`].

use chrono::{Datelike, Local, TimeZone};
use notefig_agent::usage::{Cost, CostType};
use notefig_usage::series::UsageGrain;

/// What `Intl` would use for numbers and dates in one language.
#[derive(Debug, Clone, PartialEq)]
pub struct Locale {
    group: &'static str,
    decimal: char,
    /// "12,50 $" rather than "$12.50".
    currency_after: bool,
    /// "15 h" rather than "3 PM".
    h24: Option<&'static str>,
    /// Day before month: "7 oct." rather than "Oct 7".
    day_first: bool,
    months: [&'static str; 12],
    months_long: [&'static str; 12],
    weekdays: [&'static str; 7],
}

impl Default for Locale {
    fn default() -> Self {
        Self::english()
    }
}

impl Locale {
    fn english() -> Self {
        Self {
            group: ",",
            decimal: '.',
            currency_after: false,
            h24: None,
            day_first: false,
            months: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
            months_long: [
                "January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
                "November", "December",
            ],
            weekdays: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
        }
    }

    /// The locale of an app language code (`notefig_i18n::LANGUAGES`).
    pub fn for_language(code: &str) -> Self {
        match code {
            "spanish" => Self {
                group: ".",
                decimal: ',',
                currency_after: true,
                h24: Some("{h}"),
                day_first: true,
                months: ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sept", "oct", "nov", "dic"],
                months_long: [
                    "enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre",
                    "noviembre", "diciembre",
                ],
                weekdays: ["lun", "mar", "mié", "jue", "vie", "sáb", "dom"],
            },
            "french" => Self {
                group: "\u{202f}",
                decimal: ',',
                currency_after: true,
                h24: Some("{h} h"),
                day_first: true,
                months: ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."],
                months_long: [
                    "janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre",
                    "novembre", "décembre",
                ],
                weekdays: ["lun.", "mar.", "mer.", "jeu.", "ven.", "sam.", "dim."],
            },
            "german" => Self {
                group: ".",
                decimal: ',',
                currency_after: true,
                h24: Some("{h} Uhr"),
                day_first: true,
                months: ["Jan.", "Feb.", "März", "Apr.", "Mai", "Juni", "Juli", "Aug.", "Sept.", "Okt.", "Nov.", "Dez."],
                months_long: [
                    "Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober",
                    "November", "Dezember",
                ],
                weekdays: ["Mo.", "Di.", "Mi.", "Do.", "Fr.", "Sa.", "So."],
            },
            "japanese" => Self {
                group: ",",
                decimal: '.',
                currency_after: false,
                h24: Some("{h}時"),
                day_first: false,
                months: ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"],
                months_long: ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"],
                weekdays: ["月", "火", "水", "木", "金", "土", "日"],
            },
            "arabic" => Self {
                group: ",",
                decimal: '.',
                currency_after: true,
                h24: Some("{h}"),
                day_first: true,
                months: [
                    "يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر",
                    "ديسمبر",
                ],
                months_long: [
                    "يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر",
                    "ديسمبر",
                ],
                weekdays: ["الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت", "الأحد"],
            },
            "hebrew" => Self {
                group: ",",
                decimal: '.',
                currency_after: true,
                h24: Some("{h}"),
                day_first: true,
                months: ["ינו׳", "פבר׳", "מרץ", "אפר׳", "מאי", "יוני", "יולי", "אוג׳", "ספט׳", "אוק׳", "נוב׳", "דצמ׳"],
                months_long: [
                    "ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני", "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר",
                    "דצמבר",
                ],
                weekdays: ["יום ב׳", "יום ג׳", "יום ד׳", "יום ה׳", "יום ו׳", "שבת", "יום א׳"],
            },
            _ => Self::english(),
        }
    }

    /// `n` with `digits` fraction digits, grouped, with this decimal mark.
    fn fixed(&self, n: f64, digits: usize) -> String {
        let s = format!("{:.digits$}", n.abs());
        let (int, frac) = match s.split_once('.') {
            Some((i, f)) => (i.to_string(), Some(f.to_string())),
            None => (s.clone(), None),
        };
        let mut out = String::new();
        for (i, ch) in int.chars().enumerate() {
            if i > 0 && (int.len() - i) % 3 == 0 {
                out.push_str(self.group);
            }
            out.push(ch);
        }
        if let Some(frac) = frac {
            out.push(self.decimal);
            out.push_str(&frac);
        }
        if n < 0.0 { format!("-{out}") } else { out }
    }

    /// At most `digits` fraction digits, trailing zeros dropped.
    fn trim(&self, value: f64, digits: usize) -> String {
        let s = self.fixed(value, digits);
        if !s.contains(self.decimal) {
            return s;
        }
        let s = s.trim_end_matches('0');
        s.strip_suffix(self.decimal).unwrap_or(s).to_string()
    }

    fn money(&self, amount: String, currency: &str) -> String {
        match symbol(currency) {
            Some(sym) if self.currency_after => format!("{amount}\u{a0}{sym}"),
            Some(sym) => format!("{sym}{amount}"),
            None => format!("{amount} {currency}"),
        }
    }
}

fn symbol(currency: &str) -> Option<&'static str> {
    match currency {
        "USD" => Some("$"),
        "EUR" => Some("€"),
        "GBP" => Some("£"),
        "JPY" => Some("¥"),
        _ => None,
    }
}

/// 950 · 12.3k · 4.5M
pub fn format_tokens(count: f64, loc: &Locale) -> String {
    let trim = |v: f64| if v >= 100.0 { loc.fixed(v, 0) } else { loc.trim(v, 1) };
    if count < 1000.0 {
        return format!("{}", count.round() as i64);
    }
    if count < 1_000_000.0 {
        return format!("{}k", trim(count / 1000.0));
    }
    format!("{}M", trim(count / 1_000_000.0))
}

/// $0.34 · $0.0021 · 12.5 credits — money keeps two significant digits
/// when small; credits are a plain count.
pub fn format_cost(money: &Cost, loc: &Locale) -> String {
    if money.kind == CostType::Credits {
        return format!("{} credits", loc.trim(money.amount, 2));
    }
    let digits = if money.amount != 0.0 && money.amount.abs() < 0.01 { 4 } else { 2 };
    loc.money(loc.fixed(money.amount, digits), &money.currency)
}

/// `Intl.NumberFormat({ notation: "compact", maximumFractionDigits: 1,
/// style: "currency" })`: $0 · $1.5 · $12K · $1.2M — the cost axis.
pub fn format_cost_compact(amount: f64, currency: &str, kind: CostType, loc: &Locale) -> String {
    let (value, suffix) = if amount.abs() >= 1e9 {
        (amount / 1e9, "B")
    } else if amount.abs() >= 1e6 {
        (amount / 1e6, "M")
    } else if amount.abs() >= 1e3 {
        (amount / 1e3, "K")
    } else {
        (amount, "")
    };
    let s = format!("{}{suffix}", loc.trim(value, 1));
    if kind == CostType::Credits {
        return s;
    }
    loc.money(s, currency)
}

/// `toLocaleTimeString({ hour: "numeric" })`: "12 AM", "3 PM" (or "15 h").
pub fn hour_label(hour: u32, loc: &Locale) -> String {
    if let Some(pattern) = loc.h24 {
        return pattern.replace("{h}", &hour.to_string());
    }
    let h12 = if hour % 12 == 0 { 12 } else { hour % 12 };
    format!("{h12} {}", if hour < 12 { "AM" } else { "PM" })
}

/// "9 AM – 10 AM".
pub fn hour_range(hour: u32, loc: &Locale) -> String {
    format!("{} – {}", hour_label(hour, loc), hour_label((hour + 1) % 24, loc))
}

const HOUR_MS: i64 = 3_600_000;
const DAY_MS: i64 = 24 * HOUR_MS;

/// "5h", "7d": a limit window's length.
pub fn duration(ms: f64) -> String {
    let ms = ms as i64;
    if ms >= DAY_MS && ms % DAY_MS == 0 {
        return format!("{}d", ms / DAY_MS);
    }
    if ms >= HOUR_MS {
        return format!("{}h", (ms as f64 / HOUR_MS as f64).round() as i64);
    }
    format!("{}m", (ms as f64 / 60_000.0).round() as i64)
}

/// "2h 14m", "3d 5h": time left until `at`.
pub fn until(at: f64, now: i64) -> String {
    let ms = (at as i64 - now).max(0);
    if ms >= DAY_MS {
        return format!("{}d {}h", ms / DAY_MS, (ms % DAY_MS) / HOUR_MS);
    }
    format!("{}h {}m", ms / HOUR_MS, (ms % HOUR_MS) / 60_000)
}

/// Monday first, short: "Mon".
pub fn weekday_name(index: usize, loc: &Locale) -> String {
    loc.weekdays[index % 7].to_string()
}

pub fn percent(share: f64) -> String {
    format!("{}%", (share * 100.0).round() as i64)
}

/// A period's axis label and tooltip title (`periodLabels`).
pub fn period_labels(grain: UsageGrain, start: i64, week_of: impl Fn(&str) -> String, loc: &Locale) -> (String, String) {
    let Some(date) = Local.timestamp_millis_opt(start).single() else {
        return (String::new(), String::new());
    };
    let month = date.month0() as usize;
    match grain {
        UsageGrain::Quarter => {
            let label = format!("Q{} {}", month / 3 + 1, date.year());
            (label.clone(), label)
        }
        UsageGrain::Month => (loc.months[month].to_string(), format!("{} {}", loc.months_long[month], date.year())),
        UsageGrain::Day | UsageGrain::Week => {
            let day = if loc.day_first {
                format!("{} {}", date.day(), loc.months[month])
            } else {
                format!("{} {}", loc.months[month], date.day())
            };
            let title = if grain == UsageGrain::Week {
                week_of(&day)
            } else {
                format!("{}, {day}", loc.weekdays[date.weekday().num_days_from_monday() as usize])
            };
            (day, title)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn en() -> Locale {
        Locale::default()
    }

    #[test]
    fn tokens_read_as_ts_does() {
        assert_eq!(format_tokens(950.0, &en()), "950");
        assert_eq!(format_tokens(12_300.0, &en()), "12.3k");
        assert_eq!(format_tokens(12_000.0, &en()), "12k");
        assert_eq!(format_tokens(4_500_000.0, &en()), "4.5M");
        assert_eq!(format_tokens(250_000.0, &en()), "250k");
        assert_eq!(format_tokens(12_300.0, &Locale::for_language("german")), "12,3k");
    }

    #[test]
    fn costs_read_as_ts_does() {
        let usd = |amount| Cost { amount, currency: "USD".into(), kind: CostType::Currency };
        assert_eq!(format_cost(&usd(0.34), &en()), "$0.34");
        assert_eq!(format_cost(&usd(0.0021), &en()), "$0.0021");
        assert_eq!(format_cost(&usd(1234.5), &en()), "$1,234.50");
        assert_eq!(format_cost(&usd(1234.5), &Locale::for_language("german")), "1.234,50\u{a0}$");
        let credits = Cost { amount: 12.5, currency: "devin".into(), kind: CostType::Credits };
        assert_eq!(format_cost(&credits, &en()), "12.5 credits");
        assert_eq!(format_cost_compact(1500.0, "USD", CostType::Currency, &en()), "$1.5K");
        assert_eq!(format_cost_compact(2.0, "USD", CostType::Currency, &en()), "$2");
    }

    #[test]
    fn times_read_as_ts_does() {
        assert_eq!(hour_label(0, &en()), "12 AM");
        assert_eq!(hour_label(15, &en()), "3 PM");
        assert_eq!(hour_label(15, &Locale::for_language("french")), "15 h");
        assert_eq!(hour_range(23, &en()), "11 PM – 12 AM");
        assert_eq!(duration(5.0 * 3_600_000.0), "5h");
        assert_eq!(duration(7.0 * 86_400_000.0), "7d");
        assert_eq!(until(90_061_000.0, 0), "1d 1h");
        assert_eq!(until(8_040_000.0, 0), "2h 14m");
        assert_eq!(percent(0.456), "46%");
        assert_eq!(weekday_name(6, &Locale::for_language("german")), "So.");
    }
}
