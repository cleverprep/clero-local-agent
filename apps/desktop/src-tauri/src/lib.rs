use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    env, fs,
    io::{BufRead, BufReader, Read},
    path::{Component, Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, State};

const PRODUCTION_BACKEND_URL: &str = "https://clero.so";
const BACKEND_RECENT_WINDOW_MS: u64 = 60_000;
const BACKEND_CONNECTING_GRACE_MS: u64 = 10_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RuntimeConfig {
    #[serde(default = "default_backend_url")]
    backend_url: String,
    #[serde(default)]
    websocket_url: String,
    #[serde(default)]
    device_token: String,
    #[serde(default = "default_device_name")]
    device_name: String,
    #[serde(default)]
    allowed_directories: Vec<String>,
    #[serde(default)]
    capabilities: CapabilityConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CapabilityConfig {
    #[serde(default)]
    browser: BrowserConfig,
    #[serde(default)]
    browser_debug: BrowserDebugConfig,
    #[serde(default)]
    workspace: WorkspaceConfig,
    #[serde(default)]
    codex: CodexConfig,
    #[serde(default)]
    git: GitConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct BrowserConfig {
    #[serde(default = "default_true")]
    enabled: bool,
    #[serde(default = "default_browser_provider")]
    provider: String,
    #[serde(default = "default_browser_channel")]
    browser_channel: String,
    #[serde(default)]
    browser_profile_dir: String,
    #[serde(default = "default_true")]
    remember_session: bool,
    #[serde(default)]
    browser_headless: bool,
    #[serde(default)]
    browser_viewport: Option<BrowserViewport>,
    #[serde(default)]
    mcp_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct BrowserViewport {
    width: u32,
    height: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct BrowserDebugConfig {
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    command: String,
    #[serde(default)]
    args: Option<Vec<String>>,
    #[serde(default)]
    browser_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WorkspaceConfig {
    #[serde(default = "default_true")]
    enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CodexConfig {
    #[serde(default)]
    enabled: bool,
    #[serde(default = "default_coding_provider")]
    provider: String,
    #[serde(default)]
    command: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    reasoning_effort: String,
    #[serde(default)]
    antigravity_command: String,
    #[serde(default)]
    claude_command: String,
    #[serde(default)]
    claude_model: String,
    #[serde(default)]
    claude_model_custom: String,
    #[serde(default)]
    claude_reasoning_effort: String,
    #[serde(default = "default_claude_permission_mode")]
    claude_permission_mode: String,
    #[serde(default = "default_codex_sandbox")]
    default_sandbox: String,
    #[serde(default)]
    allow_workspace_write: bool,
    #[serde(default)]
    allow_danger_full_access: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct GitConfig {
    #[serde(default = "default_true")]
    read_enabled: bool,
    #[serde(default)]
    write_enabled: bool,
}

#[derive(Debug, Deserialize)]
struct PairingClaimResponse {
    device_token: String,
    websocket_url: String,
}

#[derive(Debug, Clone, Serialize)]
struct DaemonProcessStatus {
    running: bool,
    pid: Option<u32>,
    backend_connected: bool,
    backend_last_seen_ms: Option<u64>,
    backend_error: Option<String>,
    last_exit_code: Option<i32>,
    log_tail: Vec<String>,
    agents_sync: Option<AgentsSyncStatus>,
}

#[derive(Debug, Clone, Serialize)]
struct DependencyStatus {
    browser: DependencyCheck,
    codex: DependencyCheck,
    claude: DependencyCheck,
    antigravity: DependencyCheck,
}

#[derive(Debug, Clone, Serialize)]
struct DependencyCheck {
    available: bool,
    label: String,
    path: Option<String>,
    version: Option<String>,
    message: String,
}

#[derive(Debug, Clone, Serialize)]
struct BrowserProfileOpenResult {
    profile_key: String,
    profile_dir: String,
}

#[derive(Debug, Clone, Serialize)]
struct AgentsSyncStatus {
    connection_id: Option<String>,
    agents: Vec<SyncedAgentStatus>,
}

#[derive(Debug, Clone, Serialize)]
struct SyncedAgentStatus {
    agent_id: String,
    name: String,
    icon: String,
    avatar_url: Option<String>,
    browser_enabled: bool,
    coding_enabled: bool,
    git_read_enabled: bool,
    git_write_enabled: bool,
    browser_profile_key: String,
}

#[derive(Default)]
struct DaemonSupervisor {
    child: Mutex<Option<Child>>,
    logs: Arc<Mutex<Vec<String>>>,
    backend_connection: Arc<Mutex<BackendConnectionState>>,
    agents_sync: Arc<Mutex<Option<AgentsSyncStatus>>>,
    last_exit_code: Mutex<Option<i32>>,
}

#[derive(Default)]
struct BackendConnectionState {
    connected: bool,
    last_seen_ms: Option<u64>,
    last_error: Option<String>,
    connecting_since_ms: Option<u64>,
}

impl Default for CapabilityConfig {
    fn default() -> Self {
        Self {
            browser: BrowserConfig::default(),
            browser_debug: BrowserDebugConfig::default(),
            workspace: WorkspaceConfig::default(),
            codex: CodexConfig::default(),
            git: GitConfig::default(),
        }
    }
}

impl Default for BrowserConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            provider: default_browser_provider(),
            browser_channel: default_browser_channel(),
            browser_profile_dir: default_browser_profile_dir().to_string_lossy().to_string(),
            remember_session: true,
            browser_headless: false,
            browser_viewport: None,
            mcp_url: None,
        }
    }
}

impl Default for BrowserDebugConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            command: String::new(),
            args: None,
            browser_url: String::new(),
        }
    }
}

impl Default for WorkspaceConfig {
    fn default() -> Self {
        Self { enabled: true }
    }
}

impl Default for CodexConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            provider: default_coding_provider(),
            command: String::new(),
            model: String::new(),
            reasoning_effort: String::new(),
            antigravity_command: String::new(),
            claude_command: String::new(),
            claude_model: String::new(),
            claude_model_custom: String::new(),
            claude_reasoning_effort: String::new(),
            claude_permission_mode: default_claude_permission_mode(),
            default_sandbox: default_codex_sandbox(),
            allow_workspace_write: false,
            allow_danger_full_access: false,
        }
    }
}

