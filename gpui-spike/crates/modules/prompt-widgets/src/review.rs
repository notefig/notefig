//! What each prompt widget's rounds changed in each document: a port of
//! `@notefig/widgets` `prompt/change-store.ts` (the review half of the
//! widget's state). The editor maps changes through its transactions and
//! writes them here; the app keeps the saved copy ([`ReviewRangeStore`],
//! the prompt rounds module). `usePromptChangeCounts` is the view's.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;

use futures::future::LocalBoxFuture;
use notefig_core::{Executor, ExecutorExt, Listeners, Subscription};
use serde::{Deserialize, Serialize};

/// Transaction meta naming the round a transaction's edits belong to.
pub const PROMPT_CHANGE_META: &str = "notefigPromptChange";

/// The round a change belongs to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptChangeAttribution {
    pub blob_id: String,
    pub turn_id: String,
}

/// One changed span; `from == to` marks a pure deletion.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptChange {
    pub blob_id: String,
    pub turn_id: String,
    pub from: i64,
    pub to: i64,
}

/// A document's review ranges, with the fingerprint of the document they
/// were mapped onto.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedReviewRanges {
    pub fingerprint: String,
    pub changes: Vec<PromptChange>,
}

/// Where review ranges are kept between runs.
pub trait ReviewRangeStore {
    /// Every document's saved ranges, once what was stored has loaded.
    fn load_all(&self) -> LocalBoxFuture<'static, anyhow::Result<BTreeMap<String, SavedReviewRanges>>>;
    fn save(&self, document_path: &str, saved: SavedReviewRanges);
    /// Drop every range a widget's rounds made, in every document.
    fn forget(&self, blob_id: &str);
}

/// `NO_SAVED_REVIEW_RANGES`: keeps nothing.
pub struct NoSavedReviewRanges;

impl ReviewRangeStore for NoSavedReviewRanges {
    fn load_all(&self) -> LocalBoxFuture<'static, anyhow::Result<BTreeMap<String, SavedReviewRanges>>> {
        Box::pin(async { Ok(BTreeMap::new()) })
    }
    fn save(&self, _: &str, _: SavedReviewRanges) {}
    fn forget(&self, _: &str) {}
}

#[derive(Clone)]
struct Entry {
    changes: Rc<Vec<PromptChange>>,
    unchecked: Option<String>,
}

struct Inner {
    saved: Rc<dyn ReviewRangeStore>,
    by_document: RefCell<BTreeMap<String, Entry>>,
    last_saved: RefCell<BTreeMap<String, String>>,
    reviewing: RefCell<Option<String>>,
    changed: Listeners<()>,
}

/// `PromptReview` (`createPromptReview`).
#[derive(Clone)]
pub struct PromptReview {
    inner: Rc<Inner>,
}

impl PromptReview {
    /// Takes up what `saved` holds, on `executor`.
    pub fn new(saved: Rc<dyn ReviewRangeStore>, executor: &Rc<dyn Executor>) -> Self {
        let inner = Rc::new(Inner {
            saved: saved.clone(),
            by_document: RefCell::default(),
            last_saved: RefCell::default(),
            reviewing: RefCell::new(None),
            changed: Listeners::new(),
        });
        let weak = Rc::downgrade(&inner);
        let load = saved.load_all();
        executor.spawn_local(async move {
            let documents = match load.await {
                Ok(d) => d,
                Err(err) => {
                    log::error!("Failed to load review ranges: {err:#}");
                    return;
                }
            };
            let Some(inner) = weak.upgrade() else { return };
            {
                let mut by_document = inner.by_document.borrow_mut();
                for (path, saved) in &documents {
                    // An editor that already tracks changes of its own keeps them.
                    if by_document.get(path).is_some_and(|e| !e.changes.is_empty()) {
                        continue;
                    }
                    by_document.insert(
                        path.clone(),
                        Entry { changes: Rc::new(saved.changes.clone()), unchecked: Some(saved.fingerprint.clone()) },
                    );
                }
            }
            if !documents.is_empty() {
                inner.changed.emit();
            }
        });
        Self { inner }
    }

