//! Prompt directives, `@<namespace>:<value>` in a composer (`@model:opus`,
//! `@skill:review`): a port of `packages/desktop/src/modules/directives/` —
//! `core.directives` — and of `modules/agents/agent-directives.ts`
//! ([`AgentDirectivesModule`], which registers `model` and `skill`).
//!
//! Directives are only text until the prompt is sent: then each namespace
//! turns the values it was given into what the prompt is sent with (a
//! setting to switch to, a command to run), and the tokens leave the text.
//! Namespaces register here from the modules that own what they offer.

pub mod agent_directives;
mod directives;
pub mod mentions;
#[cfg(test)]
mod tests;

use std::rc::Rc;

use notefig_agents::AgentStoreModule;
use notefig_core::{Module, ModuleContext, ModuleRef, Subscription};

pub use agent_directives::{DirectiveSources, setting_namespace, skill_namespace};
pub use directives::{
    DirectiveContext, DirectiveExtras, DirectiveNamespace, DirectivesApi, ResolvedPrompt, create_directives,
};
pub use mentions::{DirectiveCandidate, DirectiveSource, MentionSegment, extract_mention_paths, find_directive, segment_mentions};

/// `directivesModule`.
pub struct DirectivesModule;

impl Module for DirectivesModule {
    const NAME: &'static str = "directives";
    type Api = DirectivesApi;
    type Workspace = ();

    fn register(_: &ModuleContext) -> DirectivesApi {
        create_directives()
    }
}

/// `agentDirectivesModule`: `@model:` and `@skill:`.
pub struct AgentDirectivesModule;

impl Module for AgentDirectivesModule {
    const NAME: &'static str = "agentDirectives";
    type Api = ();
    type Workspace = ();

    fn needs() -> Vec<ModuleRef> {
        vec![ModuleRef::of::<DirectivesModule>(), ModuleRef::of::<AgentStoreModule>()]
    }

    fn register(_: &ModuleContext) {}

    fn boot(_: &Rc<()>, ctx: &ModuleContext) -> Option<Subscription> {
        let sources: Rc<dyn DirectiveSources> = ctx.use_::<AgentStoreModule>();
        let directives = ctx.use_::<DirectivesModule>();
        Some(Subscription::join(vec![
            directives.register(setting_namespace(sources.clone(), "model", "model")),
            directives.register(skill_namespace(sources)),
        ]))
    }
}
