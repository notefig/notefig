//! Port of `modules/feedback/feedback.test.ts` over a recording transport.

use std::cell::RefCell;
use std::rc::Rc;
use std::time::Duration;

use futures::FutureExt;
use futures::future::LocalBoxFuture;
use notefig_core::testing::TestExecutor;
use serde_json::Value;

use crate::*;

const SUPPORT_URL: &str = "https://support.notefig.com";

enum Reply {
    Status(u16),
    Offline,
    Hang,
}

struct Recorder {
    reply: Reply,
    sent: RefCell<Vec<OutgoingFeedback>>,
}

impl FeedbackTransport for Recorder {
    fn post(&self, request: OutgoingFeedback) -> LocalBoxFuture<'static, anyhow::Result<u16>> {
        self.sent.borrow_mut().push(request);
        match self.reply {
            Reply::Status(s) => futures::future::ready(Ok(s)).boxed_local(),
            Reply::Offline => futures::future::ready(Err(anyhow::anyhow!("Failed to fetch"))).boxed_local(),
            Reply::Hang => futures::future::pending().boxed_local(),
        }
    }
}

fn png(label: &str) -> DraftImage {
    DraftImage { mime: "image/png".into(), bytes: label.as_bytes().to_vec() }
}

fn feedback(exec: &Rc<TestExecutor>, reply: Reply) -> (FeedbackApi, Rc<Recorder>) {
    let rec = Rc::new(Recorder { reply, sent: RefCell::default() });
    let mut options = FeedbackOptions::new(exec.clone());
    options.support_url = Some(SUPPORT_URL.into());
    options.transport = Some(rec.clone());
    options.version = "1.2.3".into();
    options.os = "web".into();
    // Tags the image so a test can tell it was encoded.
    options.encode_image = Rc::new(|img: DraftImage| {
        let mut bytes = b"encoded:".to_vec();
        bytes.extend(img.bytes);
        futures::future::ready(Ok(DraftImage { mime: "image/webp".into(), bytes })).boxed_local()
    });
    (create_feedback(options), rec)
}

fn body(rec: &Recorder) -> Value {
    serde_json::from_str(&rec.sent.borrow()[0].feedback_json).unwrap()
}

fn attachment(rec: &Recorder, id: &str) -> Option<String> {
    rec.sent.borrow()[0]
        .attachments
        .iter()
        .find(|(i, _)| i == id)
        .map(|(_, img)| String::from_utf8(img.bytes.clone()).unwrap())
}

fn msg(m: &str) -> FeedbackInput {
    FeedbackInput { message: m.into(), debug_report: None }
}

#[test]
fn tells_subscribers_when_the_dialog_opens_and_closes() {
    let exec = TestExecutor::new();
    let (f, _) = feedback(&exec, Reply::Status(202));
    let count = Rc::new(RefCell::new(0));
    let c = count.clone();
    let sub = f.subscribe(move || *c.borrow_mut() += 1);
    f.open();
    f.open();
    assert!(f.is_open());
    f.close();
    assert!(!f.is_open());
    assert_eq!(*count.borrow(), 2);
    drop(sub);
    f.open();
    assert_eq!(*count.borrow(), 2);
}

#[test]
fn is_unavailable_and_sends_nothing_without_a_support_url() {
    let exec = TestExecutor::new();
    let f = create_feedback(FeedbackOptions::new(exec.clone()));
    assert!(!f.available());
    assert_eq!(exec.block_on(f.send(msg("x"))), FeedbackResult::Failed);
}

#[test]
fn posts_the_message_with_version_and_os_to_v1_feedback() {
    let exec = TestExecutor::new();
    let (f, rec) = feedback(&exec, Reply::Status(202));
    assert_eq!(exec.block_on(f.send(msg("Dark mode for the sidebar"))), FeedbackResult::Sent);
    assert_eq!(rec.sent.borrow()[0].url, format!("{SUPPORT_URL}/v1/feedback"));
    assert_eq!(body(&rec), serde_json::json!({"message": "Dark mode for the sidebar", "version": "1.2.3", "os": "web"}));
}

