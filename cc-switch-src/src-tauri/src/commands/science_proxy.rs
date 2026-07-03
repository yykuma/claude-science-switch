#![allow(non_snake_case)]

use aes_gcm::aead::{AeadInPlace, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use chrono::{DateTime, Utc};
use hmac::{Hmac, Mac};
use once_cell::sync::Lazy;
use serde_json::{json, Value};
use std::fs;
use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;
use uuid::Uuid;

type HmacSha256 = Hmac<sha2::Sha256>;

static SCIENCE_PROXY_PROCESS: Lazy<Mutex<Option<ManagedScienceProxyProcess>>> =
    Lazy::new(|| Mutex::new(None));
static SCIENCE_APP_PROCESS: Lazy<Mutex<Option<ManagedScienceAppProcess>>> =
    Lazy::new(|| Mutex::new(None));

const SCIENCE_CONFIG_TOML: &str = r#"default_model = "claude-opus-4-8"

[llm]
kernel_default_model = "claude-haiku-4-5"
lineage_extraction_model = "claude-sonnet-4-6"
"#;
const SCIENCE_VIRTUAL_EMAIL: &str = "local-dev@localhost.invalid";
const SCIENCE_VIRTUAL_TOKEN_EXPIRY: &str = "2099-01-01T00:00:00.000Z";
const SCIENCE_PRELOAD_JS: &str = r##"const token = process.env.CS_PROXY_TOKEN || "";
const proxyBaseUrl = process.env.CS_PROXY_BASE_URL || process.env.ANTHROPIC_BASE_URL || "";
const runId = process.env.CS_PRELOAD_RUN_ID || "missing-run-id";
const stubExternalServices = process.env.CS_STUB_EXTERNAL_SERVICES !== "0";

process.env.ANTHROPIC_BASE_URL ||= proxyBaseUrl;
process.env.ANTHROPIC_AUTH_TOKEN ||= token;
process.env.ANTHROPIC_API_KEY ||= process.env.ANTHROPIC_AUTH_TOKEN;
console.error("[cs-switch-preload] loaded " + runId);

try {
  const originalFetch = globalThis.fetch;
  if (typeof originalFetch === "function") {
    globalThis.fetch = function(input, init) {
      const next = authorizeProxyFetch(input, init);
      const stub = maybeStubExternalFetch(input);
      if (stub) return Promise.resolve(stub);
      return originalFetch.call(this, next.input, next.init);
    };
  }
} catch (error) {
  console.error("[cs-switch-preload] fetch hook failed", error?.message || error);
}

try {
  blockExternalNodeHttp("http");
  blockExternalNodeHttp("https");
} catch (error) {
  console.error("[cs-switch-preload] http hook failed", error?.message || error);
}

try {
  blockExternalConnect("net");
  blockExternalConnect("tls");
} catch (error) {
  console.error("[cs-switch-preload] socket hook failed", error?.message || error);
}

try {
  const OriginalWebSocket = globalThis.WebSocket;
  if (typeof OriginalWebSocket === "function") {
    globalThis.WebSocket = new Proxy(OriginalWebSocket, {
      construct(target, args) {
        if (shouldBlockExternalUrl(args[0])) throw blockedExternalError();
        return Reflect.construct(target, args);
      },
      apply(target, thisArg, args) {
        if (shouldBlockExternalUrl(args[0])) throw blockedExternalError();
        return Reflect.apply(target, thisArg, args);
      }
    });
  }
} catch (error) {
  console.error("[cs-switch-preload] websocket hook failed", error?.message || error);
}

try {
  const OriginalEventSource = globalThis.EventSource;
  if (typeof OriginalEventSource === "function") {
    globalThis.EventSource = new Proxy(OriginalEventSource, {
      construct(target, args) {
        if (shouldBlockExternalUrl(args[0])) throw blockedExternalError();
        return Reflect.construct(target, args);
      }
    });
  }
} catch (error) {
  console.error("[cs-switch-preload] eventsource hook failed", error?.message || error);
}

function authorizeProxyFetch(input, init) {
  const raw = typeof input === "string" ? input : input?.url || input?.href || "";
  let proxyTarget = false;
  try {
    if (proxyBaseUrl) {
      const requestUrl = new URL(raw, proxyBaseUrl);
      const proxyUrl = new URL(proxyBaseUrl);
      proxyTarget = requestUrl.origin === proxyUrl.origin;
    }
  } catch {}

  if (!proxyTarget) return { input, init };

  const headers = new Headers(init?.headers || input?.headers || {});
  if (!headers.has("authorization") && !headers.has("x-api-key")) {
    headers.set("authorization", "Bearer " + token);
    headers.set("x-api-key", token);
  }
  return { input, init: { ...(init || {}), headers } };
}

function blockExternalNodeHttp(moduleName) {
  const mod = require(moduleName);
  for (const method of ["request", "get"]) {
    const original = mod?.[method];
    if (typeof original !== "function") continue;
    mod[method] = function(...args) {
      if (shouldBlockExternalUrl(args[0], args[1])) throw blockedExternalError();
      return original.apply(this, args);
    };
  }
}

function blockExternalConnect(moduleName) {
  const mod = require(moduleName);
  for (const method of ["connect", "createConnection"]) {
    const original = mod?.[method];
    if (typeof original !== "function") continue;
    mod[method] = function(...args) {
      if (shouldBlockExternalSocket(args[0], args[1])) throw blockedExternalError();
      return original.apply(this, args);
    };
  }
}

function shouldBlockExternalUrl(input, options) {
  if (!stubExternalServices) return false;
  const url = resolveRequestUrl(input, options);
  return !!url && (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "ws:" || url.protocol === "wss:") && !isAllowedLoopbackUrl(url);
}

function shouldBlockExternalSocket(input, options) {
  if (!stubExternalServices) return false;
  const host = resolveSocketHost(input, options);
  if (!host) return false;
  return !isAllowedLoopbackHost(host);
}

function resolveRequestUrl(input, options) {
  try {
    if (typeof input === "string" || input instanceof URL) return new URL(input, proxyBaseUrl || undefined);
    if (input?.href || input?.url) return new URL(input.href || input.url, proxyBaseUrl || undefined);
    const protocol = input?.protocol || options?.protocol || "http:";
    const hostname = input?.hostname || input?.host || options?.hostname || options?.host;
    if (!hostname) return null;
    const port = input?.port || options?.port || "";
    const path = input?.path || input?.pathname || options?.path || options?.pathname || "/";
    return new URL(`${protocol}//${hostname}${port ? `:${port}` : ""}${path}`);
  } catch {
    return null;
  }
}

function resolveSocketHost(input, options) {
  if (typeof input === "string") return input;
  if (typeof input === "number") return options?.host || options?.hostname || "127.0.0.1";
  return input?.host || input?.hostname || options?.host || options?.hostname || null;
}

function blockedExternalError() {
  const error = new Error("External network access is disabled for the isolated managed profile.");
  error.code = "CS_SWITCH_EXTERNAL_NETWORK_BLOCKED";
  return error;
}

function maybeStubExternalFetch(input) {
  if (!stubExternalServices) return null;
  const raw = typeof input === "string" ? input : input?.url || input?.href || "";
  let url;
  try {
    url = new URL(raw, proxyBaseUrl || undefined);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (isAllowedLoopbackUrl(url)) return null;
  return new Response(JSON.stringify({
    error: {
      type: "blocked_by_claude_science_switch",
      message: "External HTTP(S) access is disabled for the isolated managed profile."
    }
  }), {
    status: 403,
    headers: { "content-type": "application/json" }
  });
}

function isAllowedLoopbackUrl(url) {
  if (isAllowedLoopbackHost(url.hostname)) {
    return true;
  }
  if (!proxyBaseUrl) return false;
  try {
    return url.origin === new URL(proxyBaseUrl).origin;
  } catch {
    return false;
  }
}

function isAllowedLoopbackHost(hostname) {
  const normalized = String(hostname || "").toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}
"##;

#[derive(Debug)]
struct ManagedScienceProxyProcess {
    child: Child,
    process_group_id: Option<i32>,
    base_url: String,
    admin_token: String,
    client_token: String,
    config_path: String,
    cli_path: String,
    provider: Option<String>,
}

#[derive(Debug)]
struct ManagedScienceAppProcess {
    child: Child,
    process_group_id: Option<i32>,
    base_url: String,
    client_token: String,
    profile_root: String,
    data_dir: String,
    config_path: String,
    cli_path: String,
    web_url: Option<String>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScienceProxyProcessStatus {
    pub managed: bool,
    pub running: bool,
    pub pid: Option<u32>,
    pub base_url: String,
    pub admin_token: String,
    pub client_token: String,
    pub config_path: Option<String>,
    pub cli_path: Option<String>,
    pub provider: Option<String>,
    pub exit_status: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScienceAppProcessStatus {
    pub managed: bool,
    pub running: bool,
    pub pid: Option<u32>,
    pub base_url: String,
    pub client_token: String,
    pub profile_root: Option<String>,
    pub data_dir: Option<String>,
    pub config_path: Option<String>,
    pub cli_path: Option<String>,
    pub web_url: Option<String>,
    pub exit_status: Option<String>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScienceProxyPreflightReport {
    pub ok: bool,
    pub warnings: usize,
    pub checks: Vec<ScienceProxyPreflightCheck>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScienceProxyPreflightCheck {
    pub id: String,
    pub label: String,
    pub status: String,
    pub detail: String,
    pub path: Option<String>,
}

#[derive(Debug, Clone)]
struct ScienceAppProfilePaths {
    root: PathBuf,
    home: PathBuf,
    xdg_config: PathBuf,
    xdg_data: PathBuf,
    xdg_cache: PathBuf,
    tmp: PathBuf,
    auth_dir: PathBuf,
    data_dir: PathBuf,
    config_path: PathBuf,
    bunfig_path: PathBuf,
    preload_path: PathBuf,
}

struct ManagedSmokeChild {
    child: Child,
    process_group_id: Option<i32>,
}

pub fn run_science_proxy_managed_smoke_cli() -> Result<(), String> {
    let smoke_root =
        std::env::temp_dir().join(format!("cs-switch-managed-smoke-{}", Uuid::new_v4()));
    let smoke_home = smoke_root.join("home-root");
    fs::create_dir_all(&smoke_home).map_err(|err| {
        format!(
            "Could not create smoke home {}: {err}",
            smoke_home.display()
        )
    })?;
    std::env::set_var("CC_SWITCH_TEST_HOME", &smoke_home);

    let mut proxy_child: Option<ManagedSmokeChild> = None;
    let mut science_child: Option<ManagedSmokeChild> = None;
    let result = (|| -> Result<String, String> {
        let resources = locate_packaged_science_switch_resources()?;
        let proxy_bin = resources.join("bin").join(native_proxy_binary_name());
        let config_path = resources.join("examples").join("cliproxy-gpt55.json");
        if !proxy_bin.is_file() {
            return Err(format!(
                "Bundled Science proxy binary is missing: {}",
                proxy_bin.display()
            ));
        }
        if !config_path.is_file() {
            return Err(format!(
                "Bundled Science proxy config is missing: {}",
                config_path.display()
            ));
        }

        let port = find_available_loopback_port()?;
        let base_url = format!("http://127.0.0.1:{port}");
        let admin_token = normalize_admin_token(None);
        let client_token = generate_client_token();
        let proxy_log = smoke_root.join("science-proxy.log");
        let (stdout, stderr) = process_log_stdio(&proxy_log);
        let mut proxy_command = Command::new(&proxy_bin);
        proxy_command
            .arg("serve")
            .arg("--config")
            .arg(&config_path)
            .arg("--host")
            .arg("127.0.0.1")
            .arg("--port")
            .arg(port.to_string())
            .arg("--client-token")
            .arg(&client_token)
            .env("CLAUDE_SCIENCE_SWITCH_ADMIN_TOKEN", &admin_token)
            .current_dir(&smoke_root)
            .stdin(Stdio::null())
            .stdout(stdout)
            .stderr(stderr);
        configure_managed_process_group(&mut proxy_command);
        let proxy = proxy_command
            .spawn()
            .map_err(|err| format!("Could not start bundled Science proxy: {err}"))?;
        proxy_child = Some(ManagedSmokeChild {
            process_group_id: managed_process_group_id(&proxy),
            child: proxy,
        });
        wait_for_proxy_health(port, Duration::from_secs(12))?;

        let science_cli = resolve_science_cli_path(None)?;
        let paths =
            prepare_science_app_profile_at(smoke_root.join("science-app-profile"), &client_token)?;
        reset_science_app_log(&paths)?;
        let preload_run_id = generate_preload_run_id();
        let (stdout, stderr) = science_app_log_stdio(&paths);
        let mut science_command = Command::new(&science_cli);
        science_command
            .arg("serve")
            .arg("--data-dir")
            .arg(&paths.data_dir)
            .arg("--config")
            .arg(&paths.config_path)
            .arg("--no-browser")
            .arg("--no-auto-update")
            .arg("--port")
            .arg("0")
            .arg("--sandbox-port")
            .arg("0")
            .current_dir(&paths.root)
            .stdin(Stdio::null())
            .stdout(stdout)
            .stderr(stderr);
        apply_science_process_env(
            &mut science_command,
            &paths,
            &base_url,
            &client_token,
            &preload_run_id,
        );
        configure_managed_process_group(&mut science_command);
        let science = science_command
            .spawn()
            .map_err(|err| format!("Could not start Claude Science for smoke test: {err}"))?;
        science_child = Some(ManagedSmokeChild {
            process_group_id: managed_process_group_id(&science),
            child: science,
        });

        let web_url = wait_for_science_loopback_url(
            &science_cli,
            &paths,
            &base_url,
            &client_token,
            &preload_run_id,
            Duration::from_secs(18),
        )?;
        Ok(format!(
            "science-proxy-managed-smoke: ok\nproxy: {base_url}\nscienceUrl: {web_url}\nprofile: {}",
            paths.root.display()
        ))
    })();

    if let Some(mut child) = science_child {
        stop_managed_child(&mut child.child, child.process_group_id);
    }
    if let Some(mut child) = proxy_child {
        stop_managed_child(&mut child.child, child.process_group_id);
    }

    match result {
        Ok(message) => {
            println!("{message}");
            Ok(())
        }
        Err(error) => Err(format!("{error}; smokeRoot={}", smoke_root.display())),
    }
}

#[tauri::command]
pub async fn get_science_proxy_process_status() -> Result<ScienceProxyProcessStatus, String> {
    let mut guard = SCIENCE_PROXY_PROCESS
        .lock()
        .map_err(|_| "Science proxy process lock poisoned".to_string())?;
    Ok(status_from_guard(&mut guard))
}

#[tauri::command]
pub async fn get_science_app_process_status() -> Result<ScienceAppProcessStatus, String> {
    let mut guard = SCIENCE_APP_PROCESS
        .lock()
        .map_err(|_| "Claude Science process lock poisoned".to_string())?;
    Ok(status_from_science_app_guard(&mut guard))
}

#[tauri::command]
pub async fn launch_science_app_with_proxy(
    app: tauri::AppHandle,
    base_url: Option<String>,
    client_token: Option<String>,
    science_cli_path: Option<String>,
    open_browser: Option<bool>,
) -> Result<ScienceAppProcessStatus, String> {
    let (_, _, normalized_base_url) =
        parse_loopback_base_url(base_url.as_deref().unwrap_or("http://127.0.0.1:17777"))?;
    let client_token = normalize_client_token(client_token);
    let open_browser = open_browser.unwrap_or(true);

    let existing = {
        let mut guard = SCIENCE_APP_PROCESS
            .lock()
            .map_err(|_| "Claude Science process lock poisoned".to_string())?;
        let status = status_from_science_app_guard(&mut guard);
        if status.running
            && status.base_url == normalized_base_url
            && status.client_token == client_token
        {
            Some(status)
        } else {
            if status.running {
                stop_locked_science_app_process(&mut guard);
            }
            None
        }
    };

    if let Some(status) = existing {
        return open_fresh_science_app_url(&app, status, open_browser);
    }

    let cli_path = resolve_science_cli_path(science_cli_path)?;
    let paths = prepare_science_app_profile(&app, &client_token)?;
    reset_science_app_log(&paths)?;
    let preload_run_id = generate_preload_run_id();
    let (stdout, stderr) = science_app_log_stdio(&paths);
    let mut command = Command::new(&cli_path);
    command
        .arg("serve")
        .arg("--data-dir")
        .arg(&paths.data_dir)
        .arg("--config")
        .arg(&paths.config_path)
        .arg("--no-browser")
        .arg("--no-auto-update")
        .arg("--port")
        .arg("0")
        .arg("--sandbox-port")
        .arg("0")
        .current_dir(&paths.root)
        .stdin(Stdio::null())
        .stdout(stdout)
        .stderr(stderr);
    apply_science_process_env(
        &mut command,
        &paths,
        &normalized_base_url,
        &client_token,
        &preload_run_id,
    );
    configure_managed_process_group(&mut command);

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let child = command
        .spawn()
        .map_err(|e| format!("Failed to start Claude Science: {e}"))?;
    let process_group_id = managed_process_group_id(&child);

    {
        let mut guard = SCIENCE_APP_PROCESS
            .lock()
            .map_err(|_| "Claude Science process lock poisoned".to_string())?;
        *guard = Some(ManagedScienceAppProcess {
            child,
            process_group_id,
            base_url: normalized_base_url.clone(),
            client_token: client_token.clone(),
            profile_root: paths.root.to_string_lossy().to_string(),
            data_dir: paths.data_dir.to_string_lossy().to_string(),
            config_path: paths.config_path.to_string_lossy().to_string(),
            cli_path: cli_path.to_string_lossy().to_string(),
            web_url: None,
        });
    }

    for _ in 0..50 {
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        let last_status = get_science_app_process_status().await?;
        if !last_status.running {
            return Ok(last_status);
        }
        if science_preload_loaded(&paths, &preload_run_id) {
            if let Ok(status) = open_fresh_science_app_url(&app, last_status.clone(), open_browser)
            {
                return Ok(status);
            }
        } else if last_status.running && open_browser {
            log::debug!(
                "Waiting for Claude Science preload marker {preload_run_id} in {} before opening browser",
                paths.root.join("serve.log").display()
            );
        }
        if !open_browser {
            if let Ok(status) = open_fresh_science_app_url(&app, last_status.clone(), false) {
                return Ok(status);
            }
        }
    }

    Err(format!(
        "Claude Science started but did not provide a loopback login URL with loaded preload marker {preload_run_id} within 15s. Check {}",
        paths.root.join("serve.log").display()
    ))
}

#[tauri::command]
pub async fn stop_science_app_process() -> Result<ScienceAppProcessStatus, String> {
    let mut guard = SCIENCE_APP_PROCESS
        .lock()
        .map_err(|_| "Claude Science process lock poisoned".to_string())?;
    stop_locked_science_app_process(&mut guard);
    Ok(status_from_science_app_guard(&mut guard))
}

#[tauri::command]
pub async fn open_science_proxy_config_folder(app: tauri::AppHandle) -> Result<bool, String> {
    let config_dir = ensure_science_proxy_config_dir(&app)?;
    app.opener()
        .open_path(config_dir.to_string_lossy().to_string(), None::<String>)
        .map_err(|err| format!("Could not open Science proxy config folder: {err}"))?;
    Ok(true)
}

#[tauri::command]
pub async fn open_science_app_profile_folder(app: tauri::AppHandle) -> Result<bool, String> {
    let paths =
        science_app_profile_paths(crate::config::get_app_config_dir().join("science-app-profile"));
    guard_science_app_profile_path(&paths.root)?;
    create_science_managed_dir(&paths.root, &paths.root)?;
    guard_science_app_profile_path(&paths.root)?;
    app.opener()
        .open_path(paths.root.to_string_lossy().to_string(), None::<String>)
        .map_err(|err| format!("Could not open Claude Science managed profile folder: {err}"))?;
    Ok(true)
}

#[tauri::command]
pub async fn run_science_proxy_preflight(
    app: tauri::AppHandle,
    base_url: Option<String>,
    config_path: Option<String>,
    cli_path: Option<String>,
) -> Result<ScienceProxyPreflightReport, String> {
    let mut checks = Vec::new();

    match parse_loopback_base_url(base_url.as_deref().unwrap_or("http://127.0.0.1:17777")) {
        Ok((_, port, normalized_base_url)) => {
            checks.push(preflight_check(
                "loopback-url",
                "Loopback proxy URL",
                "pass",
                format!("{normalized_base_url} is a local HTTP endpoint"),
                None,
            ));

            let managed_status = {
                let mut guard = SCIENCE_PROXY_PROCESS
                    .lock()
                    .map_err(|_| "Science proxy process lock poisoned".to_string())?;
                status_from_guard(&mut guard)
            };
            let port_open = tcp_port_open(port);
            if managed_status.managed && managed_status.running {
                checks.push(preflight_check(
                    "proxy-port",
                    "Proxy port ownership",
                    "pass",
                    format!(
                        "Managed proxy is running at {} (pid {})",
                        managed_status.base_url,
                        managed_status
                            .pid
                            .map(|pid| pid.to_string())
                            .unwrap_or_else(|| "-".to_string())
                    ),
                    None,
                ));
            } else if port_open {
                checks.push(preflight_check(
                    "proxy-port",
                    "Proxy port ownership",
                    "warn",
                    format!(
                        "Port {port} is reachable but is not managed by this app; Start Managed Proxy will replace or reject that port before launching Claude Science"
                    ),
                    None,
                ));
            } else {
                checks.push(preflight_check(
                    "proxy-port",
                    "Proxy port ownership",
                    "pass",
                    format!("Port {port} is free for a managed proxy"),
                    None,
                ));
            }
        }
        Err(err) => checks.push(preflight_check(
            "loopback-url",
            "Loopback proxy URL",
            "fail",
            err,
            None,
        )),
    }

    match ensure_science_proxy_config_dir(&app) {
        Ok(config_dir) => checks.push(preflight_check(
            "config-dir",
            "Science proxy config directory",
            "pass",
            "Config templates are available".to_string(),
            Some(config_dir),
        )),
        Err(err) => checks.push(preflight_check(
            "config-dir",
            "Science proxy config directory",
            "fail",
            err,
            None,
        )),
    }

    match resolve_config_path(&app, config_path) {
        Ok(path) => {
            let config_text = fs::read_to_string(&path).unwrap_or_default();
            checks.push(preflight_check(
                "proxy-config",
                "Active proxy config",
                "pass",
                "Config file resolved".to_string(),
                Some(path.clone()),
            ));
            if config_text.contains("127.0.0.1:8317") || config_text.contains("localhost:8317") {
                checks.push(if tcp_port_open(8317) {
                    preflight_check(
                        "cliproxyapi",
                        "cliproxyapi upstream",
                        "pass",
                        "127.0.0.1:8317 is reachable".to_string(),
                        None,
                    )
                } else {
                    preflight_check(
                        "cliproxyapi",
                        "cliproxyapi upstream",
                        "warn",
                        "Config points to 127.0.0.1:8317, but no service is listening".to_string(),
                        None,
                    )
                });
            }
        }
        Err(err) => checks.push(preflight_check(
            "proxy-config",
            "Active proxy config",
            "fail",
            err,
            None,
        )),
    }

    match resolve_cli_path(&app, cli_path) {
        Ok(path) if path.is_file() => checks.push(preflight_check(
            "proxy-cli",
            "Bundled proxy executable",
            "pass",
            "Proxy executable resolved".to_string(),
            Some(path),
        )),
        Ok(path) => checks.push(preflight_check(
            "proxy-cli",
            "Bundled proxy executable",
            "warn",
            "Proxy executable was not found on disk; runtime will rely on PATH".to_string(),
            Some(path),
        )),
        Err(err) => checks.push(preflight_check(
            "proxy-cli",
            "Bundled proxy executable",
            "fail",
            err,
            None,
        )),
    }

    match resolve_science_cli_path(None) {
        Ok(path) => checks.push(preflight_check(
            "science-cli",
            "Claude Science CLI",
            "pass",
            "Claude Science CLI resolved".to_string(),
            Some(path),
        )),
        Err(err) => checks.push(preflight_check(
            "science-cli",
            "Claude Science CLI",
            "fail",
            err,
            None,
        )),
    }

    let profile_root = crate::config::get_app_config_dir().join("science-app-profile");
    match guard_science_app_profile_path(&profile_root) {
        Ok(()) => checks.push(preflight_check(
            "science-profile",
            "Managed Science profile",
            "pass",
            "Managed profile path is isolated from real Claude/Claude Science profiles".to_string(),
            Some(profile_root),
        )),
        Err(err) => checks.push(preflight_check(
            "science-profile",
            "Managed Science profile",
            "fail",
            err,
            Some(profile_root),
        )),
    }

    let warnings = checks.iter().filter(|check| check.status == "warn").count();
    let ok = checks.iter().all(|check| check.status != "fail");
    Ok(ScienceProxyPreflightReport {
        ok,
        warnings,
        checks,
    })
}

#[tauri::command]
pub async fn start_science_proxy_process(
    app: tauri::AppHandle,
    base_url: Option<String>,
    admin_token: Option<String>,
    config_path: Option<String>,
    cli_path: Option<String>,
    provider: Option<String>,
) -> Result<ScienceProxyProcessStatus, String> {
    let explicit_admin_token = admin_token
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);
    let requested_provider = normalize_provider_override(provider.as_deref());
    let (host, port, normalized_base_url) =
        parse_loopback_base_url(base_url.as_deref().unwrap_or("http://127.0.0.1:17777"))?;
    let admin_token = normalize_admin_token(admin_token);
    let client_token = generate_client_token();
    let config_path = resolve_config_path(&app, config_path)?;
    let cli_path = resolve_cli_path(&app, cli_path)?;

    let mut guard = SCIENCE_PROXY_PROCESS
        .lock()
        .map_err(|_| "Science proxy process lock poisoned".to_string())?;
    let existing = status_from_guard(&mut guard);
    if existing.running {
        let admin_matches = explicit_admin_token
            .as_ref()
            .map(|token| existing.admin_token == *token)
            .unwrap_or(true);
        if existing.base_url == normalized_base_url
            && existing.provider == requested_provider
            && admin_matches
        {
            return Ok(existing);
        }
        stop_locked_process(&mut guard);
    }

    let mut command = build_proxy_command(&app, &cli_path)?;
    let (stdout, stderr) = managed_process_log_stdio("science-proxy.log");
    command
        .arg("serve")
        .arg("--config")
        .arg(&config_path)
        .arg("--host")
        .arg(&host)
        .arg("--port")
        .arg(port.to_string())
        .arg("--client-token")
        .arg(&client_token)
        .env("CLAUDE_SCIENCE_SWITCH_ADMIN_TOKEN", &admin_token)
        .stdin(Stdio::null())
        .stdout(stdout)
        .stderr(stderr);
    if let Some(provider) = requested_provider.as_deref() {
        command.arg("--provider").arg(provider);
    }
    configure_managed_process_group(&mut command);

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let child = command
        .spawn()
        .map_err(|e| format!("Failed to start claude-science-switch: {e}"))?;
    let process_group_id = managed_process_group_id(&child);

    *guard = Some(ManagedScienceProxyProcess {
        child,
        process_group_id,
        base_url: normalized_base_url,
        admin_token,
        client_token,
        config_path: config_path.to_string_lossy().to_string(),
        cli_path: cli_path.to_string_lossy().to_string(),
        provider: requested_provider,
    });

    Ok(status_from_guard(&mut guard))
}

#[tauri::command]
pub async fn stop_science_proxy_process() -> Result<ScienceProxyProcessStatus, String> {
    let mut guard = SCIENCE_PROXY_PROCESS
        .lock()
        .map_err(|_| "Science proxy process lock poisoned".to_string())?;
    stop_locked_process(&mut guard);
    Ok(status_from_guard(&mut guard))
}

pub fn stop_managed_science_proxy_process() -> Result<(), String> {
    let mut guard = SCIENCE_PROXY_PROCESS
        .lock()
        .map_err(|_| "Science proxy process lock poisoned".to_string())?;
    stop_locked_process(&mut guard);
    Ok(())
}

pub fn stop_managed_science_app_process() -> Result<(), String> {
    let mut guard = SCIENCE_APP_PROCESS
        .lock()
        .map_err(|_| "Claude Science process lock poisoned".to_string())?;
    stop_locked_science_app_process(&mut guard);
    Ok(())
}

fn status_from_guard(guard: &mut Option<ManagedScienceProxyProcess>) -> ScienceProxyProcessStatus {
    let status = match guard.as_mut() {
        Some(process) => process.child.try_wait(),
        None => {
            return ScienceProxyProcessStatus {
                managed: false,
                running: false,
                pid: None,
                base_url: "http://127.0.0.1:17777".to_string(),
                admin_token: String::new(),
                client_token: String::new(),
                config_path: None,
                cli_path: None,
                provider: None,
                exit_status: None,
            };
        }
    };

    match status {
        Ok(Some(status)) => {
            let process = guard.take().expect("science proxy process existed");
            ScienceProxyProcessStatus {
                managed: false,
                running: false,
                pid: None,
                base_url: process.base_url,
                admin_token: process.admin_token,
                client_token: process.client_token,
                config_path: Some(process.config_path),
                cli_path: Some(process.cli_path),
                provider: process.provider,
                exit_status: Some(status.to_string()),
            }
        }
        Ok(None) => {
            let process = guard.as_mut().expect("science proxy process existed");
            ScienceProxyProcessStatus {
                managed: true,
                running: true,
                pid: Some(process.child.id()),
                base_url: process.base_url.clone(),
                admin_token: process.admin_token.clone(),
                client_token: process.client_token.clone(),
                config_path: Some(process.config_path.clone()),
                cli_path: Some(process.cli_path.clone()),
                provider: process.provider.clone(),
                exit_status: None,
            }
        }
        Err(err) => {
            let process = guard.take().expect("science proxy process existed");
            ScienceProxyProcessStatus {
                managed: false,
                running: false,
                pid: None,
                base_url: process.base_url,
                admin_token: process.admin_token,
                client_token: process.client_token,
                config_path: Some(process.config_path),
                cli_path: Some(process.cli_path),
                provider: process.provider,
                exit_status: Some(format!("status error: {err}")),
            }
        }
    }
}

fn status_from_science_app_guard(
    guard: &mut Option<ManagedScienceAppProcess>,
) -> ScienceAppProcessStatus {
    let status = match guard.as_mut() {
        Some(process) => process.child.try_wait(),
        None => {
            return ScienceAppProcessStatus {
                managed: false,
                running: false,
                pid: None,
                base_url: "http://127.0.0.1:17777".to_string(),
                client_token: String::new(),
                profile_root: None,
                data_dir: None,
                config_path: None,
                cli_path: None,
                web_url: None,
                exit_status: None,
            };
        }
    };

    match status {
        Ok(Some(status)) => {
            let process = guard.take().expect("science app process existed");
            ScienceAppProcessStatus {
                managed: false,
                running: false,
                pid: None,
                base_url: process.base_url,
                client_token: process.client_token,
                profile_root: Some(process.profile_root),
                data_dir: Some(process.data_dir),
                config_path: Some(process.config_path),
                cli_path: Some(process.cli_path),
                web_url: process.web_url,
                exit_status: Some(status.to_string()),
            }
        }
        Ok(None) => {
            let process = guard.as_mut().expect("science app process existed");
            ScienceAppProcessStatus {
                managed: true,
                running: true,
                pid: Some(process.child.id()),
                base_url: process.base_url.clone(),
                client_token: process.client_token.clone(),
                profile_root: Some(process.profile_root.clone()),
                data_dir: Some(process.data_dir.clone()),
                config_path: Some(process.config_path.clone()),
                cli_path: Some(process.cli_path.clone()),
                web_url: process.web_url.clone(),
                exit_status: None,
            }
        }
        Err(err) => {
            let process = guard.take().expect("science app process existed");
            ScienceAppProcessStatus {
                managed: false,
                running: false,
                pid: None,
                base_url: process.base_url,
                client_token: process.client_token,
                profile_root: Some(process.profile_root),
                data_dir: Some(process.data_dir),
                config_path: Some(process.config_path),
                cli_path: Some(process.cli_path),
                web_url: process.web_url,
                exit_status: Some(format!("status error: {err}")),
            }
        }
    }
}

fn stop_locked_process(guard: &mut Option<ManagedScienceProxyProcess>) {
    if let Some(mut process) = guard.take() {
        stop_managed_child(&mut process.child, process.process_group_id);
    }
}

fn stop_locked_science_app_process(guard: &mut Option<ManagedScienceAppProcess>) {
    if let Some(mut process) = guard.take() {
        stop_managed_child(&mut process.child, process.process_group_id);
    }
}

fn stop_managed_child(child: &mut Child, process_group_id: Option<i32>) {
    if matches!(child.try_wait(), Ok(Some(_))) {
        return;
    }

    if process_group_id.is_none() {
        let _ = child.kill();
        let _ = child.wait();
        return;
    }

    terminate_process_group(process_group_id);
    if wait_child_for(child, Duration::from_millis(1200)) {
        return;
    }

    kill_process_group(process_group_id);
    let _ = child.kill();
    let _ = child.wait();
}

fn wait_child_for(child: &mut Child, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if matches!(child.try_wait(), Ok(Some(_))) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[cfg(unix)]
fn configure_managed_process_group(command: &mut Command) {
    use std::os::unix::process::CommandExt;

    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                Err(std::io::Error::last_os_error())
            } else {
                Ok(())
            }
        });
    }
}

#[cfg(not(unix))]
fn configure_managed_process_group(_command: &mut Command) {}

#[cfg(unix)]
fn managed_process_group_id(child: &Child) -> Option<i32> {
    Some(child.id() as i32)
}

#[cfg(not(unix))]
fn managed_process_group_id(_child: &Child) -> Option<i32> {
    None
}

#[cfg(unix)]
fn terminate_process_group(process_group_id: Option<i32>) {
    if let Some(pgid) = process_group_id {
        unsafe {
            let _ = libc::kill(-pgid, libc::SIGTERM);
        }
    }
}

#[cfg(not(unix))]
fn terminate_process_group(_process_group_id: Option<i32>) {}

#[cfg(unix)]
fn kill_process_group(process_group_id: Option<i32>) {
    if let Some(pgid) = process_group_id {
        unsafe {
            let _ = libc::kill(-pgid, libc::SIGKILL);
        }
    }
}

#[cfg(not(unix))]
fn kill_process_group(_process_group_id: Option<i32>) {}

fn normalize_admin_token(value: Option<String>) -> String {
    let trimmed = value.unwrap_or_default().trim().to_string();
    if trimmed.len() >= 16 {
        trimmed
    } else {
        format!("science-switch-{}", Uuid::new_v4())
    }
}

fn generate_client_token() -> String {
    format!("science-client-{}-{}", Uuid::new_v4(), Uuid::new_v4())
}

fn normalize_client_token(value: Option<String>) -> String {
    let trimmed = value.unwrap_or_default().trim().to_string();
    if trimmed.is_empty() {
        generate_client_token()
    } else {
        trimmed
    }
}

fn generate_preload_run_id() -> String {
    format!("science-preload-{}", Uuid::new_v4())
}

fn preflight_check(
    id: &str,
    label: &str,
    status: &str,
    detail: String,
    path: Option<PathBuf>,
) -> ScienceProxyPreflightCheck {
    ScienceProxyPreflightCheck {
        id: id.to_string(),
        label: label.to_string(),
        status: status.to_string(),
        detail,
        path: path.map(|path| path.to_string_lossy().to_string()),
    }
}

fn tcp_port_open(port: u16) -> bool {
    TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}")
            .parse()
            .unwrap_or_else(|_| std::net::SocketAddr::from(([127, 0, 0, 1], port))),
        Duration::from_millis(250),
    )
    .is_ok()
}