impl Default for GitConfig {
    fn default() -> Self {
        Self {
            read_enabled: true,
            write_enabled: false,
        }
    }
}

impl Default for RuntimeConfig {
    fn default() -> Self {
        Self {
            backend_url: default_backend_url(),
            websocket_url: String::new(),
            device_token: String::new(),
            device_name: default_device_name(),
            allowed_directories: default_allowed_directories(),
            capabilities: CapabilityConfig::default(),
        }
    }
}

#[tauri::command]
fn load_config(app: AppHandle) -> Result<RuntimeConfig, String> {
    let path = config_path(&app)?;
    if !path.exists() {
        return Ok(RuntimeConfig::default());
    }

    let raw = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let mut config =
        serde_json::from_str::<RuntimeConfig>(&raw).map_err(|error| error.to_string())?;
    if normalize_runtime_config(&mut config) {
        write_config(&app, &config)?;
    }
    Ok(config)
}

#[tauri::command]
fn save_config(app: AppHandle, mut config: RuntimeConfig) -> Result<RuntimeConfig, String> {
    normalize_runtime_config(&mut config);
    write_config(&app, &config)?;
    Ok(config)
}

#[tauri::command]
fn check_dependencies(config: RuntimeConfig) -> DependencyStatus {
    dependency_status(&config)
}

fn write_config(app: &AppHandle, config: &RuntimeConfig) -> Result<(), String> {
    let path = config_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let raw = serde_json::to_string_pretty(&config).map_err(|error| error.to_string())?;
    fs::write(path, format!("{raw}\n")).map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
async fn pair_runtime(
    app: AppHandle,
    code: String,
    mut config: RuntimeConfig,
) -> Result<RuntimeConfig, String> {
    normalize_runtime_config(&mut config);
    let pairing_code = code.trim();
    if pairing_code.is_empty() {
        return Err("Pairing code is required".to_string());
    }
    if !config.device_token.trim().is_empty() || !config.websocket_url.trim().is_empty() {
        return Err("Remove the existing connection before pairing a new one.".to_string());
    }
    validate_enabled_dependencies(&config)?;

    write_config(&app, &config)?;
    let capabilities = runtime_capabilities(&app)?;
    let url = format!(
        "{}/api/v1/integrations/local-runtime/claim/",
        config.backend_url.trim_end_matches('/')
    );
    let body = json!({
        "pairing_code": pairing_code,
        "device_name": config.device_name,
        "platform": std::env::consts::OS,
        "daemon_version": env!("CARGO_PKG_VERSION"),
        "capabilities": { "tools": capabilities }
    });
    let response = reqwest::Client::new()
        .post(url)
        .json(&body)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!(
            "Pairing failed with HTTP {}{}",
            status.as_u16(),
            if body.is_empty() {
                String::new()
            } else {
                format!(": {body}")
            }
        ));
    }

    let claim = response
        .json::<PairingClaimResponse>()
        .await
        .map_err(|error| error.to_string())?;
    if is_local_endpoint(&claim.websocket_url) {
        return Err(
            "Clero returned a local WebSocket URL. Use a production Clero connection code."
                .to_string(),
        );
    }
    let mut next_config = config;
    next_config.device_token = claim.device_token;
    next_config.websocket_url = claim.websocket_url;
    save_config(app, next_config)
}

#[tauri::command]
fn start_daemon(
    app: AppHandle,
    state: State<'_, DaemonSupervisor>,
    mut config: RuntimeConfig,
) -> Result<DaemonProcessStatus, String> {
    normalize_runtime_config(&mut config);
    if config.device_token.trim().is_empty() || config.websocket_url.trim().is_empty() {
        return Err("Pair the runtime before starting the daemon.".to_string());
    }
    validate_enabled_dependencies(&config)?;

    save_config(app.clone(), config)?;
    if current_daemon_status(&state)?.running {
        return current_daemon_status(&state);
    }

    let config_path = config_path(&app)?;
    let mut command = daemon_command(&config_path)?;
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    begin_backend_connection(&state.backend_connection);
    set_agents_sync(&state.agents_sync, None);
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let pid = child.id();

    if let Some(stdout) = child.stdout.take() {
        collect_daemon_output(
            "stdout",
            stdout,
            state.logs.clone(),
            state.backend_connection.clone(),
            state.agents_sync.clone(),
        );
    }
    if let Some(stderr) = child.stderr.take() {
        collect_daemon_output(
            "stderr",
            stderr,
            state.logs.clone(),
            state.backend_connection.clone(),
            state.agents_sync.clone(),
        );
    }

    push_log_tail(&state.logs, format!("process: daemon started pid={pid}"));
    *state
        .last_exit_code
        .lock()
        .map_err(|error| error.to_string())? = None;
    *state.child.lock().map_err(|error| error.to_string())? = Some(child);

    current_daemon_status(&state)
}

#[tauri::command]
fn stop_daemon(state: State<'_, DaemonSupervisor>) -> Result<DaemonProcessStatus, String> {
    stop_daemon_process(&state)
}

