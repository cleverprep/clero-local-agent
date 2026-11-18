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
    shell: ShellConfig,
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
struct ShellConfig {
    #[serde(default)]
    enabled: bool,
    #[serde(default = "default_shell_access")]
    default_access: String,
    #[serde(default)]
    allow_workspace_write: bool,
    #[serde(default)]
    allow_danger_full_access: bool,
    #[serde(default = "default_shell_timeout_ms")]
    timeout_ms: u32,
    #[serde(default = "default_shell_max_output_bytes")]
    max_output_bytes: u32,
    #[serde(default)]
    shell: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CodexConfig {
    #[serde(default)]
    enabled: bool,
    /// Default harness, used when a coding task does not name one.
    #[serde(default = "default_coding_provider")]
    provider: String,
    /// Enabled harnesses. Older configs omit it; normalization fills in `[provider]`.
    #[serde(default)]
    providers: Vec<String>,
    #[serde(default)]
    command: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    reasoning_effort: String,
    #[serde(default)]
    antigravity_command: String,
    #[serde(default)]
    cursor_command: String,
    #[serde(default)]
    cursor_model: String,
    #[serde(default)]
    cursor_model_custom: String,
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
    cursor: DependencyCheck,
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
struct CodingModelOption {
    id: String,
    label: String,
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
            shell: ShellConfig::default(),
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

impl Default for ShellConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            default_access: default_shell_access(),
            allow_workspace_write: false,
            allow_danger_full_access: false,
            timeout_ms: default_shell_timeout_ms(),
            max_output_bytes: default_shell_max_output_bytes(),
            shell: String::new(),
        }
    }
}

impl Default for CodexConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            provider: default_coding_provider(),
            providers: vec![default_coding_provider()],
            command: String::new(),
            model: String::new(),
            reasoning_effort: String::new(),
            antigravity_command: String::new(),
            cursor_command: String::new(),
            cursor_model: String::new(),
            cursor_model_custom: String::new(),
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
    // The file itself is the previous state, so its own harness list counts as known.
    let (_, loaded_providers) = normalized_coding_providers(
        &config.capabilities.codex.provider,
        &config.capabilities.codex.providers,
    );
    if normalize_runtime_config(&mut config, Some(&loaded_providers)) {
        write_config(&app, &config)?;
    }
    Ok(config)
}

#[tauri::command]
fn save_config(app: AppHandle, mut config: RuntimeConfig) -> Result<RuntimeConfig, String> {
    normalize_runtime_config_for_save(&app, &mut config);
    write_config(&app, &config)?;
    Ok(config)
}

/// The enabled harnesses in the config file on disk, if it can be read.
fn persisted_coding_providers(app: &AppHandle) -> Option<Vec<String>> {
    persisted_coding_providers_at(&config_path(app).ok()?)
}