fn normalize_provider_override(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn parse_loopback_base_url(value: &str) -> Result<(String, u16, String), String> {
    let url = url::Url::parse(value.trim()).map_err(|e| format!("Invalid proxy URL: {e}"))?;
    if url.scheme() != "http" {
        return Err("Science proxy manager only starts http loopback URLs".to_string());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "Science proxy URL must include a host".to_string())?;
    if !matches!(host, "127.0.0.1" | "localhost" | "::1") {
        return Err("Science proxy manager refuses non-loopback hosts".to_string());
    }
    let port = url
        .port()
        .ok_or_else(|| "Science proxy URL must include an explicit port".to_string())?;
    let normalized_host = if host == "localhost" {
        "127.0.0.1"
    } else {
        host
    };
    let normalized = if normalized_host == "::1" {
        format!("http://[::1]:{port}")
    } else {
        format!("http://{normalized_host}:{port}")
    };
    Ok((normalized_host.to_string(), port, normalized))
}

fn resolve_science_cli_path(explicit: Option<String>) -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if let Some(path) = explicit.filter(|value| !value.trim().is_empty()) {
        candidates.push(PathBuf::from(path));
    }
    if let Ok(path) = std::env::var("CLAUDE_SCIENCE_BIN") {
        if !path.trim().is_empty() {
            candidates.push(PathBuf::from(path));
        }
    }

    #[cfg(target_os = "macos")]
    {
        candidates.push(PathBuf::from(
            "/Applications/Claude Science.app/Contents/Resources/bin/claude-science",
        ));
    }

    candidates.push(
        crate::config::get_home_dir()
            .join(".claude-science")
            .join("bin")
            .join(science_binary_name()),
    );

    if let Some(path) = find_binary_in_path(science_binary_name()) {
        candidates.push(path);
    }

    candidates
        .into_iter()
        .find(|candidate| candidate.is_file())
        .ok_or_else(|| {
            "Could not locate Claude Science CLI. Install Claude Science or set CLAUDE_SCIENCE_BIN."
                .to_string()
        })
}