#[tauri::command]
fn reset_browser_session(
    app: AppHandle,
    state: State<'_, DaemonSupervisor>,
    mut config: RuntimeConfig,
) -> Result<DaemonProcessStatus, String> {
    normalize_runtime_config(&mut config);
    if !config.capabilities.browser.remember_session {
        return Err("Turn on browser session memory before resetting it.".to_string());
    }

    let profile_dir = PathBuf::from(config.capabilities.browser.browser_profile_dir.clone());
    validate_browser_profile_reset_path(&profile_dir)?;
    save_config(app, config)?;
    let _ = stop_daemon_process(&state)?;

    if profile_dir.exists() {
        fs::remove_dir_all(&profile_dir).map_err(|error| error.to_string())?;
    }
    push_log_tail(
        &state.logs,
        format!(
            "process: browser session reset profile_dir={}",
            profile_dir.display()
        ),
    );

    current_daemon_status(&state)
}

#[tauri::command]
fn open_browser_profile(
    mut config: RuntimeConfig,
    profile_key: String,
) -> Result<BrowserProfileOpenResult, String> {
    normalize_runtime_config(&mut config);
    if !config.capabilities.browser.remember_session {
        return Err("Turn on browser session memory before opening agent profiles.".to_string());
    }

    let profile_key = normalize_browser_profile_key(&profile_key)?;
    let profile_root = PathBuf::from(config.capabilities.browser.browser_profile_dir.clone());
    let profile_dir = profile_root.join(&profile_key);
    validate_browser_profile_reset_path(&profile_dir)?;
    fs::create_dir_all(&profile_dir).map_err(|error| error.to_string())?;
    launch_browser_profile(&config.capabilities.browser.browser_channel, &profile_dir)?;

    Ok(BrowserProfileOpenResult {
        profile_key,
        profile_dir: profile_dir.to_string_lossy().to_string(),
    })
}

fn stop_daemon_process(state: &State<'_, DaemonSupervisor>) -> Result<DaemonProcessStatus, String> {
    let mut child_guard = state.child.lock().map_err(|error| error.to_string())?;
    if let Some(mut child) = child_guard.take() {
        let _ = child.kill();
        let status = child.wait().map_err(|error| error.to_string())?;
        clear_backend_connection(&state.backend_connection);
        set_agents_sync(&state.agents_sync, None);
        *state
            .last_exit_code
            .lock()
            .map_err(|error| error.to_string())? = status.code();
        push_log_tail(
            &state.logs,
            format!(
                "process: daemon stopped exit_code={}",
                status
                    .code()
                    .map(|code| code.to_string())
                    .unwrap_or_else(|| "signal".to_string())
            ),
        );
    }
    drop(child_guard);
    current_daemon_status(&state)
}

#[tauri::command]
fn daemon_status(state: State<'_, DaemonSupervisor>) -> Result<DaemonProcessStatus, String> {
    current_daemon_status(&state)
}

pub fn run() {
    tauri::Builder::default()
        .manage(DaemonSupervisor::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            load_config,
            save_config,
            check_dependencies,
            pair_runtime,
            start_daemon,
            stop_daemon,
            reset_browser_session,
            open_browser_profile,
            daemon_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running Clero Local Agent desktop app");
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?
        .join("config.json"))
}

fn current_daemon_status(
    state: &State<'_, DaemonSupervisor>,
) -> Result<DaemonProcessStatus, String> {
    let mut child_guard = state.child.lock().map_err(|error| error.to_string())?;
    let mut running = false;
    let mut pid = None;

    if let Some(child) = child_guard.as_mut() {
        match child.try_wait().map_err(|error| error.to_string())? {
            Some(status) => {
                set_backend_connection_error(
                    &state.backend_connection,
                    format!(
                        "Runtime process exited before Clero confirmed the connection (exit code {}). Open logs for details.",
                        status
                            .code()
                            .map(|code| code.to_string())
                            .unwrap_or_else(|| "signal".to_string())
                    ),
                );
                set_agents_sync(&state.agents_sync, None);
                *state
                    .last_exit_code
                    .lock()
                    .map_err(|error| error.to_string())? = status.code();
                push_log_tail(
                    &state.logs,
                    format!(
                        "process: daemon exited exit_code={}",
                        status
                            .code()
                            .map(|code| code.to_string())
                            .unwrap_or_else(|| "signal".to_string())
                    ),
                );
                *child_guard = None;
            }
            None => {
                running = true;
                pid = Some(child.id());
            }
        }
    }

    let last_exit_code = *state
        .last_exit_code
        .lock()
        .map_err(|error| error.to_string())?;
    let connection = state
        .backend_connection
        .lock()
        .map_err(|error| error.to_string())?;
    let backend_recent = connection
        .last_seen_ms
        .and_then(|last_seen| now_ms().map(|now| now.saturating_sub(last_seen) <= BACKEND_RECENT_WINDOW_MS))
        .unwrap_or(false);
    let backend_connected = running && connection.connected && backend_recent;
    let backend_last_seen_ms = connection.last_seen_ms;
    let backend_error = backend_connection_status_message(
        running,
        backend_connected,
        connection.connected,
        connection.last_seen_ms,
        connection.connecting_since_ms,
        connection.last_error.clone(),
    );
    drop(connection);
    let log_tail = state
        .logs
        .lock()
        .map_err(|error| error.to_string())?
        .clone();
    let agents_sync = state
        .agents_sync
        .lock()
        .map_err(|error| error.to_string())?
        .clone();
    Ok(DaemonProcessStatus {
        running,
        pid,
        backend_connected,
        backend_last_seen_ms,
        backend_error,
        last_exit_code,
        log_tail,
        agents_sync,
    })
}

fn daemon_command(config_path: &Path) -> Result<Command, String> {
    runtime_cli_command(config_path, "daemon")
}

