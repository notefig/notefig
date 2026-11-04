//! The agents' prompt directives: a port of
//! `modules/agents/agent-directives.ts`. `@model:<value>` picks the model a
//! prompt's turn runs on, `@skill:<name>` runs one of the harness's
//! commands or skills. What they offer is the session's own, as it last
//! reported it, else its harness's catalog.
//!
//! Deviation: TS keeps this in the agents module; here it lives beside the
//! registry so `notefig-agents` doesn't depend on `notefig-directives`
//! (module crates depend on agents, never the other way).

use std::rc::Rc;

use notefig_agent::harness::HarnessCatalog;
use notefig_agent::model::{AgentTaskRow, AvailableCommand, SessionConfigSelect};
use notefig_agent::prompt::{PromptCommand, PromptConfigChange};
use notefig_agents::AgentStore;
use notefig_agents::session_config::setting_choices;

use crate::directives::{DirectiveContext, DirectiveExtras, DirectiveNamespace};
use crate::mentions::DirectiveCandidate;

/// Where the offers come from: the task rows and the harness catalogs.
pub trait DirectiveSources {
    fn task(&self, task_id: &str) -> Option<AgentTaskRow>;
    fn harness_catalog(&self, harness_id: &str) -> Option<HarnessCatalog>;
}

impl DirectiveSources for AgentStore {
    fn task(&self, task_id: &str) -> Option<AgentTaskRow> {
        AgentStore::task(self, task_id)
    }
    fn harness_catalog(&self, harness_id: &str) -> Option<HarnessCatalog> {
        self.harness_rows().into_iter().find(|r| r.id == harness_id).and_then(|r| r.catalog)
    }
}

/// What the prompt's session offers: its own reports, else its harness's.
fn offer_of(sources: &dyn DirectiveSources, ctx: &DirectiveContext) -> (Vec<SessionConfigSelect>, Vec<AvailableCommand>) {
    let row = ctx.task_id.as_deref().and_then(|id| sources.task(id));
    let catalog = sources.harness_catalog(&ctx.harness_id);
    let config = match row.as_ref().and_then(|r| r.config_options.clone()).filter(|c| !c.is_empty()) {
        Some(own) => own,
        None => catalog.as_ref().and_then(|c| c.config_options.clone()).unwrap_or_default(),
    };
    let commands = match row.as_ref().and_then(|r| r.commands.clone()).filter(|c| !c.is_empty()) {
        Some(own) => own,
        None => catalog.and_then(|c| c.commands).unwrap_or_default(),
    };
    (config, commands)
}

/// A session setting as a namespace: its choices, switched to before the
/// prompt's turn (the last one given wins).
pub fn setting_namespace(sources: Rc<dyn DirectiveSources>, name: &str, category: &str) -> DirectiveNamespace {
    let (cat, cat2) = (category.to_string(), category.to_string());
    DirectiveNamespace {
        name: name.to_string(),
        candidates: Box::new(move |ctx| {
            let (config, _) = offer_of(&*sources, ctx);
            let Some(option) = config.iter().find(|o| o.category.as_deref() == Some(cat.as_str())) else {
                return Vec::new();
            };
            // Names only: their descriptions crowd the menu.
            setting_choices(option)
                .into_iter()
                .map(|c| DirectiveCandidate { value: c.value.clone(), label: c.name.clone(), description: None })
                .collect()
        }),
        resolve: Box::new(move |values, _| DirectiveExtras {
            commands: None,
            config: values
                .last()
                .map(|value| vec![PromptConfigChange { category: cat2.clone(), value: value.clone() }]),
        }),
    }
}