fn science_binary_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "claude-science.exe"
    } else {
        "claude-science"
    }
}

fn science_app_profile_paths(root: PathBuf) -> ScienceAppProfilePaths {
    let home = root.join("home");
    ScienceAppProfilePaths {
        auth_dir: home.join(".claude-science"),
        home,
        xdg_config: root.join("xdg-config"),
        xdg_data: root.join("xdg-data"),
        xdg_cache: root.join("xdg-cache"),
        tmp: root.join("tmp"),
        data_dir: root.join("data"),
        config_path: root.join("config.toml"),
        bunfig_path: root.join("bunfig.toml"),
        preload_path: root.join("preload.js"),
        root,
    }
}

fn prepare_science_app_profile(
    app: &tauri::AppHandle,
    client_token: &str,
) -> Result<ScienceAppProfilePaths, String> {
    let root = crate::config::get_app_config_dir().join("science-app-profile");
    let paths = prepare_science_app_profile_at(root, client_token)?;
    if let Ok(resource_dir) = app.path().resource_dir() {
        log::debug!(
            "Claude Science managed profile prepared at {}, app resources at {}",
            paths.root.display(),
            resource_dir.display()
        );
    }
    Ok(paths)
}

fn prepare_science_app_profile_at(
    root: PathBuf,
    client_token: &str,
) -> Result<ScienceAppProfilePaths, String> {
    guard_science_app_profile_path(&root)?;
    let paths = science_app_profile_paths(root);
    for dir in [
        &paths.root,
        &paths.home,
        &paths.home.join("Library"),
        &paths.home.join("Library").join("Keychains"),
        &paths.xdg_config,
        &paths.xdg_data,
        &paths.xdg_cache,
        &paths.tmp,
        &paths.auth_dir,
        &paths.data_dir,
    ] {
        create_science_managed_dir(&paths.root, dir)?;
    }
    guard_science_app_profile_path(&paths.root)?;
    write_science_virtual_oauth(&paths, client_token)?;
    ensure_science_sandbox_keychain(&paths)?;
    verify_science_keychain_isolation(&paths)?;

    fs::write(&paths.config_path, SCIENCE_CONFIG_TOML).map_err(|err| {
        format!(
            "Could not write Claude Science managed config {}: {err}",
            paths.config_path.display()
        )
    })?;
    fs::write(&paths.bunfig_path, "preload = [\"./preload.js\"]\n").map_err(|err| {
        format!(
            "Could not write Claude Science preload config {}: {err}",
            paths.bunfig_path.display()
        )
    })?;
    fs::write(&paths.preload_path, SCIENCE_PRELOAD_JS).map_err(|err| {
        format!(
            "Could not write Claude Science preload {}: {err}",
            paths.preload_path.display()
        )
    })?;

    Ok(paths)
}

