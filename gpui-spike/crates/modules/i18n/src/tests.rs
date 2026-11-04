use crate::*;

#[test]
fn looks_up_plain_nested_and_missing_keys() {
    assert_eq!(t("openFolder"), "Open Folder");
    assert_eq!(t("hotkeyLabels.closeTab"), "Close tab");
    assert_eq!(t("no.such.key"), "no.such.key");
}

#[test]
fn interpolates_and_pluralizes() {
    assert_eq!(t_args("searchIn", &[("workspace", "ref-ws")]), "Search ref-ws");
    assert_eq!(t_count("searchResultCount", 1), "1 result");
    assert_eq!(t_count("searchResultCount", 8), "8 results");
    assert_eq!(t_count("searchFileCount", 3), "in 3 files");
}

#[test]
fn returns_lists() {
    assert_eq!(t_list("commandKeywords.undo"), vec!["undo", "revert", "back"]);
    assert!(t_list("openFolder").is_empty());
}

#[test]
fn a_language_without_a_catalog_falls_back_to_english_and_notifies() {
    let i18n = create_i18n("english");
    let hits = std::rc::Rc::new(std::cell::Cell::new(0));
    let h = hits.clone();
    let _sub = i18n.subscribe(move || h.set(h.get() + 1));
    i18n.set_language("hebrew");
    i18n.set_language("hebrew");
    assert_eq!(hits.get(), 1);
    assert_eq!(i18n.language(), "hebrew");
    assert_eq!(t("openFolder"), "Open Folder");
    assert_eq!(Direction::for_language("hebrew"), Direction::Rtl);
    i18n.set_language("english");
}