fn persisted_coding_providers_at(path: &Path) -> Option<Vec<String>> {
    let raw = fs::read_to_string(path).ok()?;
    let value = serde_json::from_str::<serde_json::Value>(&raw).ok()?;
    let codex = value.get("capabilities")?.get("codex")?;
    let provider = codex
        .get("provider")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("codex");
    let providers: Vec<String> = codex
        .get("providers")
        .and_then(serde_json::Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(|value| value.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    Some(normalized_coding_providers(provider, &providers).1)
}

/// Normalizes a config that is about to replace the one on disk, comparing
/// its coding harnesses with the persisted ones.
fn normalize_runtime_config_for_save(app: &AppHandle, config: &mut RuntimeConfig) -> bool {
    let previous = persisted_coding_providers(app);
    normalize_runtime_config(config, previous.as_deref())
}

/// The shared access grants implied by the coding settings. Mirrors
/// `derivedCodingAgentGrants` in packages/coding-agents; the test suites read
/// packages/daemon/test/fixtures/coding-grant-cases.json. The default sandbox
/// counts only while a sandbox harness (Codex, Cursor, Antigravity) is
/// enabled and the Claude Code permission mode only while Claude Code is
/// enabled, so a leftover sandbox never grants Claude Code access (a
/// Claude-only config with a write/full sandbox and no stored grant no longer
/// gets that access).
fn derived_coding_grants(codex: &CodexConfig) -> (bool, bool) {
    let (_, providers) = normalized_coding_providers(&codex.provider, &codex.providers);
    let claude_enabled = providers.iter().any(|provider| provider == "claude-code");
    let sandbox_harness_enabled = providers.iter().any(|provider| provider != "claude-code");
    let sandbox = if sandbox_harness_enabled {
        codex.default_sandbox.as_str()
    } else {
        ""
    };
    let mode = if claude_enabled {
        codex.claude_permission_mode.as_str()
    } else {
        ""
    };
    (
        matches!(sandbox, "workspace-write" | "danger-full-access") || mode == "acceptEdits",
        sandbox == "danger-full-access" || mode == "bypassPermissions",
    )
}

#[tauri::command]
fn check_dependencies(config: RuntimeConfig) -> DependencyStatus {
    dependency_status(&config)
}

#[tauri::command]
fn list_cursor_models(config: RuntimeConfig) -> Result<Vec<CodingModelOption>, String> {
    let dependency = check_cursor_dependency(&config.capabilities.codex.cursor_command);
    let command = dependency
        .path
        .as_deref()
        .ok_or_else(|| dependency.message.clone())?;
    let output = Command::new(command)
        .arg("models")
        .output()
        .map_err(|error| format!("Could not list Cursor models: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "Cursor model listing failed.".to_string()
        } else {
            stderr
        });
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(parse_cursor_models(&stdout))
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
    normalize_runtime_config_for_save(&app, &mut config);
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
    normalize_runtime_config_for_save(&app, &mut config);
    if config.device_token.trim().is_empty() || config.websocket_url.trim().is_empty() {
        return Err("Pair the runtime before starting the daemon.".to_string());
    }
    let dependencies = dependency_status(&config);
    validate_enabled_dependencies_with(&config, &dependencies)?;
    let unavailable_coding = unavailable_coding_providers(&config, &dependencies);

    save_config(app.clone(), config)?;
    if current_daemon_status(&state)?.running {
        return current_daemon_status(&state);
    }

    let config_path = config_path(&app)?;
    let mut command = daemon_command(&config_path)?;
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    // Skipped for this run only; the saved config keeps them enabled so a
    // reinstall brings them back.
    command.env(UNAVAILABLE_CODING_PROVIDERS_ENV, unavailable_coding.join(","));
    if !unavailable_coding.is_empty() {
        push_log_tail(
            &state.logs,
            format!(
                "process: coding harnesses not installed, skipped for this run: {}",
                unavailable_coding.join(", ")
            ),
        );
    }
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
    normalize_runtime_config_for_save(&app, &mut config);
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
    // Only reads the browser settings; nothing is saved.
    normalize_runtime_config(&mut config, None);
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
            list_cursor_models,
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
            .arg("--desktop-app")
            .env("PATH", runtime_path_env());
        return Ok(command);
    }

    if let Some(binary_path) = packaged_daemon_bin() {
        let mut command = Command::new(binary_path);
        command
            .arg(subcommand)
            .arg("--config")
            .arg(config_path)
            .arg("--desktop-app")
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
        .arg("--desktop-app")
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
    validate_enabled_dependencies_with(config, &dependency_status(config))
}

fn validate_enabled_dependencies_with(
    config: &RuntimeConfig,
    status: &DependencyStatus,
) -> Result<(), String> {
    if config.capabilities.browser.enabled && !status.browser.available {
        return Err(status.browser.message.clone());
    }
    validate_default_coding_dependency(config, status)
}

/// Of the coding harnesses only the default one is required; missing others
/// are skipped for the run (see `unavailable_coding_providers`).
fn validate_default_coding_dependency(
    config: &RuntimeConfig,
    status: &DependencyStatus,
) -> Result<(), String> {
    if !config.capabilities.codex.enabled {
        return Ok(());
    }
    let (provider, _) = normalized_coding_providers(
        &config.capabilities.codex.provider,
        &config.capabilities.codex.providers,
    );
    let dependency = coding_dependency(status, &provider);
    if dependency.available {
        Ok(())
    } else {
        Err(dependency.message.clone())
    }
}

/// Enabled non-default harnesses whose CLI is not installed.
fn unavailable_coding_providers(config: &RuntimeConfig, status: &DependencyStatus) -> Vec<String> {
    if !config.capabilities.codex.enabled {
        return Vec::new();
    }
    let (provider, providers) = normalized_coding_providers(
        &config.capabilities.codex.provider,
        &config.capabilities.codex.providers,
    );
    providers
        .into_iter()
        .filter(|candidate| {
            *candidate != provider && !coding_dependency(status, candidate).available
        })
        .collect()
}

fn coding_dependency<'a>(status: &'a DependencyStatus, provider: &str) -> &'a DependencyCheck {
    match provider {
        "claude-code" => &status.claude,
        "antigravity" => &status.antigravity,
        "cursor" => &status.cursor,
        _ => &status.codex,
    }
}