fn guard_science_app_profile_path(root: &Path) -> Result<(), String> {
    let home = crate::config::get_home_dir();
    let forbidden_roots = [
        home.join(".claude-science"),
        home.join(".claude"),
        home.join(".claude.json"),
    ];
    if forbidden_roots
        .iter()
        .any(|forbidden| crate::config::path_matches_or_is_within(root, forbidden))
    {
        return Err(format!(
            "Refusing to use real Claude/Claude Science profile path: {}",
            root.display()
        ));
    }
    Ok(())
}

fn write_science_virtual_oauth(
    paths: &ScienceAppProfilePaths,
    client_token: &str,
) -> Result<(), String> {
    guard_science_app_profile_path(&paths.auth_dir)?;
    create_science_managed_dir(&paths.root, &paths.auth_dir)?;
    set_private_dir_permissions(&paths.auth_dir)?;

    if science_login_is_intact(paths, client_token) {
        return Ok(());
    }

    let (prior_token_org, prior_account) = read_science_token_ids(paths);
    let prior_org = match read_active_science_org(paths).or(prior_token_org) {
        Some(org) => Some(org),
        None => single_science_org_dir(paths)?,
    };

    let keys = ScienceVirtualOAuthKeys::load_or_new(paths);
    write_private_file(
        &paths.root,
        &paths.auth_dir.join("encryption.key"),
        &keys.to_key_file(),
    )?;

    let account_uuid = prior_account.unwrap_or_else(|| Uuid::new_v4().to_string());
    let org_uuid = prior_org.unwrap_or_else(|| Uuid::new_v4().to_string());
    let token_blob = json!({
        "access_token": client_token,
        "refresh_token": "",
        "api_key": null,
        "token_expires_at": SCIENCE_VIRTUAL_TOKEN_EXPIRY,
        "provider": "claude_ai",
        "scopes": "user:inference user:file_upload user:profile user:mcp_servers user:plugins",
        "email": SCIENCE_VIRTUAL_EMAIL,
        "account_uuid": account_uuid,
        "subscription_type": "max",
        "rate_limit_tier": null,
        "seat_tier": null,
        "org_uuid": org_uuid,
        "billing_type": null,
        "has_extra_usage_enabled": false,
    });
    let encrypted = encrypt_science_token_v2(
        &serde_json::to_string(&token_blob)
            .map_err(|err| format!("Could not serialize Claude Science OAuth token: {err}"))?,
        &keys.oauth,
        "oauth",
    )?;

    let token_dir = paths.auth_dir.join(".oauth-tokens");
    create_science_managed_dir(&paths.root, &token_dir)?;
    set_private_dir_permissions(&token_dir)?;
    for entry in fs::read_dir(&token_dir).map_err(|err| {
        format!(
            "Could not list Claude Science OAuth token directory {}: {err}",
            token_dir.display()
        )
    })? {
        let entry = entry.map_err(|err| format!("Could not inspect OAuth token file: {err}"))?;
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) == Some("enc") {
            guard_science_profile_member(&paths.root, &path)?;
            fs::remove_file(&path).map_err(|err| {
                format!(
                    "Could not remove stale Claude Science OAuth token {}: {err}",
                    path.display()
                )
            })?;
        }
    }

    let token_name = account_uuid.replace('-', "");
    write_private_file(
        &paths.root,
        &token_dir.join(format!("{token_name}.enc")),
        &encrypted,
    )?;
    write_private_file(
        &paths.root,
        &paths.auth_dir.join("active-org.json"),
        &format!("{}\n", json!({ "org_uuid": org_uuid })),
    )?;
    Ok(())
}

