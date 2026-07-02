//! GitHub Copilot Tauri Commands
//!
//! Claude Science Switch does not manage GitHub Copilot OAuth accounts.
//! These commands remain registered for frontend compatibility, but they never
//! start OAuth flows, read stored tokens, or call Copilot official APIs.

use crate::proxy::providers::copilot_auth::{
    CopilotAuthManager, CopilotAuthStatus, CopilotModel, CopilotUsageResponse, GitHubAccount,
    GitHubDeviceCodeResponse,
};
use std::sync::Arc;
use tauri::State;
use tokio::sync::RwLock;

const COPILOT_AUTH_DISABLED_MESSAGE: &str =
    "GitHub Copilot managed OAuth is disabled in Claude Science Switch. Use a provider with explicit API settings instead.";

/// Copilot 认证状态
pub struct CopilotAuthState(pub Arc<RwLock<CopilotAuthManager>>);

fn copilot_auth_disabled() -> String {
    COPILOT_AUTH_DISABLED_MESSAGE.to_string()
}

#[tauri::command]
pub async fn copilot_start_device_flow(
    _github_domain: Option<String>,
    _state: State<'_, CopilotAuthState>,
) -> Result<GitHubDeviceCodeResponse, String> {
    Err(copilot_auth_disabled())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn copilot_poll_for_auth(
    _device_code: String,
    _github_domain: Option<String>,
    _state: State<'_, CopilotAuthState>,
) -> Result<bool, String> {
    Err(copilot_auth_disabled())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn copilot_poll_for_account(
    _device_code: String,
    _github_domain: Option<String>,
    _state: State<'_, CopilotAuthState>,
) -> Result<Option<GitHubAccount>, String> {
    Err(copilot_auth_disabled())
}

#[tauri::command]
pub async fn copilot_list_accounts(
    _state: State<'_, CopilotAuthState>,
) -> Result<Vec<GitHubAccount>, String> {
    Ok(vec![])
}

#[tauri::command(rename_all = "camelCase")]
pub async fn copilot_remove_account(
    _account_id: String,
    _state: State<'_, CopilotAuthState>,
) -> Result<(), String> {
    Err(copilot_auth_disabled())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn copilot_set_default_account(
    _account_id: String,
    _state: State<'_, CopilotAuthState>,
) -> Result<(), String> {
    Err(copilot_auth_disabled())
}

#[tauri::command]
pub async fn copilot_get_auth_status(
    _state: State<'_, CopilotAuthState>,
) -> Result<CopilotAuthStatus, String> {
    Ok(CopilotAuthStatus {
        authenticated: false,
        default_account_id: None,
        accounts: vec![],
        migration_error: Some(copilot_auth_disabled()),
        username: None,
        expires_at: None,
    })
}

#[tauri::command]
pub async fn copilot_is_authenticated(_state: State<'_, CopilotAuthState>) -> Result<bool, String> {
    Ok(false)
}

#[tauri::command]
pub async fn copilot_logout(_state: State<'_, CopilotAuthState>) -> Result<(), String> {
    Err(copilot_auth_disabled())
}

#[tauri::command]
pub async fn copilot_get_token(_state: State<'_, CopilotAuthState>) -> Result<String, String> {
    Err(copilot_auth_disabled())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn copilot_get_token_for_account(
    _account_id: String,
    _state: State<'_, CopilotAuthState>,
) -> Result<String, String> {
    Err(copilot_auth_disabled())
}

#[tauri::command]
pub async fn copilot_get_models(
    _state: State<'_, CopilotAuthState>,
) -> Result<Vec<CopilotModel>, String> {
    Err(copilot_auth_disabled())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn copilot_get_models_for_account(
    _account_id: String,
    _state: State<'_, CopilotAuthState>,
) -> Result<Vec<CopilotModel>, String> {
    Err(copilot_auth_disabled())
}

#[tauri::command]
pub async fn copilot_get_usage(
    _state: State<'_, CopilotAuthState>,
) -> Result<CopilotUsageResponse, String> {
    Err(copilot_auth_disabled())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn copilot_get_usage_for_account(
    _account_id: String,
    _state: State<'_, CopilotAuthState>,
) -> Result<CopilotUsageResponse, String> {
    Err(copilot_auth_disabled())
}
