//! `session-config.ts`.

use notefig_agent::model::{ConfigChoice, SessionConfigSelect};

/// A select setting's choices as one flat list, its groups opened up.
pub fn setting_choices(option: &SessionConfigSelect) -> Vec<&ConfigChoice> {
    option.choices()
}