fn science_login_is_intact(paths: &ScienceAppProfilePaths, client_token: &str) -> bool {
    let Some((token, _enc_file)) = read_science_token_blob(paths) else {
        return false;
    };
    let Some(account_uuid) = json_string_field(&token, "account_uuid") else {
        return false;
    };
    let Some(org_uuid) = json_string_field(&token, "org_uuid") else {
        return false;
    };
    let Some(expires_at) = json_string_field(&token, "token_expires_at") else {
        return false;
    };
    if !looks_like_uuid(&account_uuid)
        || !looks_like_uuid(&org_uuid)
        || json_string_field(&token, "provider").as_deref() != Some("claude_ai")
        || json_string_field(&token, "email").as_deref() != Some(SCIENCE_VIRTUAL_EMAIL)
        || json_string_field(&token, "access_token").as_deref() != Some(client_token)
        || !science_token_not_expired(&expires_at)
    {
        return false;
    }
    if read_active_science_org(paths).as_deref() != Some(org_uuid.as_str()) {
        return false;
    }
    true
}

fn read_science_token_ids(paths: &ScienceAppProfilePaths) -> (Option<String>, Option<String>) {
    let Some((token, _)) = read_science_token_blob(paths) else {
        return (None, None);
    };
    let org = json_string_field(&token, "org_uuid").filter(|value| looks_like_uuid(value));
    let account = json_string_field(&token, "account_uuid").filter(|value| looks_like_uuid(value));
    (org, account)
}

fn read_science_token_blob(paths: &ScienceAppProfilePaths) -> Option<(Value, PathBuf)> {
    guard_science_profile_member(&paths.root, &paths.auth_dir).ok()?;
    let oauth_key = read_science_oauth_key(paths)?;
    let enc_file = single_oauth_token_file(paths)?;
    guard_science_profile_member(&paths.root, &enc_file).ok()?;
    let token_body = fs::read_to_string(&enc_file).ok()?;
    let token = decrypt_science_token_v2(&token_body, &oauth_key, "oauth").ok()?;
    Some((token, enc_file))
}

fn read_science_oauth_key(paths: &ScienceAppProfilePaths) -> Option<String> {
    let key_path = paths.auth_dir.join("encryption.key");
    guard_science_profile_member(&paths.root, &key_path).ok()?;
    let key_file = fs::read_to_string(key_path).ok()?;
    science_key_file_value(&key_file, "OAUTH_ENCRYPTION_KEY")
        .filter(|value| valid_science_key_material(value))
}

fn single_oauth_token_file(paths: &ScienceAppProfilePaths) -> Option<PathBuf> {
    let token_dir = paths.auth_dir.join(".oauth-tokens");
    guard_science_profile_member(&paths.root, &token_dir).ok()?;
    let mut enc_files = Vec::new();
    for entry in fs::read_dir(token_dir).ok()?.filter_map(Result::ok) {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) == Some("enc") {
            guard_science_profile_member(&paths.root, &path).ok()?;
            enc_files.push(path);
        }
    }
    if enc_files.len() == 1 {
        enc_files.pop()
    } else {
        None
    }
}

fn read_active_science_org(paths: &ScienceAppProfilePaths) -> Option<String> {
    let active_path = paths.auth_dir.join("active-org.json");
    guard_science_profile_member(&paths.root, &active_path).ok()?;
    let value: Value = serde_json::from_str(&fs::read_to_string(active_path).ok()?).ok()?;
    json_string_field(&value, "org_uuid").filter(|value| looks_like_uuid(value))
}

fn single_science_org_dir(paths: &ScienceAppProfilePaths) -> Result<Option<String>, String> {
    let orgs_dir = paths.auth_dir.join("orgs");
    guard_science_profile_member(&paths.root, &orgs_dir)?;
    if !orgs_dir.exists() {
        return Ok(None);
    }
    let mut orgs = Vec::new();
    for entry in fs::read_dir(&orgs_dir).map_err(|err| {
        format!(
            "Could not list Claude Science orgs {}: {err}",
            orgs_dir.display()
        )
    })? {
        let entry = entry.map_err(|err| format!("Could not inspect Claude Science org: {err}"))?;
        let name = entry.file_name().to_string_lossy().to_string();
        let path = entry.path();
        guard_science_profile_member(&paths.root, &path)?;
        if path.is_dir() && looks_like_uuid(&name) {
            orgs.push(name);
        }
    }
    match orgs.len() {
        0 => Ok(None),
        1 => Ok(orgs.pop()),
        _ => Err(format!(
            "Detected {} Claude Science managed org directories but no active org token; refusing to mint a new org and orphan existing conversations. Restore active-org.json under {} and retry.",
            orgs.len(),
            paths.auth_dir.display()
        )),
    }
}

fn json_string_field(value: &Value, key: &str) -> Option<String> {
    value.get(key)?.as_str().map(str::to_string)
}

fn looks_like_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => *byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
}

fn science_token_not_expired(value: &str) -> bool {
    DateTime::parse_from_rfc3339(value)
        .map(|time| time.with_timezone(&Utc) > Utc::now())
        .unwrap_or(false)
}

fn science_key_file_value(body: &str, name: &str) -> Option<String> {
    body.lines()
        .find_map(|line| line.strip_prefix(&format!("{name}=")))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn valid_science_key_material(value: &str) -> bool {
    BASE64_STANDARD
        .decode(value.trim())
        .map(|bytes| bytes.len() >= 16)
        .unwrap_or(false)
}

#[derive(Debug)]
struct ScienceVirtualOAuthKeys {
    anthropic_api_key: String,
    oauth: String,
    jwt: String,
    user_secret: String,
}

impl ScienceVirtualOAuthKeys {
    fn new() -> Self {
        Self {
            anthropic_api_key: random_base64(32),
            oauth: random_base64(32),
            jwt: random_base64(32),
            user_secret: random_base64(32),
        }
    }

    fn load_or_new(paths: &ScienceAppProfilePaths) -> Self {
        let mut keys = Self::new();
        let key_path = paths.auth_dir.join("encryption.key");
        if guard_science_profile_member(&paths.root, &key_path).is_ok() {
            if let Ok(body) = fs::read_to_string(&key_path) {
                if let Some(value) =
                    science_key_file_value(&body, "ANTHROPIC_API_KEY_ENCRYPTION_KEY")
                        .filter(|value| valid_science_key_material(value))
                {
                    keys.anthropic_api_key = value;
                }
                if let Some(value) = science_key_file_value(&body, "OAUTH_ENCRYPTION_KEY")
                    .filter(|value| valid_science_key_material(value))
                {
                    keys.oauth = value;
                }
                if let Some(value) = science_key_file_value(&body, "JWT_SIGNING_SECRET")
                    .filter(|value| value.len() >= 16)
                {
                    keys.jwt = value;
                }
                if let Some(value) = science_key_file_value(&body, "USER_SECRET_ENCRYPTION_KEY")
                    .filter(|value| valid_science_key_material(value))
                {
                    keys.user_secret = value;
                }
            }
        }
        keys
    }

    fn to_key_file(&self) -> String {
        [
            format!(
                "ANTHROPIC_API_KEY_ENCRYPTION_KEY={}",
                self.anthropic_api_key
            ),
            format!("OAUTH_ENCRYPTION_KEY={}", self.oauth),
            format!("JWT_SIGNING_SECRET={}", self.jwt),
            format!("USER_SECRET_ENCRYPTION_KEY={}", self.user_secret),
            String::new(),
        ]
        .join("\n")
    }
}

fn encrypt_science_token_v2(
    plaintext: &str,
    key_base64: &str,
    label: &str,
) -> Result<String, String> {
    let root_key = BASE64_STANDARD
        .decode(key_base64)
        .map_err(|err| format!("Invalid Claude Science OAuth encryption key: {err}"))?;
    if root_key.len() < 16 {
        return Err("Invalid Claude Science OAuth encryption key length".to_string());
    }
    let info = format!("operon:aes-256-gcm:{label}");
    let key = hkdf_sha256(&root_key, info.as_bytes(), 32)?;
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|err| format!("Could not initialize Claude Science token cipher: {err}"))?;
    let iv = random_bytes(12);
    let nonce = Nonce::from_slice(&iv);
    let mut ciphertext = plaintext.as_bytes().to_vec();
    let tag = cipher
        .encrypt_in_place_detached(nonce, format!("v2:{label}").as_bytes(), &mut ciphertext)
        .map_err(|err| format!("Could not encrypt Claude Science OAuth token: {err}"))?;
    let mut body = iv;
    body.extend_from_slice(&ciphertext);
    body.extend_from_slice(&tag);
    Ok(format!("v2:{}", BASE64_STANDARD.encode(body)))
}

fn decrypt_science_token_v2(body: &str, key_base64: &str, label: &str) -> Result<Value, String> {
    let raw = BASE64_STANDARD
        .decode(
            body.strip_prefix("v2:")
                .ok_or_else(|| "Claude Science OAuth token is missing v2 prefix".to_string())?,
        )
        .map_err(|err| format!("Invalid Claude Science OAuth token base64: {err}"))?;
    if raw.len() < 29 {
        return Err("Claude Science OAuth token is too short".to_string());
    }
    let iv = &raw[..12];
    let tag = &raw[raw.len() - 16..];
    let mut ciphertext = raw[12..raw.len() - 16].to_vec();
    let root_key = BASE64_STANDARD
        .decode(key_base64)
        .map_err(|err| format!("Invalid Claude Science OAuth encryption key: {err}"))?;
    if root_key.len() < 16 {
        return Err("Invalid Claude Science OAuth encryption key length".to_string());
    }
    let info = format!("operon:aes-256-gcm:{label}");
    let key = hkdf_sha256(&root_key, info.as_bytes(), 32)?;
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|err| format!("Could not initialize Claude Science token cipher: {err}"))?;
    cipher
        .decrypt_in_place_detached(
            Nonce::from_slice(iv),
            format!("v2:{label}").as_bytes(),
            &mut ciphertext,
            aes_gcm::Tag::from_slice(tag),
        )
        .map_err(|err| format!("Could not decrypt Claude Science OAuth token: {err}"))?;
    serde_json::from_slice(&ciphertext)
        .map_err(|err| format!("Could not parse Claude Science OAuth token: {err}"))
}

fn hkdf_sha256(ikm: &[u8], info: &[u8], len: usize) -> Result<Vec<u8>, String> {
    let mut extract = <HmacSha256 as Mac>::new_from_slice(&[])
        .map_err(|err| format!("Could not initialize HKDF extract: {err}"))?;
    extract.update(ikm);
    let prk = extract.finalize().into_bytes();
    let mut okm = Vec::with_capacity(len);
    let mut previous = Vec::new();
    let mut counter = 1u8;
    while okm.len() < len {
        let mut expand = <HmacSha256 as Mac>::new_from_slice(&prk)
            .map_err(|err| format!("Could not initialize HKDF expand: {err}"))?;
        expand.update(&previous);
        expand.update(info);
        expand.update(&[counter]);
        previous = expand.finalize().into_bytes().to_vec();
        okm.extend_from_slice(&previous);
        counter = counter
            .checked_add(1)
            .ok_or_else(|| "HKDF output length is too large".to_string())?;
    }
    okm.truncate(len);
    Ok(okm)
}

fn random_base64(len: usize) -> String {
    BASE64_STANDARD.encode(random_bytes(len))
}

fn random_bytes(len: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(len);
    while out.len() < len {
        out.extend_from_slice(Uuid::new_v4().as_bytes());
    }
    out.truncate(len);
    out
}

