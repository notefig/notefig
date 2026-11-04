//! Port of `feedback.ts`: `createFeedback`.

use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::rc::Rc;
use std::time::Duration;

use futures::FutureExt;
use futures::future::LocalBoxFuture;
use notefig_core::{Executor, Listeners, Subscription};
use serde_json::json;

use crate::images::{MAX_IMAGES, data_url_bytes, outside_code, replace_images};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FeedbackResult {
    Sent,
    RateLimited,
    Failed,
}

#[derive(Debug, Clone, Default)]
pub struct FeedbackInput {
    pub message: String,
    /// The debug panel's report, when the user chose to attach it.
    pub debug_report: Option<String>,
}

/// A pasted or dropped image held for the draft.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DraftImage {
    pub mime: String,
    pub bytes: Vec<u8>,
}

/// One multipart POST: the `feedback` JSON field and the image files.
#[derive(Debug, Clone)]
pub struct OutgoingFeedback {
    pub url: String,
    pub feedback_json: String,
    pub attachments: Vec<(String, DraftImage)>,
}

/// The HTTP seam (`fetch`). Resolves with the response status. Nothing in
/// the app implements it: this port sends nothing.
pub trait FeedbackTransport {
    fn post(&self, request: OutgoingFeedback) -> LocalBoxFuture<'static, anyhow::Result<u16>>;
}

pub type EncodeImage = Rc<dyn Fn(DraftImage) -> LocalBoxFuture<'static, anyhow::Result<DraftImage>>>;

pub struct FeedbackOptions {
    pub support_url: Option<String>,
    pub transport: Option<Rc<dyn FeedbackTransport>>,
    pub executor: Rc<dyn Executor>,
    pub timeout: Duration,
    /// Shrinks and compresses an image before it is sent. The TS one draws
    /// to a canvas; the default here passes the bytes through.
    pub encode_image: EncodeImage,
    pub version: String,
    pub os: String,
}

// Long enough for a few screenshots on a slow connection.
const SEND_TIMEOUT: Duration = Duration::from_secs(30);
/// The Worker takes up to 50,000 characters; a longer report is cut here.
const MAX_DEBUG_REPORT: usize = 49_000;

impl FeedbackOptions {
    pub fn new(executor: Rc<dyn Executor>) -> Self {
        Self {
            support_url: None,
            transport: None,
            executor,
            timeout: SEND_TIMEOUT,
            encode_image: Rc::new(|image| futures::future::ready(Ok(image)).boxed_local()),
            version: env!("CARGO_PKG_VERSION").to_string(),
            os: match std::env::consts::OS {
                "macos" => "macos",
                "windows" => "windows",
                _ => "linux",
            }
            .to_string(),
        }
    }
}

pub struct FeedbackApi {
    options: FeedbackOptions,
    open: Cell<bool>,
    next_url: Cell<u64>,
    draft_images: Rc<RefCell<BTreeMap<String, DraftImage>>>,
    changed: Listeners<()>,
}

pub fn create_feedback(options: FeedbackOptions) -> FeedbackApi {
    FeedbackApi {
        options,
        open: Cell::new(false),
        next_url: Cell::new(0),
        draft_images: Rc::default(),
        changed: Listeners::new(),
    }
}

fn truncate(report: &str) -> String {
    let units: Vec<u16> = report.encode_utf16().collect();
    if units.len() <= MAX_DEBUG_REPORT {
        return report.to_string();
    }
    format!("{}\n… (truncated)", String::from_utf16_lossy(&units[..MAX_DEBUG_REPORT]))
}

impl FeedbackApi {
    pub fn available(&self) -> bool {
        self.options.support_url.is_some() && self.options.transport.is_some()
    }

    pub fn is_open(&self) -> bool {
        self.open.get()
    }

    pub fn subscribe(&self, listener: impl Fn() + 'static) -> Subscription {
        self.changed.subscribe(move |_| listener())
    }

    fn set_open(&self, next: bool) {
        if self.open.get() != next {
            self.open.set(next);
            self.changed.emit();
        }
    }

    pub fn open(&self) {
        self.set_open(true);
    }

    pub fn close(&self) {
        self.set_open(false);
    }

    /// Holds a pasted image for the draft; returns the URL the editor shows
    /// it by (`blob:N`, as an object URL).
    pub fn add_image(&self, image: DraftImage) -> String {
        let n = self.next_url.get() + 1;
        self.next_url.set(n);
        let url = format!("blob:{n}");
        self.draft_images.borrow_mut().insert(url.clone(), image);
        url
    }

    /// Lets go of the draft's images that `draft` no longer shows.
    pub fn release_images(&self, draft: &str) {
        self.draft_images.borrow_mut().retain(|url, _| draft.contains(url.as_str()));
    }

    pub fn draft_image_urls(&self) -> Vec<String> {
        self.draft_images.borrow().keys().cloned().collect()
    }

    /// Never fails: a network error, an image that won't encode, or no
    /// answer within the timeout is `Failed`, so the dialog keeps the draft.
    pub fn send(&self, input: FeedbackInput) -> LocalBoxFuture<'static, FeedbackResult> {
        let (Some(url), Some(transport)) = (self.options.support_url.clone(), self.options.transport.clone()) else {
            return futures::future::ready(FeedbackResult::Failed).boxed_local();
        };
        let draft = self.draft_images.clone();
        let encode = self.options.encode_image.clone();
        let timer = self.options.executor.timer(self.options.timeout);
        let (version, os) = (self.options.version.clone(), self.options.os.clone());
        async move {
            let work = async {
                // Which images the message shows, first MAX_IMAGES known ones.
                let mut ids: Vec<(String, String)> = Vec::new();
                outside_code(&input.message, |text| {
                    replace_images(text, |m| {
                        let known = draft.borrow().contains_key(m.src) || m.src.starts_with("data:");
                        if known && !ids.iter().any(|(s, _)| s == m.src) && ids.len() < MAX_IMAGES {
                            ids.push((m.src.to_string(), format!("img{}", ids.len() + 1)));
                        }
                        String::new()
                    });
                    text.to_string()
                });
                let mut attachments = Vec::new();
                for (src, id) in &ids {
                    let image = draft.borrow().get(src).cloned().unwrap_or_else(|| {
                        let (mime, bytes) = data_url_bytes(src);
                        DraftImage { mime, bytes }
                    });
                    attachments.push((id.clone(), encode(image).await?));
                }
                let message = outside_code(&input.message, |text| {
                    replace_images(text, |m| match ids.iter().find(|(s, _)| s == m.src) {
                        Some((_, id)) => format!("![{}](attachment:{id})", m.alt),
                        None => String::new(),
                    })
                });
                let mut body = json!({ "message": message, "version": version, "os": os });
                if let Some(report) = input.debug_report.as_deref().filter(|r| !r.is_empty()) {
                    body["debugReport"] = json!(truncate(report));
                }
                let request = OutgoingFeedback {
                    url: format!("{}/v1/feedback", url.trim_end_matches('/')),
                    feedback_json: body.to_string(),
                    attachments,
                };
                transport.post(request).await
            };
            let status = futures::select! {
                r = work.fuse() => r,
                _ = timer.fuse() => Err(anyhow::anyhow!("timed out")),
            };
            match status {
                Ok(429) => FeedbackResult::RateLimited,
                Ok(s) if (200..300).contains(&s) => {
                    draft.borrow_mut().clear();
                    FeedbackResult::Sent
                }
                _ => FeedbackResult::Failed,
            }
        }
        .boxed_local()
    }
}
