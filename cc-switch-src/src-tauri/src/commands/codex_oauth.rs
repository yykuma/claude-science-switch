//! Codex OAuth Tauri Commands
//!
//! Claude Science Switch keeps OpenAI Responses-compatible providers, but does
//! not manage ChatGPT/Codex OAuth accounts. These commands remain registered
//! for frontend compatibility and never read stored tokens or call ChatGPT APIs.

use crate::proxy::providers::codex_oauth_auth::CodexOAuthManager;
use crate::services::model_fetch::FetchedModel;
use crate::services::subscription::{CredentialStatus, SubscriptionQuota};
use std::sync::Arc;
use tauri::State;
use tokio::sync::RwLock;

const CODEX_OAUTH_DISABLED_MESSAGE: &str =
    "Codex OAuth managed accounts are disabled in Claude Science Switch. Use an OpenAI Responses-compatible provider with explicit API settings instead.";

/// Codex OAuth 认证状态
pub struct CodexOAuthState(pub Arc<RwLock<CodexOAuthManager>>);

fn codex_oauth_disabled() -> String {
    CODEX_OAUTH_DISABLED_MESSAGE.to_string()
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_codex_oauth_quota(
    _account_id: Option<String>,
    _state: State<'_, CodexOAuthState>,
) -> Result<SubscriptionQuota, String> {
    Ok(SubscriptionQuota::error(
        "codex_oauth",
        CredentialStatus::NotFound,
        codex_oauth_disabled(),
    ))
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_codex_oauth_models(
    _account_id: Option<String>,
    _state: State<'_, CodexOAuthState>,
) -> Result<Vec<FetchedModel>, String> {
    Err(codex_oauth_disabled())
}
