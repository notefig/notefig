//! `directives.test.ts`.

use std::cell::RefCell;
use std::rc::Rc;

use notefig_agent::prompt::{PromptCommand, PromptConfigChange};

use crate::*;

fn ctx() -> DirectiveContext {
    DirectiveContext { workspace_path: "/ws".into(), task_id: Some("task_1".into()), harness_id: "claude-code".into() }
}

fn candidate(value: &str, label: &str, description: Option<&str>) -> DirectiveCandidate {
    DirectiveCandidate { value: value.into(), label: label.into(), description: description.map(Into::into) }
}

fn model() -> DirectiveNamespace {
    DirectiveNamespace {
        name: "model".into(),
        candidates: Box::new(|_| {
            vec![
                candidate("opus", "Opus", None),
                candidate("sonnet", "Sonnet", Some("Fast")),
                candidate("anthropic/haiku", "Haiku", None),
            ]
        }),
        resolve: Box::new(|values, _| DirectiveExtras {
            commands: None,
            config: Some(vec![PromptConfigChange { category: "model".into(), value: values.last().unwrap().clone() }]),
        }),
    }
}

fn skill() -> DirectiveNamespace {
    DirectiveNamespace {
        name: "skill".into(),
        candidates: Box::new(|_| vec![candidate("review", "review", None)]),
        resolve: Box::new(|values, _| DirectiveExtras {
            commands: Some(values.iter().map(|name| PromptCommand { name: name.clone() }).collect()),
            config: None,
        }),
    }
}

fn directives() -> (DirectivesApi, Vec<notefig_core::Subscription>) {
    let api = create_directives();
    let subs = vec![api.register(model()), api.register(skill())];
    (api, subs)
}

#[test]
fn takes_known_directives_out_of_the_text_and_asks_for_what_they_mean() {
    let (api, _subs) = directives();
    assert_eq!(
        api.resolve("@model:opus fix @notes.md then @skill:review it @model:sonnet", &ctx()),
        ResolvedPrompt {
            text: "fix @notes.md then it".into(),
            extras: DirectiveExtras {
                config: Some(vec![PromptConfigChange { category: "model".into(), value: "sonnet".into() }]),
                commands: Some(vec![PromptCommand { name: "review".into() }]),
            },
        }
    );
}

#[test]
fn leaves_tokens_that_name_nothing_as_text() {
    let (api, _subs) = directives();
    assert_eq!(
        api.resolve("use @model:nope and a@model:opus", &ctx()),
        ResolvedPrompt { text: "use @model:nope and a@model:opus".into(), extras: DirectiveExtras::default() }
    );
}

#[test]
fn keeps_the_text_of_a_prompt_that_was_only_settings_so_there_is_something_to_send() {
    let (api, _subs) = directives();
    assert_eq!(
        api.resolve("@model:opus", &ctx()),
        ResolvedPrompt {
            text: "@model:opus".into(),
            extras: DirectiveExtras {
                commands: None,
                config: Some(vec![PromptConfigChange { category: "model".into(), value: "opus".into() }]),
            },
        }
    );
    assert_eq!(api.resolve("@skill:review", &ctx()).text, "");
}

#[test]
fn hands_the_suggestion_each_namespace_as_a_source_bound_to_its_context_and_forgets_one_unregistered() {
    let api = create_directives();
    let seen: Rc<RefCell<Vec<DirectiveContext>>> = Rc::default();
    let s = seen.clone();
    let off = api.register(DirectiveNamespace {
        name: "effort".into(),
        candidates: Box::new(move |ctx| {
            s.borrow_mut().push(ctx.clone());
            vec![candidate("high", "High", None)]
        }),
        resolve: Box::new(|_, _| DirectiveExtras::default()),
    });
    let sources = api.sources(&ctx());
    assert_eq!(sources[0].name, "effort");
    assert_eq!((sources[0].candidates)(), vec![candidate("high", "High", None)]);
    assert_eq!(*seen.borrow(), vec![ctx()]);
    drop(off);
    assert!(api.sources(&ctx()).is_empty());
}

#[test]
fn an_unregister_leaves_a_namespace_that_took_its_name_since() {
    let api = create_directives();
    let first = api.register(model());
    let _second = api.register(model());
    drop(first);
    assert_eq!(api.sources(&ctx()).len(), 1);
}

#[test]
fn the_agent_directives_module_registers_model_and_skill() {
    use notefig_core::testing::TestExecutor;
    use notefig_core::{Core, CreateCoreOptions, ModuleRef, Services};
    use notefig_platform::PlatformService;
    use notefig_platform::fake::FakePlatform;
    // SAFETY: the only test in this binary that sets env.
    unsafe { std::env::set_var("NOTEFIG_NO_AGENTS", "1") };
    let fake = FakePlatform::new();
    let core = Core::new(
        CreateCoreOptions::new(TestExecutor::new())
            .services(Services::new().with::<PlatformService>(fake.platform.clone()))
            .modules(vec![ModuleRef::of::<AgentDirectivesModule>()]),
    )
    .unwrap();
    core.boot();
    let names: Vec<String> = core.use_::<DirectivesModule>().sources(&ctx()).into_iter().map(|s| s.name).collect();
    assert_eq!(names, vec!["model".to_string(), "skill".to_string()]);
}
