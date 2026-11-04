//! `createDirectives`: the `@<namespace>:<value>` registry.

use std::cell::RefCell;
use std::rc::Rc;

use notefig_agent::prompt::{PromptCommand, PromptConfigChange, PromptExtras};
use notefig_core::Subscription;

use crate::mentions::{DirectiveCandidate, DirectiveSource, MentionSegment, find_directive, segment_mentions};

/// Where a directive is being picked or sent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectiveContext {
    pub workspace_path: String,
    /// The session the prompt goes to, if there is one yet.
    pub task_id: Option<String>,
    /// That session's harness, else the one a new session would use.
    pub harness_id: String,
}

/// What directives ask a prompt to be sent with (`Pick<PromptExtras,
/// "commands" | "config">`); `None` is the TS absent key.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct DirectiveExtras {
    pub commands: Option<Vec<PromptCommand>>,
    pub config: Option<Vec<PromptConfigChange>>,
}

impl DirectiveExtras {
    /// Onto a prompt's extras.
    pub fn into_prompt_extras(self, mut extras: PromptExtras) -> PromptExtras {
        extras.commands.extend(self.commands.unwrap_or_default());
        extras.config.extend(self.config.unwrap_or_default());
        extras
    }
}

/// A namespace as registered: what it offers in a context, and what its
/// values do to a prompt.
pub struct DirectiveNamespace {
    pub name: String,
    /// What can be picked now, read from live rows.
    pub candidates: Box<dyn Fn(&DirectiveContext) -> Vec<DirectiveCandidate>>,
    /// What a prompt is sent with for this namespace's values, in order.
    pub resolve: Box<dyn Fn(&[String], &DirectiveContext) -> DirectiveExtras>,
}

/// A finished prompt without its directives, and what they ask for.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedPrompt {
    pub text: String,
    pub extras: DirectiveExtras,
}

/// `DirectivesApi` — `core.directives`.
#[derive(Clone, Default)]
pub struct DirectivesApi {
    /// In registration order; re-registering a name keeps its place.
    namespaces: Rc<RefCell<Vec<Rc<DirectiveNamespace>>>>,
}

/// `createDirectives()`.
pub fn create_directives() -> DirectivesApi {
    DirectivesApi::default()
}

/// `text` without the mentions `is_directive` accepts, and those mentions
/// in order. A dropped token's following space goes with it.
fn strip_directives(text: &str, is_directive: &dyn Fn(&str) -> bool) -> (String, Vec<String>) {
    let mut tokens = Vec::new();
    let mut stripped = String::new();
    let mut drop_space = false;
    for segment in segment_mentions(text, is_directive) {
        match segment {
            MentionSegment::Mention(value) => {
                tokens.push(value);
                drop_space = stripped.is_empty() || stripped.ends_with(char::is_whitespace);
            }
            MentionSegment::Text(value) => {
                stripped.push_str(if drop_space { value.strip_prefix(' ').unwrap_or(&value) } else { &value });
                drop_space = false;
            }
        }
    }
    (stripped.trim().to_string(), tokens)
}

/// Every namespace's extras as one: lists concatenated, in order.
fn merge_extras(all: Vec<DirectiveExtras>) -> DirectiveExtras {
    let mut merged = DirectiveExtras::default();
    for extras in all {
        if let Some(commands) = extras.commands {
            merged.commands.get_or_insert_with(Vec::new).extend(commands);
        }
        if let Some(config) = extras.config {
            merged.config.get_or_insert_with(Vec::new).extend(config);
        }
    }
    merged
}

impl DirectivesApi {
    /// Register a namespace; dropping the subscription unregisters it
    /// (unless another took its name since).
    pub fn register(&self, namespace: DirectiveNamespace) -> Subscription {
        let namespace = Rc::new(namespace);
        {
            let mut list = self.namespaces.borrow_mut();
            match list.iter_mut().find(|n| n.name == namespace.name) {
                Some(slot) => *slot = namespace.clone(),
                None => list.push(namespace.clone()),
            }
        }
        let weak = Rc::downgrade(&self.namespaces);
        Subscription::new(move || {
            if let Some(list) = weak.upgrade() {
                list.borrow_mut().retain(|n| !Rc::ptr_eq(n, &namespace));
            }
        })
    }

    /// Every namespace as the "@" suggestion's source, in this context.
    pub fn sources(&self, ctx: &DirectiveContext) -> Vec<DirectiveSource> {
        self.namespaces
            .borrow()
            .iter()
            .map(|namespace| {
                let (namespace, ctx) = (namespace.clone(), ctx.clone());
                DirectiveSource {
                    name: namespace.name.clone(),
                    candidates: Rc::new(move || (namespace.candidates)(&ctx)),
                }
            })
            .collect()
    }

    /// A finished prompt without its directives, and what they ask it to be
    /// sent with. Tokens that name nothing stay as text; a prompt that was
    /// nothing but settings keeps its text.
    pub fn resolve(&self, text: &str, ctx: &DirectiveContext) -> ResolvedPrompt {
        let offered = self.sources(ctx);
        let (stripped, tokens) = strip_directives(text, &|token| find_directive(&offered, token).is_some());
        let mut values: Vec<(Rc<DirectiveNamespace>, Vec<String>)> = Vec::new();
        for token in tokens {
            let Some((source, value)) = find_directive(&offered, &token) else { continue };
            let Some(namespace) = self.namespaces.borrow().iter().find(|n| n.name == source.name).cloned() else {
                continue;
            };
            match values.iter_mut().find(|(n, _)| Rc::ptr_eq(n, &namespace)) {
                Some((_, list)) => list.push(value),
                None => values.push((namespace, vec![value])),
            }
        }
        let extras = merge_extras(values.iter().map(|(n, used)| (n.resolve)(used, ctx)).collect());
        let text = if !stripped.is_empty() || extras.commands.is_some() { stripped } else { text.to_string() };
        ResolvedPrompt { text, extras }
    }
}