fn runtime_capabilities(app: &AppHandle) -> Result<serde_json::Value, String> {
    let config_path = config_path(app)?;
    let output = runtime_cli_command(&config_path, "capabilities")?
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    serde_json::from_slice(&output.stdout).map_err(|error| error.to_string())
}

fn runtime_cli_command(config_path: &Path, subcommand: &str) -> Result<Command, String> {
    if let Ok(binary_path) = std::env::var("CLERO_LOCAL_AGENT_DAEMON_BIN") {
        let mut command = Command::new(binary_path);
        command
            .arg(subcommand)
            .arg("--config")
            .arg(config_path)
            .env("PATH", runtime_path_env());
        return Ok(command);
    }

    if let Some(binary_path) = packaged_daemon_bin() {
        let mut command = Command::new(binary_path);
        command
            .arg(subcommand)
            .arg("--config")
            .arg(config_path)
            .env("PATH", runtime_path_env());
        return Ok(command);
    }

    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let cli_path = repo_root.join("apps/cli/src/main.ts");
    let mut command = Command::new("node");
    command
        .arg("--experimental-strip-types")
        .arg(cli_path)
        .arg(subcommand)
        .arg("--config")
        .arg(config_path)
        .env("PATH", runtime_path_env())
        .current_dir(repo_root);
    Ok(command)
}

fn packaged_daemon_bin() -> Option<PathBuf> {
    let exe_dir = env::current_exe().ok()?.parent()?.to_path_buf();
    let names = [
        "clero-local-agent-daemon",
        "clero-local-agent-daemon-aarch64-apple-darwin",
        "clero-local-agent-daemon-x86_64-apple-darwin",
    ];

    names
        .iter()
        .map(|name| exe_dir.join(name))
        .find(|candidate| candidate.is_file())
}

fn runtime_path_env() -> String {
    let common_paths = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
    match std::env::var("PATH") {
        Ok(existing) if !existing.trim().is_empty() => format!("{common_paths}:{existing}"),
        _ => common_paths.to_string(),
    }
}

fn collect_daemon_output<R>(
    source: &'static str,
    stream: R,
    logs: Arc<Mutex<Vec<String>>>,
    backend_connection: Arc<Mutex<BackendConnectionState>>,
    agents_sync: Arc<Mutex<Option<AgentsSyncStatus>>>,
) where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let reader = BufReader::new(stream);
        for line in reader.lines().map_while(Result::ok) {
            update_backend_connection_from_log(&backend_connection, &line);
            update_agents_sync_from_log(&agents_sync, &line);
            push_log_tail(&logs, format!("{source}: {line}"));
        }
    });
}

fn push_log_tail(logs: &Arc<Mutex<Vec<String>>>, line: String) {
    if let Ok(mut log_tail) = logs.lock() {
        log_tail.push(line);
        while log_tail.len() > 600 {
            log_tail.remove(0);
        }
    }
}

fn update_backend_connection_from_log(connection: &Arc<Mutex<BackendConnectionState>>, line: &str) {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
        return;
    };

    let message = value
        .get("message")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let inbound_type = value
        .get("inbound")
        .and_then(|inbound| inbound.get("type"))
        .and_then(serde_json::Value::as_str);

    if is_backend_ready_signal(message, inbound_type) {
        set_backend_connection(connection, true, now_ms());
        return;
    }

    if let Some(error) = connection_error_from_inbound(value.get("inbound")) {
        set_backend_connection_error(connection, error);
        return;
    }

    if let Some(error) = connection_error_from_log(&value, message) {
        set_backend_connection_error(connection, error);
    }
}

fn is_backend_ready_signal(message: &str, inbound_type: Option<&str>) -> bool {
    matches!(
        message,
        "local runtime session established"
            | "local runtime websocket authenticated"
            | "local runtime hello acknowledged"
            | "local runtime agents synchronized"
    ) || matches!(
        inbound_type,
        Some(
            "connected"
                | "auth_ack"
                | "authenticated"
                | "hello_ack"
                | "agents_sync"
                | "heartbeat_ack"
                | "tool_call"
                | "approval_response"
        )
    )
}

fn connection_error_from_inbound(inbound: Option<&serde_json::Value>) -> Option<String> {
    let inbound = inbound?;
    if inbound.get("type").and_then(serde_json::Value::as_str) != Some("error") {
        return None;
    }

    let code =
        json_string(inbound.get("error_code")).unwrap_or_else(|| "backend_error".to_string());
    if !is_connection_error_code(&code) {
        return None;
    }
    let message = json_string(inbound.get("message"))
        .unwrap_or_else(|| "Clero rejected the runtime connection.".to_string());
    Some(format!("Clero rejected the connection ({code}): {message}"))
}

fn connection_error_from_log(value: &serde_json::Value, message: &str) -> Option<String> {
    match message {
        "local runtime websocket closed" => Some(
            "Connection to Clero closed. The app will retry automatically; check internet, VPN, firewall, or proxy settings if this repeats."
                .to_string(),
        ),
        "local runtime websocket error" => {
            let detail = json_string(value.get("event")).unwrap_or_default();
            if detail.is_empty() {
                Some(
                    "Could not open the WebSocket connection to Clero. Check internet, VPN, firewall, or proxy settings."
                        .to_string(),
                )
            } else {
                Some(format!(
                    "Could not open the WebSocket connection to Clero: {detail}"
                ))
            }
        }
        "local runtime websocket heartbeat timed out" => Some(
            "Clero stopped responding to runtime heartbeats for more than 60 seconds. The app is reconnecting."
                .to_string(),
        ),
        "failed to send local runtime heartbeat" => {
            let detail = json_string(value.get("error"))
                .unwrap_or_else(|| "WebSocket is not connected".to_string());
            Some(format!("Failed to send a heartbeat to Clero: {detail}"))
        }
        "local runtime backend error" => {
            let code =
                json_string(value.get("errorCode")).unwrap_or_else(|| "backend_error".to_string());
            if !is_connection_error_code(&code) {
                return None;
            }
            let detail = json_string(value.get("backendMessage"))
                .unwrap_or_else(|| "Clero rejected the runtime connection.".to_string());
            Some(format!("Clero rejected the connection ({code}): {detail}"))
        }
        "failed to handle runtime message" => {
            let detail = json_string(value.get("error"))
                .unwrap_or_else(|| "Unknown runtime message error".to_string());
            Some(format!("Failed to handle a Clero runtime message: {detail}"))
        }
        _ => None,
    }
}