    /// A document's changes. Stable: the same `Rc` until they change.
    pub fn changes(&self, document_path: &str) -> Rc<Vec<PromptChange>> {
        self.inner
            .by_document
            .borrow()
            .get(document_path)
            .map(|e| e.changes.clone())
            .unwrap_or_default()
    }

    /// The fingerprint saved changes were mapped onto, while no editor has
    /// checked them.
    pub fn unchecked(&self, document_path: &str) -> Option<String> {
        self.inner.by_document.borrow().get(document_path).and_then(|e| e.unchecked.clone())
    }

    /// The editor holding the document wrote its changes: checked.
    pub fn set(&self, document_path: &str, changes: Vec<PromptChange>) {
        {
            let mut by_document = self.inner.by_document.borrow_mut();
            if let Some(current) = by_document.get(document_path)
                && *current.changes == changes
                && current.unchecked.is_none()
            {
                return;
            }
            by_document.insert(document_path.to_string(), Entry { changes: Rc::new(changes), unchecked: None });
        }
        self.inner.changed.emit();
    }

    /// No editor holds the document any more.
    pub fn release(&self, document_path: &str, fingerprint: &str) {
        if let Some(entry) = self.inner.by_document.borrow_mut().get_mut(document_path) {
            entry.unchecked = Some(fingerprint.to_string());
        }
    }

    /// Keep a document's changes past this run.
    pub fn save(&self, document_path: &str, ranges: SavedReviewRanges) {
        let key = serde_json::to_string(&ranges).unwrap_or_default();
        if self.inner.last_saved.borrow().get(document_path) == Some(&key) {
            return;
        }
        self.inner.last_saved.borrow_mut().insert(document_path.to_string(), key);
        self.inner.saved.save(document_path, ranges);
    }

    /// Forget every change a widget's rounds made, in every document.
    pub fn discard(&self, blob_id: &str) {
        let mut changed = self.inner.reviewing.borrow().as_deref() == Some(blob_id);
        if changed {
            *self.inner.reviewing.borrow_mut() = None;
        }
        for entry in self.inner.by_document.borrow_mut().values_mut() {
            if !entry.changes.iter().any(|c| c.blob_id == blob_id) {
                continue;
            }
            changed = true;
            entry.changes = Rc::new(entry.changes.iter().filter(|c| c.blob_id != blob_id).cloned().collect());
        }
        self.inner.saved.forget(blob_id);
        if changed {
            self.inner.changed.emit();
        }
    }

    /// A widget's changed spans, per document.
    pub fn counts(&self, blob_id: &str) -> BTreeMap<String, usize> {
        self.inner
            .by_document
            .borrow()
            .iter()
            .filter_map(|(path, e)| {
                let n = e.changes.iter().filter(|c| c.blob_id == blob_id).count();
                (n > 0).then(|| (path.clone(), n))
            })
            .collect()
    }

    /// The one widget under review.
    pub fn reviewing(&self) -> Option<String> {
        self.inner.reviewing.borrow().clone()
    }

    pub fn set_reviewing(&self, blob_id: Option<&str>) {
        if self.inner.reviewing.borrow().as_deref() == blob_id {
            return;
        }
        *self.inner.reviewing.borrow_mut() = blob_id.map(str::to_string);
        self.inner.changed.emit();
    }

    pub fn subscribe(&self, listener: impl Fn() + 'static) -> Subscription {
        self.inner.changed.subscribe(move |_| listener())
    }
}

/// The widget's review hue (1–5), picked by id: `promptChangeColor`'s
/// `--chart-<n>` index (the view turns it into a theme colour).
pub fn prompt_change_hue(blob_id: &str) -> u32 {
    let mut hash: i32 = 0;
    for unit in blob_id.encode_utf16() {
        hash = hash.wrapping_mul(31).wrapping_add(unit as i32);
    }
    hash.unsigned_abs() % 5 + 1
}