#[test]
fn attaches_the_debug_report_cut_to_what_the_worker_accepts() {
    let exec = TestExecutor::new();
    let (f, rec) = feedback(&exec, Reply::Status(202));
    exec.block_on(f.send(FeedbackInput { message: "x".into(), debug_report: Some("r".repeat(60_000)) }));
    let report = body(&rec)["debugReport"].as_str().unwrap().to_string();
    assert!(report.len() <= 50_000);
    assert!(report.ends_with("… (truncated)"));
}

#[test]
fn tells_a_rate_limit_apart_from_other_failures() {
    let exec = TestExecutor::new();
    for (status, want) in [(429, FeedbackResult::RateLimited), (502, FeedbackResult::Failed), (400, FeedbackResult::Failed)] {
        let (f, _) = feedback(&exec, Reply::Status(status));
        assert_eq!(exec.block_on(f.send(msg("x"))), want);
    }
}

#[test]
fn fails_instead_of_throwing_on_a_network_error_or_a_server_that_never_answers() {
    let exec = TestExecutor::new();
    let (f, _) = feedback(&exec, Reply::Offline);
    assert_eq!(exec.block_on(f.send(msg("x"))), FeedbackResult::Failed);
    let (f, _) = feedback(&exec, Reply::Hang);
    let out = Rc::new(RefCell::new(None));
    let o = out.clone();
    let send = f.send(msg("x"));
    use notefig_core::ExecutorExt;
    exec.spawn_local(async move { *o.borrow_mut() = Some(send.await) });
    exec.run_until_parked();
    assert!(out.borrow().is_none());
    exec.advance(Duration::from_secs(31));
    assert_eq!(*out.borrow(), Some(FeedbackResult::Failed));
}

#[test]
fn sends_the_images_the_message_shows_as_files_and_lets_them_go_once_sent() {
    let exec = TestExecutor::new();
    let (f, rec) = feedback(&exec, Reply::Status(202));
    let first = f.add_image(png("one"));
    let second = f.add_image(png("two"));
    f.add_image(png("deleted from the message"));
    exec.block_on(f.send(msg(&format!("Look ![]({first}) and ![a]({second}) and ![]({first})"))));
    assert_eq!(body(&rec)["message"], "Look ![](attachment:img1) and ![a](attachment:img2) and ![](attachment:img1)");
    assert_eq!(rec.sent.borrow()[0].attachments[0].1.mime, "image/webp");
    assert_eq!(attachment(&rec, "img1").unwrap(), "encoded:one");
    assert_eq!(attachment(&rec, "img2").unwrap(), "encoded:two");
    assert!(attachment(&rec, "img3").is_none());
    assert!(f.draft_image_urls().is_empty());
}

#[test]
fn keeps_a_failed_sends_images_for_the_retry() {
    let exec = TestExecutor::new();
    let (f, _) = feedback(&exec, Reply::Status(502));
    let url = f.add_image(png("one"));
    assert_eq!(exec.block_on(f.send(msg(&format!("![]({url})")))), FeedbackResult::Failed);
    assert_eq!(f.draft_image_urls(), vec![url]);
}

#[test]
fn sends_at_most_three_images_and_drops_ones_it_cant_find() {
    let exec = TestExecutor::new();
    let (f, rec) = feedback(&exec, Reply::Status(202));
    let images: Vec<String> = (1..=4).map(|n| format!("![]({})", f.add_image(png(&n.to_string())))).collect();
    exec.block_on(f.send(msg(&format!("{} ![](blob:stale)", images.join(" ")))));
    assert_eq!(body(&rec)["message"], "![](attachment:img1) ![](attachment:img2) ![](attachment:img3)  ");
    assert!(attachment(&rec, "img4").is_none());
}