fn is_connection_error_code(code: &str) -> bool {
    let normalized = code.to_ascii_lowercase();
    normalized.contains("auth")
        || normalized.contains("token")
        || normalized.contains("unauthorized")
        || normalized.contains("forbidden")
        || normalized.contains("connection")
        || normalized.contains("session")
        || normalized == "invalid_device"
        || normalized == "device_disabled"
}

fn set_backend_connection(
    connection: &Arc<Mutex<BackendConnectionState>>,
    connected: bool,
    last_seen_ms: Option<u64>,
) {
    if let Ok(mut state) = connection.lock() {
        state.connected = connected;
        if let Some(last_seen_ms) = last_seen_ms {
            state.last_seen_ms = Some(last_seen_ms);
        } else if !connected {
            state.last_seen_ms = None;
        }
        if connected {
            state.last_error = None;
            state.connecting_since_ms = None;
        }
    }
}

fn set_backend_connection_error(connection: &Arc<Mutex<BackendConnectionState>>, detail: String) {
    if let Ok(mut state) = connection.lock() {
        state.connected = false;
        state.last_error = Some(detail);
        if state.connecting_since_ms.is_none() {
            state.connecting_since_ms = now_ms();
        }
    }
}

fn begin_backend_connection(connection: &Arc<Mutex<BackendConnectionState>>) {
    if let Ok(mut state) = connection.lock() {
        state.connected = false;
        state.last_seen_ms = None;
        state.last_error = None;
        state.connecting_since_ms = now_ms();
    }
}

fn clear_backend_connection(connection: &Arc<Mutex<BackendConnectionState>>) {
    if let Ok(mut state) = connection.lock() {
        state.connected = false;
        state.last_seen_ms = None;
        state.last_error = None;
        state.connecting_since_ms = None;
    }
}

fn backend_connection_status_message(
    running: bool,
    backend_connected: bool,
    websocket_connected: bool,
    last_seen_ms: Option<u64>,
    connecting_since_ms: Option<u64>,
    last_error: Option<String>,
) -> Option<String> {
    if let Some(error) = last_error {
        return Some(error);
    }
    if !running || backend_connected {
        return None;
    }

    if websocket_connected && last_seen_ms.is_some() {
        return Some(
            "Connection looks stale: no Clero message has been received for over 60 seconds. The daemon will reconnect automatically."
                .to_string(),
        );
    }

    if let (Some(started_at), Some(now)) = (connecting_since_ms, now_ms()) {
        if now.saturating_sub(started_at) >= BACKEND_CONNECTING_GRACE_MS {
            return Some(
                "Clero has not confirmed the runtime connection yet. The laptop may be offline, a VPN/proxy/firewall may be blocking WebSocket traffic, or the saved device token may no longer be accepted."
                    .to_string(),
            );
        }
    }

    Some(
        "Opening secure WebSocket connection to Clero. If this stays here, check internet, VPN, firewall, or proxy settings."
            .to_string(),
    )
}

fn set_agents_sync(
    agents_sync: &Arc<Mutex<Option<AgentsSyncStatus>>>,
    next_sync: Option<AgentsSyncStatus>,
) {
    if let Ok(mut state) = agents_sync.lock() {
        *state = next_sync;
    }
}

fn update_agents_sync_from_log(
    agents_sync: &Arc<Mutex<Option<AgentsSyncStatus>>>,
    line: &str,
) {
    if let Some(next_sync) = parse_agents_sync_log(line) {
        set_agents_sync(agents_sync, Some(next_sync));
    }
}