fn guard_not_symlink(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(format!(
            "Refusing to follow symlink in Claude Science managed profile: {}",
            path.display()
        )),
        Ok(_) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!("Could not inspect {}: {err}", path.display())),
    }
}

fn create_science_managed_dir(root: &Path, dir: &Path) -> Result<(), String> {
    guard_science_profile_member(root, dir)?;
    fs::create_dir_all(dir).map_err(|err| {
        format!(
            "Could not create Claude Science managed directory {}: {err}",
            dir.display()
        )
    })?;
    guard_science_profile_member(root, dir)?;
    Ok(())
}

fn guard_science_profile_member(root: &Path, path: &Path) -> Result<(), String> {
    guard_science_app_profile_path(root)?;
    let root = absolute_normalized_science_path(root)?;
    let path = absolute_normalized_science_path(path)?;
    if !path.starts_with(&root) {
        return Err(format!(
            "Refusing to use path outside Claude Science managed profile: {}",
            path.display()
        ));
    }

    guard_not_symlink(&root)?;
    let relative = path.strip_prefix(&root).map_err(|_| {
        format!(
            "Refusing to use path outside Claude Science managed profile: {}",
            path.display()
        )
    })?;
    let mut current = root.clone();
    for component in relative.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(part) => {
                current.push(part);
                guard_not_symlink(&current)?;
            }
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(format!(
                    "Refusing unsafe Claude Science managed profile path: {}",
                    path.display()
                ));
            }
        }
    }

    if let (Ok(root_real), Ok(path_real)) = (fs::canonicalize(&root), fs::canonicalize(&path)) {
        if !path_real.starts_with(&root_real) {
            return Err(format!(
                "Refusing to follow path outside Claude Science managed profile: {}",
                path.display()
            ));
        }
    }
    Ok(())
}

fn absolute_normalized_science_path(path: &Path) -> Result<PathBuf, String> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|err| format!("Could not resolve current directory: {err}"))?
            .join(path)
    };
    Ok(normalize_science_path(&absolute))
}

fn normalize_science_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    normalized.push(component.as_os_str());
                }
            }
            Component::Normal(part) => normalized.push(part),
            Component::RootDir | Component::Prefix(_) => normalized.push(component.as_os_str()),
        }
    }
    normalized
}

fn write_private_file(root: &Path, path: &Path, body: &str) -> Result<(), String> {
    guard_science_profile_member(root, path)?;
    if let Some(parent) = path.parent() {
        create_science_managed_dir(root, parent)?;
        set_private_dir_permissions(parent)?;
    }
    guard_science_profile_member(root, path)?;
    let tmp = path.with_file_name(format!(
        ".{}.tmp-{}",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("science-auth"),
        Uuid::new_v4()
    ));
    guard_science_profile_member(root, &tmp)?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let write_result = (|| -> Result<(), String> {
        let mut file = options
            .open(&tmp)
            .map_err(|err| format!("Could not create {}: {err}", tmp.display()))?;
        file.write_all(body.as_bytes())
            .map_err(|err| format!("Could not write {}: {err}", tmp.display()))?;
        file.sync_all()
            .map_err(|err| format!("Could not sync {}: {err}", tmp.display()))?;
        Ok(())
    })();
    if let Err(err) = write_result {
        let _ = fs::remove_file(&tmp);
        return Err(err);
    }
    guard_science_profile_member(root, path)?;
    guard_science_profile_member(root, &tmp)?;
    fs::rename(&tmp, path).map_err(|err| format!("Could not replace {}: {err}", path.display()))?;
    set_private_file_permissions(path)?;
    Ok(())
}

fn set_private_dir_permissions(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|err| format!("Could not set permissions on {}: {err}", path.display()))?;
    }
    Ok(())
}

fn set_private_file_permissions(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|err| format!("Could not set permissions on {}: {err}", path.display()))?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn ensure_science_sandbox_keychain(paths: &ScienceAppProfilePaths) -> Result<(), String> {
    let keychain = paths
        .home
        .join("Library")
        .join("Keychains")
        .join("login.keychain-db");
    guard_science_profile_member(&paths.root, &keychain)?;
    if !keychain.is_file() {
        run_science_security_command(paths, |command| {
            command
                .arg("create-keychain")
                .arg("-p")
                .arg("")
                .arg(&keychain);
        })?;
    }
    run_science_security_command(paths, |command| {
        command
            .arg("list-keychains")
            .arg("-d")
            .arg("user")
            .arg("-s")
            .arg(&keychain);
    })?;
    run_science_security_command(paths, |command| {
        command
            .arg("default-keychain")
            .arg("-d")
            .arg("user")
            .arg("-s")
            .arg(&keychain);
    })?;
    run_science_security_command(paths, |command| {
        command
            .arg("unlock-keychain")
            .arg("-p")
            .arg("")
            .arg(&keychain);
    })?;
    run_science_security_command(paths, |command| {
        command.arg("set-keychain-settings").arg(&keychain);
    })?;
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn ensure_science_sandbox_keychain(_paths: &ScienceAppProfilePaths) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "macos")]
fn run_science_security_command<F>(
    paths: &ScienceAppProfilePaths,
    configure: F,
) -> Result<String, String>
where
    F: FnOnce(&mut Command),
{
    let mut command = Command::new("/usr/bin/security");
    configure(&mut command);
    command.current_dir(&paths.root).stdin(Stdio::null());
    apply_science_process_env(
        &mut command,
        paths,
        "http://127.0.0.1:9",
        "science-keychain-probe",
        "science-keychain-probe",
    );
    let output = command.output().map_err(|err| {
        format!(
            "Could not run isolated Claude Science keychain command in {}: {err}",
            paths.home.display()
        )
    })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!(
            "Isolated Claude Science keychain command failed: {}",
            if stderr.is_empty() {
                output.status.to_string()
            } else {
                stderr
            }
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[cfg(target_os = "macos")]
fn verify_science_keychain_isolation(paths: &ScienceAppProfilePaths) -> Result<(), String> {
    let stdout = run_science_security_command(paths, |command| {
        command.arg("list-keychains");
    })?;
    let real_home = crate::config::get_home_dir();
    let real_login_keychains = real_home.join("Library").join("Keychains");
    for line in stdout.lines() {
        let item = line.trim().trim_matches('"');
        if item.is_empty() {
            continue;
        }
        let keychain_path = PathBuf::from(item);
        if crate::config::path_matches_or_is_within(&keychain_path, &real_login_keychains) {
            return Err(format!(
                "Refusing to launch Claude Science because the isolated process can still see the real login Keychain: {}",
                keychain_path.display()
            ));
        }
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn verify_science_keychain_isolation(_paths: &ScienceAppProfilePaths) -> Result<(), String> {
    Ok(())
}

fn apply_science_process_env(
    command: &mut Command,
    paths: &ScienceAppProfilePaths,
    base_url: &str,
    client_token: &str,
    preload_run_id: &str,
) {
    command.env_clear();
    command
        .env("HOME", &paths.home)
        .env("XDG_CONFIG_HOME", &paths.xdg_config)
        .env("XDG_DATA_HOME", &paths.xdg_data)
        .env("XDG_CACHE_HOME", &paths.xdg_cache)
        .env("TMPDIR", &paths.tmp)
        .env("PATH", science_process_path())
        .env("NO_PROXY", "127.0.0.1,localhost,::1")
        .env("no_proxy", "127.0.0.1,localhost,::1")
        .env("HTTP_PROXY", "http://127.0.0.1:9")
        .env("HTTPS_PROXY", "http://127.0.0.1:9")
        .env("ALL_PROXY", "http://127.0.0.1:9")
        .env("http_proxy", "http://127.0.0.1:9")
        .env("https_proxy", "http://127.0.0.1:9")
        .env("all_proxy", "http://127.0.0.1:9")
        .env("CS_STUB_EXTERNAL_SERVICES", "1")
        .env("CS_PROXY_BASE_URL", base_url)
        .env("CS_PROXY_TOKEN", client_token)
        .env("CS_PRELOAD_RUN_ID", preload_run_id)
        .env("ANTHROPIC_BASE_URL", base_url)
        .env("ANTHROPIC_AUTH_TOKEN", client_token)
        .env("ANTHROPIC_API_KEY", client_token);

    #[cfg(target_os = "windows")]
    {
        for key in ["SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"] {
            if let Ok(value) = std::env::var(key) {
                command.env(key, value);
            }
        }
    }
}

fn science_process_path() -> String {
    let fallback = if cfg!(target_os = "windows") {
        r"C:\Windows\System32;C:\Windows"
    } else {
        "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin"
    };
    match std::env::var("PATH") {
        Ok(path) if !path.trim().is_empty() => format!("{fallback}:{path}"),
        _ => fallback.to_string(),
    }
}

fn managed_process_log_stdio(file_name: &str) -> (Stdio, Stdio) {
    process_log_stdio(
        &crate::config::get_app_config_dir()
            .join("logs")
            .join(file_name),
    )
}

fn science_app_log_stdio(paths: &ScienceAppProfilePaths) -> (Stdio, Stdio) {
    process_log_stdio(&paths.root.join("serve.log"))
}

fn reset_science_app_log(paths: &ScienceAppProfilePaths) -> Result<(), String> {
    let path = paths.root.join("serve.log");
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Could not create Claude Science log directory: {err}"))?;
    }
    fs::write(&path, "").map_err(|err| {
        format!(
            "Could not reset Claude Science log {}: {err}",
            path.display()
        )
    })
}

fn science_preload_loaded(paths: &ScienceAppProfilePaths, preload_run_id: &str) -> bool {
    let marker = format!("[cs-switch-preload] loaded {preload_run_id}");
    fs::read_to_string(paths.root.join("serve.log"))
        .map(|content| content.contains(&marker))
        .unwrap_or(false)
}

fn find_available_loopback_port() -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|err| format!("Could not allocate a loopback smoke port: {err}"))?;
    listener
        .local_addr()
        .map(|addr| addr.port())
        .map_err(|err| format!("Could not read allocated smoke port: {err}"))
}

fn wait_for_proxy_health(port: u16, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    let mut last_error = "not checked".to_string();
    while Instant::now() < deadline {
        match proxy_health_ok(port) {
            Ok(true) => return Ok(()),
            Ok(false) => last_error = "health endpoint did not return 200".to_string(),
            Err(err) => last_error = err,
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    Err(format!(
        "Science proxy did not become healthy: {last_error}"
    ))
}

fn proxy_health_ok(port: u16) -> Result<bool, String> {
    let addr = format!("127.0.0.1:{port}")
        .parse()
        .map_err(|err| format!("Invalid smoke proxy socket address: {err}"))?;
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(350))
        .map_err(|err| format!("connect /health failed: {err}"))?;
    let _ = stream.set_read_timeout(Some(Duration::from_millis(750)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(750)));
    stream
        .write_all(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .map_err(|err| format!("write /health failed: {err}"))?;
    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(|err| format!("read /health failed: {err}"))?;
    Ok(response.starts_with("HTTP/1.1 200") || response.starts_with("HTTP/1.0 200"))
}

fn process_log_stdio(path: &Path) -> (Stdio, Stdio) {
    let Some(parent) = path.parent() else {
        return (Stdio::null(), Stdio::null());
    };
    if fs::create_dir_all(parent).is_err() {
        return (Stdio::null(), Stdio::null());
    }

    let Ok(file) = OpenOptions::new().create(true).append(true).open(path) else {
        return (Stdio::null(), Stdio::null());
    };
    let stderr = file
        .try_clone()
        .map(Stdio::from)
        .unwrap_or_else(|_| Stdio::null());
    (Stdio::from(file), stderr)
}

fn validate_loopback_web_url(web_url: &str) -> Result<(), String> {
    let url = url::Url::parse(web_url)
        .map_err(|err| format!("Claude Science returned an invalid login URL: {err}"))?;
    if url.scheme() != "http" {
        return Err("Claude Science login URL must be http loopback".to_string());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "Claude Science login URL must include a host".to_string())?;
    if !matches!(host, "127.0.0.1" | "localhost" | "::1") {
        return Err(format!(
            "Refusing to open non-loopback Claude Science login URL: {host}"
        ));
    }
    Ok(())
}

fn wait_for_science_loopback_url(
    cli_path: &Path,
    paths: &ScienceAppProfilePaths,
    base_url: &str,
    client_token: &str,
    preload_run_id: &str,
    timeout: Duration,
) -> Result<String, String> {
    let deadline = Instant::now() + timeout;
    let mut last_error = "not checked".to_string();
    while Instant::now() < deadline {
        if !science_preload_loaded(paths, preload_run_id) {
            last_error = format!(
                "preload marker {preload_run_id} not found in {}",
                paths.root.join("serve.log").display()
            );
            std::thread::sleep(Duration::from_millis(300));
            continue;
        }
        match read_science_loopback_url(cli_path, paths, base_url, client_token, preload_run_id) {
            Ok(web_url) => return Ok(web_url),
            Err(err) => last_error = err,
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    Err(format!(
        "Claude Science did not provide a loopback URL: {last_error}"
    ))
}

fn first_http_url(stdout: &str) -> Option<String> {
    for line in stdout.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
            return trimmed
                .split_whitespace()
                .next()
                .filter(|value| !value.is_empty())
                .map(str::to_string);
        }
    }
    None
}

fn read_science_loopback_url(
    cli_path: &Path,
    paths: &ScienceAppProfilePaths,
    base_url: &str,
    client_token: &str,
    preload_run_id: &str,
) -> Result<String, String> {
    let mut command = Command::new(cli_path);
    command
        .arg("url")
        .arg("--data-dir")
        .arg(&paths.data_dir)
        .arg("--config")
        .arg(&paths.config_path)
        .current_dir(&paths.root)
        .stdin(Stdio::null());
    apply_science_process_env(&mut command, paths, base_url, client_token, preload_run_id);

    let output = command
        .output()
        .map_err(|err| format!("Could not ask Claude Science for a smoke login URL: {err}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("Claude Science url exited with {}", output.status)
        } else {
            stderr
        });
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let web_url = first_http_url(&stdout)
        .ok_or_else(|| "Claude Science did not return a smoke login URL".to_string())?;
    validate_loopback_web_url(&web_url)?;
    Ok(web_url)
}

fn open_fresh_science_app_url(
    app: &tauri::AppHandle,
    status: ScienceAppProcessStatus,
    open_browser: bool,
) -> Result<ScienceAppProcessStatus, String> {
    let cli_path = status
        .cli_path
        .as_ref()
        .ok_or_else(|| "Claude Science CLI path is unavailable".to_string())?;
    let profile_root = status
        .profile_root
        .as_ref()
        .ok_or_else(|| "Claude Science profile path is unavailable".to_string())?;
    let data_dir = status
        .data_dir
        .as_ref()
        .ok_or_else(|| "Claude Science data directory is unavailable".to_string())?;
    let config_path = status
        .config_path
        .as_ref()
        .ok_or_else(|| "Claude Science config path is unavailable".to_string())?;

    let paths = science_app_profile_paths(PathBuf::from(profile_root));
    let preload_run_id = format!("science-url-{}", Uuid::new_v4());
    let mut command = Command::new(cli_path);
    command
        .arg("url")
        .arg("--data-dir")
        .arg(data_dir)
        .arg("--config")
        .arg(config_path)
        .current_dir(profile_root)
        .stdin(Stdio::null());
    apply_science_process_env(
        &mut command,
        &paths,
        &status.base_url,
        &status.client_token,
        &preload_run_id,
    );

    let output = command
        .output()
        .map_err(|err| format!("Could not ask Claude Science for a login URL: {err}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("Claude Science url exited with {}", output.status)
        } else {
            stderr
        });
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let web_url = first_http_url(&stdout)
        .ok_or_else(|| "Claude Science did not return a login URL".to_string())?;
    validate_loopback_web_url(&web_url)?;

    if open_browser {
        app.opener()
            .open_url(&web_url, None::<String>)
            .map_err(|err| format!("Could not open Claude Science URL: {err}"))?;
    }

    let mut guard = SCIENCE_APP_PROCESS
        .lock()
        .map_err(|_| "Claude Science process lock poisoned".to_string())?;
    if let Some(process) = guard.as_mut() {
        process.web_url = Some(web_url.clone());
    }
    let mut next_status = status_from_science_app_guard(&mut guard);
    next_status.web_url = Some(web_url);
    Ok(next_status)
}

fn resolve_cli_path(app: &tauri::AppHandle, explicit: Option<String>) -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if let Some(path) = explicit.filter(|value| !value.trim().is_empty()) {
        candidates.push(PathBuf::from(path));
    }
    if let Ok(path) = std::env::var("CLAUDE_SCIENCE_SWITCH_BIN") {
        if !path.trim().is_empty() {
            candidates.push(PathBuf::from(path));
        }
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(
            resource_dir
                .join("claude-science-switch")
                .join("bin")
                .join(native_proxy_binary_name()),
        );
        candidates.push(resource_dir.join("bin").join(native_proxy_binary_name()));
        candidates.push(
            resource_dir
                .join("claude-science-switch")
                .join("bin")
                .join("claude-science-switch.js"),
        );
        candidates.push(resource_dir.join("bin").join("claude-science-switch.js"));
    }
    if let Ok(current_dir) = std::env::current_dir() {
        candidates.push(
            current_dir
                .join("..")
                .join("..")
                .join("bin")
                .join("native")
                .join(native_proxy_binary_name()),
        );
        candidates.push(
            current_dir
                .join("..")
                .join("bin")
                .join("native")
                .join(native_proxy_binary_name()),
        );
        candidates.push(
            current_dir
                .join("bin")
                .join("native")
                .join(native_proxy_binary_name()),
        );
        candidates.push(
            current_dir
                .join("..")
                .join("bin")
                .join("claude-science-switch.js"),
        );
        candidates.push(current_dir.join("bin").join("claude-science-switch.js"));
    }

    for candidate in candidates {
        if candidate.is_file() {
            return Ok(candidate);
        }
    }

    Ok(PathBuf::from("claude-science-switch"))
}

fn native_proxy_binary_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "claude-science-switch.exe"
    } else {
        "claude-science-switch"
    }
}

