use tauri::State;

use crate::commands::codex_oauth::CodexOAuthState;
use crate::commands::copilot::CopilotAuthState;

const AUTH_PROVIDER_GITHUB_COPILOT: &str = "github_copilot";
const AUTH_PROVIDER_CODEX_OAUTH: &str = "codex_oauth";
const MANAGED_AUTH_DISABLED_MESSAGE: &str =
    "Managed OAuth/Keychain accounts are disabled in Claude Science Switch. Use Science Proxy providers with explicit API settings instead.";

#[derive(Debug, Clone, serde::Serialize)]
pub struct ManagedAuthAccount {
    pub id: String,
    pub provider: String,
    pub login: String,
    pub avatar_url: Option<String>,
    pub authenticated_at: i64,
    pub is_default: bool,
    pub github_domain: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ManagedAuthStatus {
    pub provider: String,
    pub authenticated: bool,
    pub default_account_id: Option<String>,
    pub migration_error: Option<String>,
    pub accounts: Vec<ManagedAuthAccount>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ManagedAuthDeviceCodeResponse {
    pub provider: String,
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
    pub interval: u64,
}

fn ensure_auth_provider(auth_provider: &str) -> Result<&'static str, String> {
    match auth_provider {
        AUTH_PROVIDER_GITHUB_COPILOT => Ok(AUTH_PROVIDER_GITHUB_COPILOT),
        AUTH_PROVIDER_CODEX_OAUTH => Ok(AUTH_PROVIDER_CODEX_OAUTH),
        _ => Err(format!("Unsupported auth provider: {auth_provider}")),
    }
}

fn managed_auth_disabled() -> String {
    MANAGED_AUTH_DISABLED_MESSAGE.to_string()
}

fn disabled_status(provider: &str) -> ManagedAuthStatus {
    ManagedAuthStatus {
        provider: provider.to_string(),
        authenticated: false,
        default_account_id: None,
        migration_error: Some(managed_auth_disabled()),
        accounts: vec![],
    }
}

#[tauri::command(rename_all = "camelCase")]
pub async fn auth_start_login(
    auth_provider: String,
    _github_domain: Option<String>,
    _copilot_state: State<'_, CopilotAuthState>,
    _codex_state: State<'_, CodexOAuthState>,
) -> Result<ManagedAuthDeviceCodeResponse, String> {
    let _ = ensure_auth_provider(&auth_provider)?;
    Err(managed_auth_disabled())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn auth_poll_for_account(
    auth_provider: String,
    _device_code: String,
    _github_domain: Option<String>,
    _copilot_state: State<'_, CopilotAuthState>,
    _codex_state: State<'_, CodexOAuthState>,
) -> Result<Option<ManagedAuthAccount>, String> {
    let _ = ensure_auth_provider(&auth_provider)?;
    Err(managed_auth_disabled())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn auth_list_accounts(
    auth_provider: String,
    _copilot_state: State<'_, CopilotAuthState>,
    _codex_state: State<'_, CodexOAuthState>,
) -> Result<Vec<ManagedAuthAccount>, String> {
    let _ = ensure_auth_provider(&auth_provider)?;
    Ok(vec![])
}

#[tauri::command(rename_all = "camelCase")]
pub async fn auth_get_status(
    auth_provider: String,
    _copilot_state: State<'_, CopilotAuthState>,
    _codex_state: State<'_, CodexOAuthState>,
) -> Result<ManagedAuthStatus, String> {
    let auth_provider = ensure_auth_provider(&auth_provider)?;
    Ok(disabled_status(auth_provider))
}

#[tauri::command(rename_all = "camelCase")]
pub async fn auth_remove_account(
    auth_provider: String,
    _account_id: String,
    _copilot_state: State<'_, CopilotAuthState>,
    _codex_state: State<'_, CodexOAuthState>,
) -> Result<(), String> {
    let _ = ensure_auth_provider(&auth_provider)?;
    Err(managed_auth_disabled())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn auth_set_default_account(
    auth_provider: String,
    _account_id: String,
    _copilot_state: State<'_, CopilotAuthState>,
    _codex_state: State<'_, CodexOAuthState>,
) -> Result<(), String> {
    let _ = ensure_auth_provider(&auth_provider)?;
    Err(managed_auth_disabled())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn auth_logout(
    auth_provider: String,
    _copilot_state: State<'_, CopilotAuthState>,
    _codex_state: State<'_, CodexOAuthState>,
) -> Result<(), String> {
    let _ = ensure_auth_provider(&auth_provider)?;
    Err(managed_auth_disabled())
}