/// The harness's commands and skills, run with the prompt.
pub fn skill_namespace(sources: Rc<dyn DirectiveSources>) -> DirectiveNamespace {
    DirectiveNamespace {
        name: "skill".into(),
        candidates: Box::new(move |ctx| {
            offer_of(&*sources, ctx)
                .1
                .into_iter()
                .map(|c| DirectiveCandidate {
                    value: c.name.clone(),
                    label: c.name,
                    description: (!c.description.is_empty()).then_some(c.description),
                })
                .collect()
        }),
        resolve: Box::new(|values, _| DirectiveExtras {
            commands: Some(values.iter().map(|name| PromptCommand { name: name.clone() }).collect()),
            config: None,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn models(values: &[&str]) -> SessionConfigSelect {
        serde_json::from_value(json!({
            "id": "model", "name": "Model", "category": "model", "type": "select", "currentValue": values[0],
            "options": values.iter().map(|v| json!({"value": v, "name": v.to_uppercase()})).collect::<Vec<_>>(),
        }))
        .unwrap()
    }

    fn command(name: &str, description: &str) -> AvailableCommand {
        serde_json::from_value(json!({"name": name, "description": description})).unwrap()
    }

    struct Fake {
        row: Option<AgentTaskRow>,
        catalog: Option<HarnessCatalog>,
    }

    impl DirectiveSources for Fake {
        fn task(&self, id: &str) -> Option<AgentTaskRow> {
            (id == "task_1").then(|| self.row.clone()).flatten()
        }
        fn harness_catalog(&self, id: &str) -> Option<HarnessCatalog> {
            (id == "claude-code").then(|| self.catalog.clone()).flatten()
        }
    }

    fn row(config: Vec<SessionConfigSelect>, commands: Vec<AvailableCommand>) -> AgentTaskRow {
        let mut row: AgentTaskRow = serde_json::from_value(json!({
            "taskId": "task_1", "workspacePath": "/ws", "title": "t", "status": "idle",
            "harnessId": "claude-code", "createdAt": 0, "updatedAt": 0,
        }))
        .unwrap();
        row.config_options = Some(config);
        row.commands = Some(commands);
        row
    }

    fn sources(row: Option<AgentTaskRow>, catalog: Option<HarnessCatalog>) -> Rc<dyn DirectiveSources> {
        Rc::new(Fake { row, catalog })
    }

    fn live() -> DirectiveContext {
        DirectiveContext { workspace_path: "/ws".into(), task_id: Some("task_1".into()), harness_id: "claude-code".into() }
    }
    fn none() -> DirectiveContext {
        DirectiveContext { task_id: None, ..live() }
    }
    fn catalog() -> HarnessCatalog {
        HarnessCatalog { config_options: Some(vec![models(&["opus", "sonnet"])]), commands: Some(vec![command("init", "Set up")]) }
    }
    fn values(c: Vec<DirectiveCandidate>) -> Vec<String> {
        c.into_iter().map(|c| c.value).collect()
    }

    #[test]
    fn offers_the_sessions_own_models_and_skills_else_its_harnesss() {
        let own = sources(Some(row(vec![models(&["haiku"])], vec![command("review", "")])), Some(catalog()));
        let model = setting_namespace(own.clone(), "model", "model");
        assert_eq!(
            (model.candidates)(&live()),
            vec![DirectiveCandidate { value: "haiku".into(), label: "HAIKU".into(), description: None }]
        );
        assert_eq!(values((skill_namespace(own.clone()).candidates)(&live())), vec!["review"]);
        assert_eq!(values((model.candidates)(&none())), vec!["opus", "sonnet"]);
        assert_eq!(
            (skill_namespace(own).candidates)(&none()),
            vec![DirectiveCandidate { value: "init".into(), label: "init".into(), description: Some("Set up".into()) }]
        );
    }

    #[test]
    fn lists_models_by_name_alone_without_their_descriptions() {
        let described: SessionConfigSelect = serde_json::from_value(json!({
            "id": "model", "name": "Model", "category": "model", "type": "select", "currentValue": "opus",
            "options": [{"value": "opus", "name": "Opus", "description": "Most capable"}],
        }))
        .unwrap();
        let model = setting_namespace(sources(Some(row(vec![described], vec![])), None), "model", "model");
        assert_eq!(
            (model.candidates)(&live()),
            vec![DirectiveCandidate { value: "opus".into(), label: "Opus".into(), description: None }]
        );
    }

    #[test]
    fn offers_nothing_a_harness_hasnt_reported() {
        let model = setting_namespace(sources(None, None), "model", "model");
        assert!((model.candidates)(&none()).is_empty());
        assert!((skill_namespace(sources(None, None)).candidates)(&none()).is_empty());
    }

    #[test]
    fn asks_for_the_last_model_given_and_every_skill_in_order() {
        let model = setting_namespace(sources(None, None), "model", "model");
        let given = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            (model.resolve)(&given(&["opus", "sonnet"]), &live()),
            DirectiveExtras {
                commands: None,
                config: Some(vec![PromptConfigChange { category: "model".into(), value: "sonnet".into() }])
            }
        );
        assert_eq!(
            (skill_namespace(sources(None, None)).resolve)(&given(&["review", "init"]), &live()),
            DirectiveExtras {
                commands: Some(vec![PromptCommand { name: "review".into() }, PromptCommand { name: "init".into() }]),
                config: None
            }
        );
    }
}