fn parse_agents_sync_log(line: &str) -> Option<AgentsSyncStatus> {
    let value = serde_json::from_str::<serde_json::Value>(line).ok()?;
    let inbound = value.get("inbound")?;
    if inbound.get("type").and_then(serde_json::Value::as_str) != Some("agents_sync") {
        return None;
    }

    let connection_id = json_scalar_to_string(inbound.get("connection_id"));
    let agents = inbound
        .get("agents")
        .and_then(serde_json::Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(parse_synced_agent_status)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Some(AgentsSyncStatus {
        connection_id,
        agents,
    })
}

fn parse_synced_agent_status(value: &serde_json::Value) -> Option<SyncedAgentStatus> {
    let agent_id = json_scalar_to_string(value.get("agent_id"))?;
    Some(SyncedAgentStatus {
        agent_id: agent_id.clone(),
        name: json_string(value.get("name")).unwrap_or_else(|| format!("Agent {agent_id}")),
        icon: json_string(value.get("icon")).unwrap_or_default(),
        avatar_url: json_string(value.get("avatar_url")),
        browser_enabled: json_bool(value.get("browser_enabled")),
        coding_enabled: json_bool(value.get("coding_enabled")),
        git_read_enabled: json_bool(value.get("git_read_enabled")),
        git_write_enabled: json_bool(value.get("git_write_enabled")),
        browser_profile_key: json_string(value.get("browser_profile_key"))
            .unwrap_or_else(|| format!("agent-{agent_id}")),
    })
}

fn json_string(value: Option<&serde_json::Value>) -> Option<String> {
    value.and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn json_scalar_to_string(value: Option<&serde_json::Value>) -> Option<String> {
    match value {
        Some(serde_json::Value::String(text)) if !text.is_empty() => Some(text.clone()),
        Some(serde_json::Value::Number(number)) => Some(number.to_string()),
        _ => None,
    }
}

fn json_bool(value: Option<&serde_json::Value>) -> bool {
    value.and_then(serde_json::Value::as_bool).unwrap_or(false)
}

fn validate_enabled_dependencies(config: &RuntimeConfig) -> Result<(), String> {
    let status = dependency_status(config);
    if config.capabilities.browser.enabled && !status.browser.available {
        return Err(status.browser.message);
    }
    if config.capabilities.codex.enabled
        && config.capabilities.codex.provider == "claude-code"
        && !status.claude.available
    {
        return Err(status.claude.message);
    }
    if config.capabilities.codex.enabled
        && config.capabilities.codex.provider == "antigravity"
        && !status.antigravity.available
    {
        return Err(status.antigravity.message);
    }
    if config.capabilities.codex.enabled
        && config.capabilities.codex.provider != "claude-code"
        && config.capabilities.codex.provider != "antigravity"
        && !status.codex.available
    {
        return Err(status.codex.message);
    }
    Ok(())
}

fn dependency_status(config: &RuntimeConfig) -> DependencyStatus {
    DependencyStatus {
        browser: check_browser_dependency(&config.capabilities.browser.browser_channel),
        codex: check_codex_dependency(&config.capabilities.codex.command),
        claude: check_claude_dependency(&config.capabilities.codex.claude_command),
        antigravity: check_antigravity_dependency(&config.capabilities.codex.antigravity_command),
    }
}

fn check_browser_dependency(channel: &str) -> DependencyCheck {
    let label = match channel {
        "chrome-beta" => "Chrome Beta",
        "msedge" => "Microsoft Edge",
        "chromium" => "Chromium",
        _ => "Google Chrome",
    };
    let candidates = browser_candidates(channel);
    for candidate in candidates {
        if candidate.exists() {
            return DependencyCheck {
                available: true,
                label: label.to_string(),
                path: Some(candidate.to_string_lossy().to_string()),
                version: None,
                message: format!("{label} is installed."),
            };
        }
    }

    DependencyCheck {
        available: false,
        label: label.to_string(),
        path: None,
        version: None,
        message: format!("Install {label} before enabling Browser."),
    }
}

fn check_codex_dependency(configured_command: &str) -> DependencyCheck {
    let mut candidates = Vec::new();
    push_command_candidate(&mut candidates, configured_command);
    push_command_candidate(
        &mut candidates,
        &env::var("CLERO_LOCAL_AGENT_CODEX_BIN").unwrap_or_default(),
    );
    push_command_candidate(&mut candidates, "codex");

    if let Some(home) = dirs::home_dir() {
        push_path_candidate(&mut candidates, home.join(".codex/bin/codex"));
        push_path_candidate(&mut candidates, home.join(".local/bin/codex"));
        push_path_candidate(&mut candidates, home.join(".npm-global/bin/codex"));
    }
    push_path_candidate(&mut candidates, PathBuf::from("/opt/homebrew/bin/codex"));
    push_path_candidate(&mut candidates, PathBuf::from("/usr/local/bin/codex"));

    for candidate in candidates {
        if let Some((path, version)) = command_version(&candidate, "--version") {
            return DependencyCheck {
                available: true,
                label: "Codex CLI".to_string(),
                path: Some(path),
                version,
                message: "Codex CLI is installed.".to_string(),
            };
        }
    }

    DependencyCheck {
        available: false,
        label: "Codex CLI".to_string(),
        path: None,
        version: None,
        message: "Install Codex CLI before enabling Codex.".to_string(),
    }
}

fn check_claude_dependency(configured_command: &str) -> DependencyCheck {
    let mut candidates = Vec::new();
    push_command_candidate(&mut candidates, configured_command);
    push_command_candidate(
        &mut candidates,
        &env::var("CLERO_LOCAL_AGENT_CLAUDE_BIN").unwrap_or_default(),
    );
    push_command_candidate(&mut candidates, "claude");

    if let Some(home) = dirs::home_dir() {
        push_path_candidate(&mut candidates, home.join(".local/bin/claude"));
        push_path_candidate(&mut candidates, home.join(".npm-global/bin/claude"));
    }
    push_path_candidate(&mut candidates, PathBuf::from("/opt/homebrew/bin/claude"));
    push_path_candidate(&mut candidates, PathBuf::from("/usr/local/bin/claude"));

    for candidate in candidates {
        if let Some((path, version)) = command_version(&candidate, "--version") {
            return DependencyCheck {
                available: true,
                label: "Claude Code".to_string(),
                path: Some(path),
                version,
                message: "Claude Code is installed.".to_string(),
            };
        }
    }

    DependencyCheck {
        available: false,
        label: "Claude Code".to_string(),
        path: None,
        version: None,
        message: "Install Claude Code before enabling Claude Code.".to_string(),
    }
}

fn check_antigravity_dependency(configured_command: &str) -> DependencyCheck {
    let mut candidates = Vec::new();
    push_command_candidate(&mut candidates, configured_command);
    push_command_candidate(
        &mut candidates,
        &env::var("CLERO_LOCAL_AGENT_ANTIGRAVITY_BIN").unwrap_or_default(),
    );
    push_command_candidate(&mut candidates, "agy");
    push_command_candidate(&mut candidates, "antigravity");

    if let Some(home) = dirs::home_dir() {
        push_path_candidate(&mut candidates, home.join(".gemini/antigravity-cli/bin/agy"));
        push_path_candidate(&mut candidates, home.join(".local/bin/agy"));
        push_path_candidate(&mut candidates, home.join(".npm-global/bin/agy"));
    }
    push_path_candidate(&mut candidates, PathBuf::from("/opt/homebrew/bin/agy"));
    push_path_candidate(&mut candidates, PathBuf::from("/usr/local/bin/agy"));

    for candidate in candidates {
        if let Some((path, version)) = command_version(&candidate, "--version") {
            return DependencyCheck {
                available: true,
                label: "Antigravity CLI".to_string(),
                path: Some(path),
                version,
                message: "Antigravity CLI is installed.".to_string(),
            };
        }
    }

    DependencyCheck {
        available: false,
        label: "Antigravity CLI".to_string(),
        path: None,
        version: None,
        message: "Install Antigravity CLI before enabling Antigravity.".to_string(),
    }
}

fn browser_candidates(channel: &str) -> Vec<PathBuf> {
    match env::consts::OS {
        "macos" => browser_candidates_macos(channel),
        "windows" => browser_candidates_windows(channel),
        _ => browser_candidates_unix(channel),
    }
}

fn browser_candidates_macos(channel: &str) -> Vec<PathBuf> {
    let app_name = match channel {
        "chrome-beta" => "Google Chrome Beta.app",
        "msedge" => "Microsoft Edge.app",
        "chromium" => "Chromium.app",
        _ => "Google Chrome.app",
    };
    let mut candidates = vec![PathBuf::from("/Applications").join(app_name)];
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join("Applications").join(app_name));
    }
    candidates
}