fn locate_packaged_science_switch_resources() -> Result<PathBuf, String> {
    let exe = std::env::current_exe()
        .map_err(|err| format!("Could not resolve current executable path: {err}"))?;
    for ancestor in exe.ancestors() {
        if ancestor.file_name().and_then(|name| name.to_str()) == Some("Contents") {
            let candidate = ancestor.join("Resources").join("claude-science-switch");
            if candidate.is_dir() {
                return Ok(candidate);
            }
        }
    }

    let current_dir = std::env::current_dir()
        .map_err(|err| format!("Could not resolve current directory: {err}"))?;
    for candidate in [
        current_dir.join("claude-science-switch"),
        current_dir
            .join("..")
            .join("Resources")
            .join("claude-science-switch"),
        current_dir
            .join("..")
            .join("..")
            .join("claude-science-switch"),
    ] {
        if candidate.is_dir() {
            return Ok(candidate);
        }
    }

    Err(format!(
        "Could not locate bundled claude-science-switch resources from {}",
        exe.display()
    ))
}

fn resolve_config_path(
    app: &tauri::AppHandle,
    explicit: Option<String>,
) -> Result<PathBuf, String> {
    let mut explicit_candidates = Vec::new();
    if let Some(path) = explicit.filter(|value| !value.trim().is_empty()) {
        explicit_candidates.push(PathBuf::from(path));
    }
    if let Ok(path) = std::env::var("CLAUDE_SCIENCE_SWITCH_CONFIG") {
        if !path.trim().is_empty() {
            explicit_candidates.push(PathBuf::from(path));
        }
    }

    if let Some(candidate) = explicit_candidates
        .into_iter()
        .find(|candidate| candidate.is_file())
    {
        return Ok(candidate);
    }

    if let Some(config_path) = ensure_user_science_proxy_config(app)? {
        return Ok(config_path);
    }

    let mut candidates = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(
            resource_dir
                .join("claude-science-switch")
                .join("examples")
                .join("cliproxy-gpt55.json"),
        );
        candidates.push(resource_dir.join("examples").join("cliproxy-gpt55.json"));
    }
    if let Ok(current_dir) = std::env::current_dir() {
        candidates.push(
            current_dir
                .join("..")
                .join("..")
                .join("examples")
                .join("cliproxy-gpt55.json"),
        );
        candidates.push(
            current_dir
                .join("..")
                .join("examples")
                .join("cliproxy-gpt55.json"),
        );
        candidates.push(current_dir.join("examples").join("cliproxy-gpt55.json"));
    }

    candidates
        .into_iter()
        .find(|candidate| candidate.is_file())
        .ok_or_else(|| {
            "Could not locate claude-science-switch config. Set CLAUDE_SCIENCE_SWITCH_CONFIG or pass configPath."
                .to_string()
        })
}

fn ensure_user_science_proxy_config(app: &tauri::AppHandle) -> Result<Option<PathBuf>, String> {
    let config_dir = match ensure_science_proxy_config_dir(app) {
        Ok(path) => path,
        Err(err) => {
            log::debug!("Could not resolve Science proxy config dir: {err}");
            return Ok(None);
        }
    };

    let default_config = config_dir.join("cliproxy-gpt55.json");
    if default_config.is_file() {
        Ok(Some(default_config))
    } else {
        Ok(None)
    }
}

fn ensure_science_proxy_config_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|err| format!("Could not resolve app config dir: {err}"))?
        .join("science-proxy");
    fs::create_dir_all(&config_dir).map_err(|err| {
        format!(
            "Could not create Science proxy config directory {}: {err}",
            config_dir.display()
        )
    })?;
    copy_science_proxy_template_if_missing(app, &config_dir, "cliproxy-gpt55.json")?;
    copy_science_proxy_template_if_missing(
        app,
        &config_dir,
        "cc-switch-provider-openai-chat.json",
    )?;
    copy_science_proxy_template_if_missing(app, &config_dir, "multi-provider.json")?;
    copy_science_proxy_template_if_missing(app, &config_dir, "science-provider-presets.json")?;
    Ok(config_dir)
}

fn copy_science_proxy_template_if_missing(
    app: &tauri::AppHandle,
    config_dir: &Path,
    file_name: &str,
) -> Result<(), String> {
    let target = config_dir.join(file_name);
    if target.is_file() {
        return Ok(());
    }

    let Some(source) = find_science_proxy_template(app, file_name) else {
        return Ok(());
    };

    fs::copy(&source, &target).map_err(|err| {
        format!(
            "Could not copy Science proxy config template {} to {}: {err}",
            source.display(),
            target.display()
        )
    })?;
    Ok(())
}