#[test]
fn sends_a_pasted_data_url_image_as_a_file_too() {
    let exec = TestExecutor::new();
    let (f, rec) = feedback(&exec, Reply::Status(202));
    // btoa("pixels") = cGl4ZWxz
    exec.block_on(f.send(msg("![](data:image/png;base64,cGl4ZWxz)")));
    assert_eq!(body(&rec)["message"], "![](attachment:img1)");
    assert_eq!(attachment(&rec, "img1").unwrap(), "encoded:pixels");
}

#[test]
fn counts_an_image_by_its_placeholder_not_its_url() {
    let data = format!("data:image/png;base64,{}", "A".repeat(10_000));
    assert_eq!(message_length(&format!("Hi ![]({data})")), "Hi ![](attachment:img0)".len());
}

#[test]
fn finds_an_image_written_with_a_title() {
    let exec = TestExecutor::new();
    let (f, rec) = feedback(&exec, Reply::Status(202));
    let url = f.add_image(png("one"));
    let message = format!("![a]({url} \"Screenshot\") and ![](data:image/png;base64,cGl4ZWxz \"Pasted\")");
    assert_eq!(message_length(&message), "![a](attachment:img0) and ![](attachment:img0)".len());
    exec.block_on(f.send(msg(&message)));
    assert_eq!(body(&rec)["message"], "![a](attachment:img1) and ![](attachment:img2)");
    assert_eq!(attachment(&rec, "img2").unwrap(), "encoded:pixels");
}

#[test]
fn lets_go_of_the_images_a_draft_no_longer_shows() {
    let exec = TestExecutor::new();
    let (f, rec) = feedback(&exec, Reply::Status(202));
    let kept = f.add_image(png("kept"));
    f.add_image(png("deleted"));
    f.release_images(&format!("Look ![]({kept})"));
    assert_eq!(f.draft_image_urls(), vec![kept.clone()]);
    exec.block_on(f.send(msg(&format!("Look ![]({kept})"))));
    assert_eq!(attachment(&rec, "img1").unwrap(), "encoded:kept");
}

#[test]
fn leaves_image_syntax_inside_code_alone() {
    let exec = TestExecutor::new();
    let (f, rec) = feedback(&exec, Reply::Status(202));
    let url = f.add_image(png("one"));
    let data = format!("data:image/png;base64,{}", "A".repeat(8));
    let message = [
        format!("![]({url})"),
        String::new(),
        "```md".into(),
        format!("![](blob:example) and ![]({data})"),
        "```".into(),
        String::new(),
        "Inline `![](blob:inline)` too.".into(),
    ]
    .join("\n");
    assert_eq!(message_length(&message), message.len() - url.len() + "attachment:img0".len());
    exec.block_on(f.send(msg(&message)));
    assert_eq!(body(&rec)["message"], message.replacen(&url, "attachment:img1", 1));
    assert!(attachment(&rec, "img2").is_none());
}

#[test]
fn attaches_an_image_whose_title_holds_backticks() {
    let exec = TestExecutor::new();
    let (f, rec) = feedback(&exec, Reply::Status(202));
    let url = f.add_image(png("one"));
    exec.block_on(f.send(msg(&format!("See ![]({url} \"a `label`\") then `code`"))));
    assert_eq!(body(&rec)["message"], "See ![](attachment:img1) then `code`");
    assert_eq!(attachment(&rec, "img1").unwrap(), "encoded:one");
}

#[test]
fn the_module_registers_unavailable() {
    use notefig_core::{Core, CreateCoreOptions, ModuleRef};
    let exec = TestExecutor::new();
    let core = Core::new(CreateCoreOptions::new(exec.clone()).modules(vec![ModuleRef::of::<FeedbackModule>()])).unwrap();
    let f = core.use_::<FeedbackModule>();
    assert!(!f.available());
    assert_eq!(exec.block_on(f.send(msg("hello"))), FeedbackResult::Failed);
}