fn browser_candidates_windows(channel: &str) -> Vec<PathBuf> {
    let relative = match channel {
        "msedge" => "Microsoft\\Edge\\Application\\msedge.exe",
        "chromium" => "Chromium\\Application\\chrome.exe",
        _ => "Google\\Chrome\\Application\\chrome.exe",
    };
    let mut candidates = Vec::new();
    for key in ["ProgramFiles", "ProgramFiles(x86)", "LocalAppData"] {
        if let Ok(root) = env::var(key) {
            candidates.push(PathBuf::from(root).join(relative));
        }
    }
    candidates
}

fn browser_candidates_unix(channel: &str) -> Vec<PathBuf> {
    let names: &[&str] = match channel {
        "msedge" => &["microsoft-edge", "microsoft-edge-stable"],
        "chromium" => &["chromium", "chromium-browser"],
        _ => &["google-chrome", "google-chrome-stable", "chrome"],
    };
    names.iter().filter_map(|name| find_on_path(name)).collect()
}

fn normalize_browser_profile_key(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("Browser profile key is required.".to_string());
    }
    if trimmed.len() > 96 {
        return Err("Browser profile key is too long.".to_string());
    }
    if !trimmed
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || character == '-' || character == '_')
    {
        return Err("Browser profile key contains unsupported characters.".to_string());
    }
    Ok(trimmed.to_string())
}

fn launch_browser_profile(channel: &str, profile_dir: &Path) -> Result<(), String> {
    let label = match channel {
        "chrome-beta" => "Chrome Beta",
        "msedge" => "Microsoft Edge",
        "chromium" => "Chromium",
        _ => "Google Chrome",
    };
    let browser = browser_candidates(channel)
        .into_iter()
        .find(|candidate| candidate.exists())
        .ok_or_else(|| format!("Install {label} before opening agent profiles."))?;
    let user_data_dir = format!("--user-data-dir={}", profile_dir.display());
    let remote_debugging_address = "--remote-debugging-address=127.0.0.1";
    let remote_debugging_port = format!(
        "--remote-debugging-port={}",
        browser_profile_debug_port(profile_dir)
    );
    let profile_args = [
        user_data_dir.as_str(),
        remote_debugging_address,
        remote_debugging_port.as_str(),
        "--password-store=basic",
        "--use-mock-keychain",
        "--disable-sync",
        "--no-first-run",
        "about:blank",
    ];

    #[cfg(target_os = "macos")]
    {
        let mut command = Command::new("open");
        command.arg("-n").arg(&browser).arg("--args");
        command.args(profile_args);
        command
            .spawn()
            .map_err(|error| error.to_string())?;
        return Ok(());
    }

    #[cfg(not(target_os = "macos"))]
    {
        Command::new(browser)
            .args(profile_args)
            .spawn()
            .map_err(|error| error.to_string())?;
        Ok(())
    }
}

fn browser_profile_debug_port(profile_dir: &Path) -> u16 {
    let mut hash: u32 = 2_166_136_261;
    for byte in profile_dir.to_string_lossy().as_bytes() {
        hash ^= u32::from(*byte);
        hash = hash.wrapping_mul(16_777_619);
    }
    40_000 + (hash % 20_000) as u16
}

fn push_command_candidate(candidates: &mut Vec<PathBuf>, command: &str) {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return;
    }
    let path = PathBuf::from(trimmed);
    if path.components().count() > 1 || path.is_absolute() {
        push_path_candidate(candidates, path);
        return;
    }
    if let Some(found) = find_on_path(trimmed) {
        push_path_candidate(candidates, found);
    }
    push_path_candidate(candidates, path);
}

fn push_path_candidate(candidates: &mut Vec<PathBuf>, path: PathBuf) {
    if !candidates.iter().any(|candidate| candidate == &path) {
        candidates.push(path);
    }
}

fn find_on_path(command: &str) -> Option<PathBuf> {
    let path = env::var_os("PATH")?;
    for directory in env::split_paths(&path) {
        let candidate = directory.join(command);
        if candidate.exists() {
            return Some(candidate);
        }
        #[cfg(windows)]
        {
            let candidate = directory.join(format!("{command}.exe"));
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }
    None
}

fn command_version(command: &Path, flag: &str) -> Option<(String, Option<String>)> {
    let output = Command::new(command).arg(flag).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let version = stdout
        .lines()
        .chain(stderr.lines())
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with("WARNING:"))
        .map(str::to_string);
    Some((command.to_string_lossy().to_string(), version))
}