fn find_science_proxy_template(app: &tauri::AppHandle, file_name: &str) -> Option<PathBuf> {
    let mut candidates = Vec::new();

    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(
            resource_dir
                .join("claude-science-switch")
                .join("examples")
                .join(file_name),
        );
        candidates.push(resource_dir.join("examples").join(file_name));
    }

    if let Ok(current_dir) = std::env::current_dir() {
        candidates.push(current_dir.join("examples").join(file_name));
        candidates.push(current_dir.join("..").join("examples").join(file_name));
        candidates.push(
            current_dir
                .join("..")
                .join("..")
                .join("examples")
                .join(file_name),
        );
    }

    candidates.into_iter().find(|candidate| candidate.is_file())
}

fn build_proxy_command(app: &tauri::AppHandle, cli_path: &Path) -> Result<Command, String> {
    if cli_path.extension().and_then(|ext| ext.to_str()) == Some("js") {
        let node_path = resolve_node_path(app).ok_or_else(|| {
            "Node.js runtime is required to start the bundled Claude Science Switch proxy. Install Node.js or set CLAUDE_SCIENCE_SWITCH_NODE to a node binary."
                .to_string()
        })?;
        let mut command = Command::new(node_path);
        command.arg(cli_path);
        Ok(command)
    } else {
        Ok(Command::new(cli_path))
    }
}

fn resolve_node_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    let mut candidates = Vec::new();

    if let Ok(path) = std::env::var("CLAUDE_SCIENCE_SWITCH_NODE") {
        if !path.trim().is_empty() {
            candidates.push(PathBuf::from(path));
        }
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(
            resource_dir
                .join("claude-science-switch")
                .join("node")
                .join(node_binary_name()),
        );
        candidates.push(resource_dir.join("node").join(node_binary_name()));
    }

    if let Ok(current_dir) = std::env::current_dir() {
        candidates.push(current_dir.join("node").join(node_binary_name()));
        candidates.push(current_dir.join("..").join("node").join(node_binary_name()));
    }

    for candidate in candidates {
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    find_binary_in_path(node_binary_name())
}

fn node_binary_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "node.exe"
    } else {
        "node"
    }
}

fn find_binary_in_path(binary: &str) -> Option<PathBuf> {
    let paths = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&paths) {
        let candidate = dir.join(binary);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key_value(body: &str, name: &str) -> String {
        body.lines()
            .find_map(|line| line.strip_prefix(&format!("{name}=")))
            .expect("key should exist")
            .to_string()
    }

    fn decrypt_test_science_token_v2(
        body: &str,
        key_base64: &str,
        label: &str,
    ) -> serde_json::Value {
        let raw = BASE64_STANDARD
            .decode(body.strip_prefix("v2:").expect("v2 prefix"))
            .expect("base64 token");
        let iv = &raw[..12];
        let tag = &raw[raw.len() - 16..];
        let mut ciphertext = raw[12..raw.len() - 16].to_vec();
        let root_key = BASE64_STANDARD.decode(key_base64).expect("base64 key");
        let info = format!("operon:aes-256-gcm:{label}");
        let key = hkdf_sha256(&root_key, info.as_bytes(), 32).expect("hkdf");
        let cipher = Aes256Gcm::new_from_slice(&key).expect("cipher");
        cipher
            .decrypt_in_place_detached(
                Nonce::from_slice(iv),
                format!("v2:{label}").as_bytes(),
                &mut ciphertext,
                aes_gcm::Tag::from_slice(tag),
            )
            .expect("decrypt");
        serde_json::from_slice(&ciphertext).expect("token json")
    }

    fn oauth_enc_files(paths: &ScienceAppProfilePaths) -> Vec<PathBuf> {
        fs::read_dir(paths.auth_dir.join(".oauth-tokens"))
            .expect("token dir")
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("enc"))
            .collect::<Vec<_>>()
    }

    fn oauth_token(paths: &ScienceAppProfilePaths) -> serde_json::Value {
        let key_file = fs::read_to_string(paths.auth_dir.join("encryption.key")).expect("key file");
        let oauth_key = key_value(&key_file, "OAUTH_ENCRYPTION_KEY");
        let enc_files = oauth_enc_files(paths);
        assert_eq!(enc_files.len(), 1);
        let token_body = fs::read_to_string(&enc_files[0]).expect("token body");
        decrypt_test_science_token_v2(&token_body, &oauth_key, "oauth")
    }

    fn active_org(paths: &ScienceAppProfilePaths) -> String {
        let active_org: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(paths.auth_dir.join("active-org.json")).expect("active org"),
        )
        .expect("active org json");
        active_org["org_uuid"].as_str().unwrap().to_string()
    }

    #[test]
    fn virtual_oauth_token_roundtrips_and_matches_active_org() {
        let temp = tempfile::tempdir().expect("tempdir");
        let paths = science_app_profile_paths(temp.path().join("science-app-profile"));
        fs::create_dir_all(&paths.home).expect("home");
        write_science_virtual_oauth(&paths, "science-client-test-token").expect("write oauth");

        let key_file = fs::read_to_string(paths.auth_dir.join("encryption.key")).expect("key file");
        let oauth_key = key_value(&key_file, "OAUTH_ENCRYPTION_KEY");
        let enc_files = oauth_enc_files(&paths);
        assert_eq!(enc_files.len(), 1);

        let token_body = fs::read_to_string(&enc_files[0]).expect("token body");
        let token = decrypt_test_science_token_v2(&token_body, &oauth_key, "oauth");
        assert_eq!(token["access_token"], "science-client-test-token");
        assert_eq!(token["provider"], "claude_ai");
        assert_eq!(token["email"], SCIENCE_VIRTUAL_EMAIL);
        assert_eq!(token["subscription_type"], "max");

        assert_eq!(active_org(&paths), token["org_uuid"].as_str().unwrap());

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(paths.auth_dir.join("encryption.key"))
                    .expect("metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn virtual_oauth_reuses_intact_login_without_rewriting() {
        let temp = tempfile::tempdir().expect("tempdir");
        let paths = science_app_profile_paths(temp.path().join("science-app-profile"));
        fs::create_dir_all(&paths.home).expect("home");
        write_science_virtual_oauth(&paths, "science-client-stable").expect("write oauth");

        let key_before =
            fs::read(paths.auth_dir.join("encryption.key")).expect("key before should exist");
        let enc_path = oauth_enc_files(&paths).pop().expect("enc before");
        let enc_before = fs::read(&enc_path).expect("enc before should exist");
        let org_before = active_org(&paths);

        write_science_virtual_oauth(&paths, "science-client-stable").expect("reuse oauth");

        assert_eq!(
            fs::read(paths.auth_dir.join("encryption.key")).unwrap(),
            key_before
        );
        assert_eq!(fs::read(&enc_path).unwrap(), enc_before);
        assert_eq!(active_org(&paths), org_before);
        assert!(science_login_is_intact(&paths, "science-client-stable"));
    }

    #[test]
    fn virtual_oauth_repairs_changed_client_token_but_keeps_org() {
        let temp = tempfile::tempdir().expect("tempdir");
        let paths = science_app_profile_paths(temp.path().join("science-app-profile"));
        fs::create_dir_all(&paths.home).expect("home");
        write_science_virtual_oauth(&paths, "science-client-old").expect("write oauth");
        let org_before = active_org(&paths);

        write_science_virtual_oauth(&paths, "science-client-new").expect("repair oauth");

        let token = oauth_token(&paths);
        assert_eq!(token["access_token"], "science-client-new");
        assert_eq!(token["org_uuid"], org_before);
        assert_eq!(active_org(&paths), org_before);
        assert!(!science_login_is_intact(&paths, "science-client-old"));
        assert!(science_login_is_intact(&paths, "science-client-new"));
    }

    #[test]
    fn virtual_oauth_repairs_missing_token_file_but_keeps_active_org() {
        let temp = tempfile::tempdir().expect("tempdir");
        let paths = science_app_profile_paths(temp.path().join("science-app-profile"));
        fs::create_dir_all(&paths.home).expect("home");
        write_science_virtual_oauth(&paths, "science-client-token").expect("write oauth");
        let org_before = active_org(&paths);
        for enc in oauth_enc_files(&paths) {
            fs::remove_file(enc).expect("remove enc");
        }

        write_science_virtual_oauth(&paths, "science-client-token").expect("repair oauth");

        let token = oauth_token(&paths);
        assert_eq!(token["org_uuid"], org_before);
        assert_eq!(active_org(&paths), org_before);
        assert!(science_login_is_intact(&paths, "science-client-token"));
    }

    #[test]
    fn virtual_oauth_refuses_ambiguous_orphaned_orgs() {
        let temp = tempfile::tempdir().expect("tempdir");
        let paths = science_app_profile_paths(temp.path().join("science-app-profile"));
        fs::create_dir_all(&paths.home).expect("home");
        write_science_virtual_oauth(&paths, "science-client-token").expect("write oauth");
        fs::remove_file(paths.auth_dir.join("active-org.json")).expect("remove active org");
        for enc in oauth_enc_files(&paths) {
            fs::remove_file(enc).expect("remove enc");
        }
        fs::create_dir_all(paths.auth_dir.join("orgs").join(Uuid::new_v4().to_string()))
            .expect("org a");
        fs::create_dir_all(paths.auth_dir.join("orgs").join(Uuid::new_v4().to_string()))
            .expect("org b");

        let error = write_science_virtual_oauth(&paths, "science-client-token")
            .expect_err("ambiguous orgs should be rejected");
        assert!(error.contains("managed org directories"));
        assert!(
            !paths.auth_dir.join("active-org.json").exists(),
            "ambiguous repair must not silently choose a new org"
        );
    }

    #[cfg(unix)]
    #[test]
    fn virtual_oauth_refuses_symlinked_profile_ancestor() {
        let temp = tempfile::tempdir().expect("tempdir");
        let paths = science_app_profile_paths(temp.path().join("science-app-profile"));
        let escape = temp.path().join("escape");
        fs::create_dir_all(&paths.root).expect("root");
        fs::create_dir_all(&escape).expect("escape");
        std::os::unix::fs::symlink(&escape, &paths.home).expect("home symlink");

        let error = write_science_virtual_oauth(&paths, "science-client-token")
            .expect_err("symlinked profile ancestor should be rejected");

        assert!(error.contains("symlink"));
        assert!(
            !escape.join(".claude-science").exists(),
            "OAuth repair must not write through symlinked profile ancestors"
        );
    }

    #[test]
    fn first_http_url_takes_first_valid_url_token() {
        let multi = "noise\n  http://127.0.0.1:8990/?nonce=abc\nsingle-use URL expires soon";
        assert_eq!(
            first_http_url(multi).as_deref(),
            Some("http://127.0.0.1:8990/?nonce=abc")
        );

        let inline = "https://localhost:9443/path?x=1 trailing explanation";
        assert_eq!(
            first_http_url(inline).as_deref(),
            Some("https://localhost:9443/path?x=1")
        );

        assert_eq!(first_http_url("no url here"), None);
    }
}