const CODING_AGENT_PROVIDERS: [&str; 4] = ["codex", "claude-code", "antigravity", "cursor"];
const UNAVAILABLE_CODING_PROVIDERS_ENV: &str = "CLERO_UNAVAILABLE_CODING_PROVIDERS";

/// Same rules as the local agent: known harnesses only, de-duplicated in
/// order, an empty list means only the default, and the default is always
/// one of the enabled harnesses. A valid default missing from the list is
/// appended (an explicit default wins over a stale list); an invalid default
/// falls back to the first enabled harness.
fn normalized_coding_providers(provider: &str, providers: &[String]) -> (String, Vec<String>) {
    let mut enabled: Vec<String> = Vec::new();
    for value in providers {
        if CODING_AGENT_PROVIDERS.contains(&value.as_str()) && !enabled.contains(value) {
            enabled.push(value.clone());
        }
    }
    if enabled.is_empty() {
        let fallback = if CODING_AGENT_PROVIDERS.contains(&provider) {
            provider.to_string()
        } else {
            default_coding_provider()
        };
        return (fallback.clone(), vec![fallback]);
    }
    if !CODING_AGENT_PROVIDERS.contains(&provider) {
        let default = enabled[0].clone();
        return (default, enabled);
    }
    if !enabled.iter().any(|value| value == provider) {
        enabled.push(provider.to_string());
    }
    (provider.to_string(), enabled)
}