fn default_backend_url() -> String {
    match option_env!("CLERO_BACKEND_URL").map(str::trim) {
        Some(url) if !url.is_empty() && !is_local_endpoint(url) => {
            url.trim_end_matches('/').to_string()
        }
        _ => PRODUCTION_BACKEND_URL.to_string(),
    }
}

fn is_local_endpoint(value: &str) -> bool {
    let normalized = value.trim().to_ascii_lowercase();
    normalized.contains("localhost")
        || normalized.contains("127.0.0.1")
        || normalized.contains("0.0.0.0")
        || normalized.contains("[::1]")
}

fn normalize_runtime_config(config: &mut RuntimeConfig) -> bool {
    let mut changed = false;
    let backend = config.backend_url.trim().trim_end_matches('/').to_string();
    let backend_was_local = is_local_endpoint(&backend);

    if backend.is_empty() || backend_was_local || backend == "https://api.clero.so" {
        config.backend_url = default_backend_url();
        changed = true;
    } else if backend != config.backend_url {
        config.backend_url = backend;
        changed = true;
    }

    if backend_was_local || is_local_endpoint(&config.websocket_url) {
        if !config.websocket_url.is_empty() || !config.device_token.is_empty() {
            config.websocket_url.clear();
            config.device_token.clear();
            changed = true;
        }
    }

    if config.capabilities.browser.provider == "mcp-chrome" {
        config.capabilities.browser.provider = default_browser_provider();
        config.capabilities.browser.mcp_url = None;
        changed = true;
    }

    let browser_debug_command = config.capabilities.browser_debug.command.trim().to_string();
    if browser_debug_command != config.capabilities.browser_debug.command {
        config.capabilities.browser_debug.command = browser_debug_command;
        changed = true;
    }
    let browser_debug_url = config.capabilities.browser_debug.browser_url.trim().to_string();
    if browser_debug_url != config.capabilities.browser_debug.browser_url {
        config.capabilities.browser_debug.browser_url = browser_debug_url;
        changed = true;
    }

    let browser_profile_dir = config
        .capabilities
        .browser
        .browser_profile_dir
        .trim()
        .to_string();
    if config.capabilities.browser.remember_session {
        let normalized_profile_dir = if browser_profile_dir.is_empty() {
            default_browser_profile_dir().to_string_lossy().to_string()
        } else {
            browser_profile_dir
        };
        if normalized_profile_dir != config.capabilities.browser.browser_profile_dir {
            config.capabilities.browser.browser_profile_dir = normalized_profile_dir;
            changed = true;
        }
    } else if browser_profile_dir != config.capabilities.browser.browser_profile_dir {
        config.capabilities.browser.browser_profile_dir = browser_profile_dir;
        changed = true;
    }

    if config.allowed_directories.is_empty() {
        let default_directories = default_allowed_directories();
        if !default_directories.is_empty() {
            config.allowed_directories = default_directories;
            changed = true;
        }
    }

    if config.capabilities.codex.provider == "codex" || config.capabilities.codex.provider == "antigravity" {
        if config.capabilities.codex.allow_workspace_write
            && config.capabilities.codex.default_sandbox == "read-only"
        {
            config.capabilities.codex.default_sandbox = "workspace-write".to_string();
            changed = true;
        }
        if config.capabilities.codex.default_sandbox == "workspace-write"
            && !config.capabilities.codex.allow_workspace_write
        {
            config.capabilities.codex.allow_workspace_write = true;
            changed = true;
        }
        if config.capabilities.codex.default_sandbox == "danger-full-access" {
            if !config.capabilities.codex.allow_workspace_write {
                config.capabilities.codex.allow_workspace_write = true;
                changed = true;
            }
            if !config.capabilities.codex.allow_danger_full_access {
                config.capabilities.codex.allow_danger_full_access = true;
                changed = true;
            }
        }
    }

    changed
}

fn default_device_name() -> String {
    hostname::get()
        .ok()
        .and_then(|name| name.into_string().ok())
        .unwrap_or_else(|| "Local machine".to_string())
}

fn default_allowed_directories() -> Vec<String> {
    dirs::home_dir()
        .map(|home| home.join("Projects"))
        .filter(|projects| projects.is_dir())
        .map(|projects| vec![projects.to_string_lossy().to_string()])
        .unwrap_or_default()
}

fn default_browser_profile_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".clero-local-agent")
        .join("browser-profile")
}

fn validate_browser_profile_reset_path(profile_dir: &Path) -> Result<(), String> {
    if !profile_dir.is_absolute() {
        return Err("Browser profile path must be absolute before it can be reset.".to_string());
    }
    if profile_dir
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("Browser profile path cannot contain parent directory segments.".to_string());
    }

    let managed_root = dirs::home_dir()
        .ok_or_else(|| "Could not resolve the home directory.".to_string())?
        .join(".clero-local-agent");
    if profile_dir == managed_root || !profile_dir.starts_with(&managed_root) {
        return Err("Reset is limited to Clero managed browser profiles.".to_string());
    }

    Ok(())
}

fn now_ms() -> Option<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
}

fn default_true() -> bool {
    true
}

fn default_browser_provider() -> String {
    "managed".to_string()
}

fn default_browser_channel() -> String {
    "chrome".to_string()
}

fn default_coding_provider() -> String {
    "codex".to_string()
}

fn default_codex_sandbox() -> String {
    "read-only".to_string()
}

fn default_claude_permission_mode() -> String {
    "default".to_string()
}