fn dependency_status(config: &RuntimeConfig) -> DependencyStatus {
    DependencyStatus {
        browser: check_browser_dependency(&config.capabilities.browser.browser_channel),
        codex: check_codex_dependency(&config.capabilities.codex.command),
        claude: check_claude_dependency(&config.capabilities.codex.claude_command),
        antigravity: check_antigravity_dependency(&config.capabilities.codex.antigravity_command),
        cursor: check_cursor_dependency(&config.capabilities.codex.cursor_command),
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

fn check_cursor_dependency(configured_command: &str) -> DependencyCheck {
    let mut candidates = Vec::new();
    push_command_candidate(&mut candidates, configured_command);
    push_command_candidate(
        &mut candidates,
        &env::var("CLERO_LOCAL_AGENT_CURSOR_BIN").unwrap_or_default(),
    );
    push_command_candidate(&mut candidates, "agent");
    push_command_candidate(&mut candidates, "cursor-agent");

    if let Some(home) = dirs::home_dir() {
        push_path_candidate(&mut candidates, home.join(".cursor/bin/agent"));
        push_path_candidate(&mut candidates, home.join(".local/bin/agent"));
        push_path_candidate(&mut candidates, home.join(".npm-global/bin/agent"));
    }
    push_path_candidate(&mut candidates, PathBuf::from("/opt/homebrew/bin/agent"));
    push_path_candidate(&mut candidates, PathBuf::from("/usr/local/bin/agent"));

    for candidate in candidates {
        if let Some((path, version)) = command_version(&candidate, "--version") {
            return DependencyCheck {
                available: true,
                label: "Cursor Agent".to_string(),
                path: Some(path),
                version,
                message: "Cursor Agent CLI is installed.".to_string(),
            };
        }
    }

    DependencyCheck {
        available: false,
        label: "Cursor Agent".to_string(),
        path: None,
        version: None,
        message: "Install Cursor Agent CLI before enabling Cursor.".to_string(),
    }
}

fn parse_cursor_models(output: &str) -> Vec<CodingModelOption> {
    let mut models: Vec<CodingModelOption> = Vec::new();
    for raw_line in output.lines() {
        let line = raw_line
            .trim()
            .trim_start_matches(|character: char| {
                matches!(character, '-' | '*' | '•' | '✓' | '✔' | '>')
                    || character.is_whitespace()
            })
            .trim();
        if line.is_empty()
            || line.eq_ignore_ascii_case("models")
            || line.to_ascii_lowercase().starts_with("available ")
        {
            continue;
        }
        let mut parts = line.split_whitespace();
        let Some(first) = parts.next() else {
            continue;
        };
        let id = first.trim_matches(|character: char| character == ',' || character == ':' || character == '|');
        if id.is_empty() || id.eq_ignore_ascii_case("model") || id.eq_ignore_ascii_case("id") {
            continue;
        }
        if !id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | '/' | '[' | ']'))
        {
            continue;
        }
        if models.iter().any(|model| model.id == id) {
            continue;
        }
        models.push(CodingModelOption {
            id: id.to_string(),
            label: line.to_string(),
        });
    }
    models
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

/// `previous_coding_providers` is the enabled harness list the config replaces
/// (the one on disk), or `None` when that is unknown (missing or unreadable
/// file). When the list changed, or is unknown, the shared coding grants are
/// recomputed from the coding settings, so a grant given for a harness that is
/// gone cannot carry over, and with an unknown previous list a grant never
/// upgrades a read-only sandbox.
fn normalize_runtime_config(
    config: &mut RuntimeConfig,
    previous_coding_providers: Option<&[String]>,
) -> bool {
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

    let shell_command = config.capabilities.shell.shell.trim().to_string();
    if shell_command != config.capabilities.shell.shell {
        config.capabilities.shell.shell = shell_command;
        changed = true;
    }
    if !matches!(
        config.capabilities.shell.default_access.as_str(),
        "read-only" | "workspace-write" | "danger-full-access"
    ) {
        config.capabilities.shell.default_access = default_shell_access();
        changed = true;
    }
    if config.capabilities.shell.default_access == "workspace-write" {
        if !config.capabilities.shell.allow_workspace_write {
            config.capabilities.shell.allow_workspace_write = true;
            changed = true;
        }
        if config.capabilities.shell.allow_danger_full_access {
            config.capabilities.shell.allow_danger_full_access = false;
            changed = true;
        }
    }
    if config.capabilities.shell.default_access == "danger-full-access" {
        if !config.capabilities.shell.allow_workspace_write {
            config.capabilities.shell.allow_workspace_write = true;
            changed = true;
        }
        if !config.capabilities.shell.allow_danger_full_access {
            config.capabilities.shell.allow_danger_full_access = true;
            changed = true;
        }
    }
    if config.capabilities.shell.default_access == "read-only" {
        if config.capabilities.shell.allow_workspace_write {
            config.capabilities.shell.allow_workspace_write = false;
            changed = true;
        }
        if config.capabilities.shell.allow_danger_full_access {
            config.capabilities.shell.allow_danger_full_access = false;
            changed = true;
        }
    }
    let shell_timeout = config.capabilities.shell.timeout_ms.clamp(1_000, 120_000);
    if shell_timeout != config.capabilities.shell.timeout_ms {
        config.capabilities.shell.timeout_ms = shell_timeout;
        changed = true;
    }
    let shell_max_output = config
        .capabilities
        .shell
        .max_output_bytes
        .clamp(4_096, 1_000_000);
    if shell_max_output != config.capabilities.shell.max_output_bytes {
        config.capabilities.shell.max_output_bytes = shell_max_output;
        changed = true;
    }

    let (coding_provider, coding_providers) = normalized_coding_providers(
        &config.capabilities.codex.provider,
        &config.capabilities.codex.providers,
    );
    if coding_provider != config.capabilities.codex.provider {
        config.capabilities.codex.provider = coding_provider;
        changed = true;
    }
    if coding_providers != config.capabilities.codex.providers {
        config.capabilities.codex.providers = coding_providers;
        changed = true;
    }
    let harnesses_known_unchanged =
        previous_coding_providers == Some(config.capabilities.codex.providers.as_slice());
    if !harnesses_known_unchanged {
        let (allow_write, allow_full) = derived_coding_grants(&config.capabilities.codex);
        if allow_write != config.capabilities.codex.allow_workspace_write
            || allow_full != config.capabilities.codex.allow_danger_full_access
        {
            config.capabilities.codex.allow_workspace_write = allow_write;
            config.capabilities.codex.allow_danger_full_access = allow_full;
            changed = true;
        }
    }

    // Single-harness Codex/Cursor/Antigravity configs keep the old reconcile
    // between the shared grants and the sandbox. With several harnesses the
    // shared grants widen nobody, so they never change the sandbox either.
    let single_sandbox_harness = config.capabilities.codex.providers.len() == 1
        && config.capabilities.codex.provider != "claude-code";
    if single_sandbox_harness {
        if harnesses_known_unchanged
            && config.capabilities.codex.allow_workspace_write
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
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    [
        home.join("Projects"),
        home.join("projects"),
        home.join("workspace"),
        home.join("workspaces"),
    ]
    .into_iter()
    .filter(|directory| directory.is_dir())
    .map(|directory| directory.to_string_lossy().to_string())
    .collect()
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

fn default_shell_access() -> String {
    "read-only".to_string()
}

fn default_shell_timeout_ms() -> u32 {
    30_000
}

fn default_shell_max_output_bytes() -> u32 {
    200_000
}

#[cfg(test)]
mod tests {
    use super::RuntimeConfig;

    fn coding_config(value: serde_json::Value) -> RuntimeConfig {
        serde_json::from_value(serde_json::json!({ "capabilities": { "codex": value } })).unwrap()
    }

    fn list(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    fn dependency(available: bool, label: &str) -> super::DependencyCheck {
        super::DependencyCheck {
            available,
            label: label.to_string(),
            path: None,
            version: None,
            message: format!("{label} is not installed"),
        }
    }

    #[test]
    fn coding_harness_list_is_normalized_and_backward_compatible() {
        let mut legacy =
            coding_config(serde_json::json!({"enabled": true, "provider": "claude-code"}));
        assert!(legacy.capabilities.codex.providers.is_empty());
        let loaded = list(&["claude-code"]);
        assert!(super::normalize_runtime_config(&mut legacy, Some(&loaded)));
        let saved = serde_json::to_value(&legacy).unwrap();
        assert_eq!(saved["capabilities"]["codex"]["provider"], "claude-code");
        assert_eq!(
            saved["capabilities"]["codex"]["providers"],
            serde_json::json!(["claude-code"])
        );

        let mut multi = coding_config(serde_json::json!({
            "enabled": true,
            "provider": "antigravity",
            "providers": ["cursor", "bogus", "codex", "cursor"]
        }));
        let previous = list(&["cursor", "codex", "antigravity"]);
        super::normalize_runtime_config(&mut multi, Some(&previous));
        // The explicit default wins over a list that does not contain it.
        assert_eq!(multi.capabilities.codex.provider, "antigravity");
        assert_eq!(
            multi.capabilities.codex.providers,
            vec!["cursor", "codex", "antigravity"]
        );
        // A save keeps the harness list instead of dropping the unknown field.
        let saved = serde_json::to_value(&multi).unwrap();
        assert_eq!(
            saved["capabilities"]["codex"]["providers"],
            serde_json::json!(["cursor", "codex", "antigravity"])
        );

        assert_eq!(
            super::normalized_coding_providers("bogus", &[]),
            ("codex".to_string(), list(&["codex"]))
        );
        assert_eq!(
            super::normalized_coding_providers("codex", &list(&["codex", "claude-code"])),
            ("codex".to_string(), list(&["codex", "claude-code"]))
        );
        assert_eq!(
            super::normalized_coding_providers("bogus", &list(&["cursor", "codex"])),
            ("cursor".to_string(), list(&["cursor", "codex"]))
        );
    }

    /// Same table as the TypeScript `derivedCodingAgentGrants` test.
    #[test]
    fn derived_coding_grants_match_the_shared_cases() {
        let cases: Vec<serde_json::Value> = serde_json::from_str(include_str!(
            "../../../../packages/daemon/test/fixtures/coding-grant-cases.json"
        ))
        .unwrap();
        assert!(cases.len() >= 10);
        for case in cases {
            let config = coding_config(case.clone());
            let expected = (
                case["allow_workspace_write"].as_bool().unwrap(),
                case["allow_danger_full_access"].as_bool().unwrap(),
            );
            assert_eq!(
                super::derived_coding_grants(&config.capabilities.codex),
                expected,
                "{}",
                case["name"]
            );
        }
    }

    #[test]
    fn several_harnesses_never_flip_the_sandbox_from_a_shared_grant() {
        let mut config = coding_config(serde_json::json!({
            "enabled": true,
            "provider": "codex",
            "providers": ["codex", "cursor"],
            "default_sandbox": "read-only",
            "allow_workspace_write": true,
            "allow_danger_full_access": true
        }));
        let previous = list(&["codex", "cursor"]);
        super::normalize_runtime_config(&mut config, Some(&previous));
        assert_eq!(config.capabilities.codex.default_sandbox, "read-only");

        let mut both = coding_config(serde_json::json!({
            "enabled": true,
            "provider": "codex",
            "providers": ["codex", "claude-code"],
            "claude_permission_mode": "acceptEdits",
            "default_sandbox": "read-only",
            "allow_workspace_write": true
        }));
        let previous = list(&["codex", "claude-code"]);
        super::normalize_runtime_config(&mut both, Some(&previous));
        assert_eq!(both.capabilities.codex.default_sandbox, "read-only");
    }

    #[test]
    fn a_changed_harness_list_drops_grants_of_the_removed_harness() {
        // Claude bypassPermissions produced the shared grants while both were enabled.
        let mut config = coding_config(serde_json::json!({
            "enabled": true,
            "provider": "codex",
            "providers": ["codex"],
            "claude_permission_mode": "bypassPermissions",
            "default_sandbox": "read-only",
            "allow_workspace_write": true,
            "allow_danger_full_access": true
        }));
        let previous = list(&["codex", "claude-code"]);
        super::normalize_runtime_config(&mut config, Some(&previous));
        assert!(!config.capabilities.codex.allow_workspace_write);
        assert!(!config.capabilities.codex.allow_danger_full_access);
        assert_eq!(config.capabilities.codex.default_sandbox, "read-only");

        let mut claude = coding_config(serde_json::json!({
            "enabled": true,
            "provider": "claude-code",
            "providers": ["claude-code"],
            "claude_permission_mode": "bypassPermissions",
            "default_sandbox": "read-only",
            "allow_workspace_write": true,
            "allow_danger_full_access": false
        }));
        let previous = list(&["claude-code", "codex"]);
        super::normalize_runtime_config(&mut claude, Some(&previous));
        // Same rule as TypeScript: bypassPermissions grants full access, not write.
        assert!(!claude.capabilities.codex.allow_workspace_write);
        assert!(claude.capabilities.codex.allow_danger_full_access);

        // Unchanged single-harness list: an explicit grant keeps working as before.
        let mut single = coding_config(serde_json::json!({
            "enabled": true,
            "provider": "codex",
            "providers": ["codex"],
            "default_sandbox": "read-only",
            "allow_workspace_write": true
        }));
        let previous = list(&["codex"]);
        super::normalize_runtime_config(&mut single, Some(&previous));
        assert!(single.capabilities.codex.allow_workspace_write);
        assert_eq!(single.capabilities.codex.default_sandbox, "workspace-write");
    }

    /// Configs as the desktop access controls write them (apps/desktop/coding-config.ts)
    /// are saved unchanged when the harness list is the one on disk.
    #[test]
    fn saving_what_the_access_controls_wrote_changes_nothing() {
        let written = [
            // Codex + Claude, full access checked while Codex is shown.
            serde_json::json!({
                "enabled": true, "provider": "codex", "providers": ["codex", "claude-code"],
                "default_sandbox": "danger-full-access", "claude_permission_mode": "default",
                "allow_workspace_write": true, "allow_danger_full_access": true
            }),
            // Codex + Claude, full access unchecked while Claude (bypass) is shown, write on.
            serde_json::json!({
                "enabled": true, "provider": "claude-code", "providers": ["codex", "claude-code"],
                "default_sandbox": "read-only", "claude_permission_mode": "acceptEdits",
                "allow_workspace_write": true, "allow_danger_full_access": false
            }),
            // Codex, Cursor and Claude, shared sandbox full, Claude bypass.
            serde_json::json!({
                "enabled": true, "provider": "codex", "providers": ["codex", "cursor", "claude-code"],
                "default_sandbox": "danger-full-access", "claude_permission_mode": "bypassPermissions",
                "allow_workspace_write": true, "allow_danger_full_access": true
            }),
            // Codex alone, full access checked as before (stored grant, sandbox unchanged).
            serde_json::json!({
                "enabled": true, "provider": "codex", "providers": ["codex"],
                "default_sandbox": "workspace-write", "claude_permission_mode": "default",
                "allow_workspace_write": true, "allow_danger_full_access": true
            }),
            // Codex alone, full access unchecked from a full sandbox.
            serde_json::json!({
                "enabled": true, "provider": "codex", "providers": ["codex"],
                "default_sandbox": "workspace-write", "claude_permission_mode": "default",
                "allow_workspace_write": true, "allow_danger_full_access": false
            }),
            // Claude alone, full access unchecked from bypassPermissions.
            serde_json::json!({
                "enabled": true, "provider": "claude-code", "providers": ["claude-code"],
                "default_sandbox": "read-only", "claude_permission_mode": "acceptEdits",
                "allow_workspace_write": true, "allow_danger_full_access": false
            }),
        ];
        for value in written {
            let mut config = coding_config(value.clone());
            let previous = config.capabilities.codex.providers.clone();
            super::normalize_runtime_config(&mut config, Some(&previous));
            let codex = &config.capabilities.codex;
            assert_eq!(codex.default_sandbox, value["default_sandbox"], "{value}");
            assert_eq!(codex.claude_permission_mode, value["claude_permission_mode"], "{value}");
            assert_eq!(codex.allow_workspace_write, value["allow_workspace_write"], "{value}");
            assert_eq!(codex.allow_danger_full_access, value["allow_danger_full_access"], "{value}");
        }

        // After the Agent picker changed the list (disk: Codex only), full access is
        // written as the harness's own setting and survives the recompute.
        let picked = [
            serde_json::json!({
                "enabled": true, "provider": "cursor", "providers": ["cursor"],
                "default_sandbox": "danger-full-access", "claude_permission_mode": "default",
                "allow_workspace_write": true, "allow_danger_full_access": true
            }),
            serde_json::json!({
                "enabled": true, "provider": "claude-code", "providers": ["claude-code"],
                "default_sandbox": "read-only", "claude_permission_mode": "bypassPermissions",
                "allow_workspace_write": false, "allow_danger_full_access": true
            }),
        ];
        for value in picked {
            let mut config = coding_config(value.clone());
            let previous = list(&["codex"]);
            super::normalize_runtime_config(&mut config, Some(&previous));
            let codex = &config.capabilities.codex;
            assert_eq!(codex.default_sandbox, value["default_sandbox"], "{value}");
            assert_eq!(codex.claude_permission_mode, value["claude_permission_mode"], "{value}");
            assert_eq!(codex.allow_workspace_write, value["allow_workspace_write"], "{value}");
            assert_eq!(codex.allow_danger_full_access, value["allow_danger_full_access"], "{value}");
        }

        // Codex alone, full access checked from a read-only sandbox (the previous
        // behaviour stores the grants): the unchanged-list reconcile upgrades the
        // sandbox to workspace-write, as before, and keeps both grants.
        let mut from_read_only = coding_config(serde_json::json!({
            "enabled": true, "provider": "codex", "providers": ["codex"],
            "default_sandbox": "read-only", "claude_permission_mode": "default",
            "allow_workspace_write": true, "allow_danger_full_access": true
        }));
        let previous = list(&["codex"]);
        super::normalize_runtime_config(&mut from_read_only, Some(&previous));
        assert_eq!(from_read_only.capabilities.codex.default_sandbox, "workspace-write");
        assert!(from_read_only.capabilities.codex.allow_workspace_write);
        assert!(from_read_only.capabilities.codex.allow_danger_full_access);
    }

    #[test]
    fn the_default_sandbox_never_grants_claude_code_access() {
        // [codex, claude-code] with a full-access sandbox shrunk to [claude-code].
        let mut shrink = coding_config(serde_json::json!({
            "enabled": true,
            "provider": "claude-code",
            "providers": ["claude-code"],
            "claude_permission_mode": "default",
            "default_sandbox": "danger-full-access",
            "allow_workspace_write": true,
            "allow_danger_full_access": true
        }));
        let previous = list(&["codex", "claude-code"]);
        super::normalize_runtime_config(&mut shrink, Some(&previous));
        assert!(!shrink.capabilities.codex.allow_workspace_write);
        assert!(!shrink.capabilities.codex.allow_danger_full_access);

        // Codex alone with full access swapped to Claude Code alone.
        let mut swap = coding_config(serde_json::json!({
            "enabled": true,
            "provider": "claude-code",
            "providers": ["claude-code"],
            "default_sandbox": "danger-full-access",
            "allow_workspace_write": true,
            "allow_danger_full_access": true
        }));
        let previous = list(&["codex"]);
        super::normalize_runtime_config(&mut swap, Some(&previous));
        assert!(!swap.capabilities.codex.allow_workspace_write);
        assert!(!swap.capabilities.codex.allow_danger_full_access);
        assert_eq!(swap.capabilities.codex.default_sandbox, "danger-full-access");

        // Claude-only with a leftover workspace-write sandbox and an unknown previous list.
        let mut leftover = coding_config(serde_json::json!({
            "enabled": true,
            "provider": "claude-code",
            "providers": ["claude-code"],
            "default_sandbox": "workspace-write"
        }));
        super::normalize_runtime_config(&mut leftover, None);
        assert!(!leftover.capabilities.codex.allow_workspace_write);
    }

    #[test]
    fn saving_with_claude_unticked_does_not_widen_codex_from_the_file_on_disk() {
        let directory = std::env::temp_dir().join(format!(
            "clero-coding-grants-{}-{}",
            std::process::id(),
            super::now_ms().unwrap_or_default()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("config.json");
        std::fs::write(
            &path,
            serde_json::json!({"capabilities": {"codex": {
                "enabled": true,
                "provider": "codex",
                "providers": ["codex", "claude-code"],
                "claude_permission_mode": "acceptEdits",
                "default_sandbox": "read-only",
                "allow_workspace_write": true
            }}})
            .to_string(),
        )
        .unwrap();
        // What the UI hands save_config after the harness list shrinks to Codex.
        let mut config = coding_config(serde_json::json!({
            "enabled": true,
            "provider": "codex",
            "providers": ["codex"],
            "claude_permission_mode": "acceptEdits",
            "default_sandbox": "read-only",
            "allow_workspace_write": true
        }));
        let previous = super::persisted_coding_providers_at(&path);
        assert_eq!(previous, Some(list(&["codex", "claude-code"])));
        super::normalize_runtime_config(&mut config, previous.as_deref());
        assert_eq!(config.capabilities.codex.default_sandbox, "read-only");
        assert!(!config.capabilities.codex.allow_workspace_write);

        // Missing (or unreadable) file: provenance is unknown, so grants are
        // recomputed from the settings and never upgrade the sandbox.
        std::fs::remove_dir_all(&directory).unwrap();
        let missing = super::persisted_coding_providers_at(&path);
        assert_eq!(missing, None);
        let mut unknown = coding_config(serde_json::json!({
            "enabled": true,
            "provider": "codex",
            "providers": ["codex"],
            "default_sandbox": "read-only",
            "allow_workspace_write": true
        }));
        super::normalize_runtime_config(&mut unknown, missing.as_deref());
        assert_eq!(unknown.capabilities.codex.default_sandbox, "read-only");
        assert!(!unknown.capabilities.codex.allow_workspace_write);

        let mut unknown_writable = coding_config(serde_json::json!({
            "enabled": true,
            "provider": "codex",
            "providers": ["codex"],
            "default_sandbox": "workspace-write"
        }));
        super::normalize_runtime_config(&mut unknown_writable, None);
        assert!(unknown_writable.capabilities.codex.allow_workspace_write);
    }

    #[test]
    fn only_the_default_coding_harness_must_be_installed() {
        let config = coding_config(serde_json::json!({
            "enabled": true,
            "provider": "claude-code",
            "providers": ["codex", "claude-code", "cursor", "antigravity"]
        }));
        let status = super::DependencyStatus {
            browser: dependency(true, "Chrome"),
            codex: dependency(false, "Codex"),
            claude: dependency(true, "Claude Code"),
            antigravity: dependency(true, "Antigravity"),
            cursor: dependency(false, "Cursor"),
        };
        assert!(super::validate_default_coding_dependency(&config, &status).is_ok());
        assert_eq!(
            super::unavailable_coding_providers(&config, &status),
            list(&["codex", "cursor"])
        );
        // The saved config is untouched, so a reinstall brings them back.
        assert_eq!(config.capabilities.codex.providers.len(), 4);

        let missing_default = coding_config(serde_json::json!({
            "enabled": true,
            "provider": "cursor",
            "providers": ["cursor", "claude-code"]
        }));
        assert_eq!(
            super::validate_default_coding_dependency(&missing_default, &status),
            Err("Cursor is not installed".to_string())
        );

        let disabled = coding_config(serde_json::json!({
            "enabled": false,
            "provider": "cursor",
            "providers": ["cursor"]
        }));
        assert!(super::validate_default_coding_dependency(&disabled, &status).is_ok());
        assert!(super::unavailable_coding_providers(&disabled, &status).is_empty());
    }
}
