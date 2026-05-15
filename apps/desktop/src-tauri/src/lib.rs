use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    env,
    fs,
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
};
use tauri::{AppHandle, Manager, State};

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
    #[serde(default)]
    browser_headless: bool,
    #[serde(default)]
    mcp_url: Option<String>,
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
    last_exit_code: Option<i32>,
    log_tail: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
struct DependencyStatus {
    browser: DependencyCheck,
    codex: DependencyCheck,
    claude: DependencyCheck,
}

#[derive(Debug, Clone, Serialize)]
struct DependencyCheck {
    available: bool,
    label: String,
    path: Option<String>,
    version: Option<String>,
    message: String,
}

#[derive(Default)]
struct DaemonSupervisor {
    child: Mutex<Option<Child>>,
    logs: Arc<Mutex<Vec<String>>>,
    last_exit_code: Mutex<Option<i32>>,
}

impl Default for CapabilityConfig {
    fn default() -> Self {
        Self {
            browser: BrowserConfig::default(),
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
            browser_profile_dir: String::new(),
            browser_headless: false,
            mcp_url: None,
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
    serde_json::from_str(&raw).map_err(|error| error.to_string())
}

#[tauri::command]
fn save_config(app: AppHandle, config: RuntimeConfig) -> Result<RuntimeConfig, String> {
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
async fn pair_runtime(app: AppHandle, code: String, config: RuntimeConfig) -> Result<RuntimeConfig, String> {
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
        "daemon_version": "0.1.3",
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
            if body.is_empty() { String::new() } else { format!(": {body}") }
        ));
    }

    let claim = response
        .json::<PairingClaimResponse>()
        .await
        .map_err(|error| error.to_string())?;
    let mut next_config = config;
    next_config.device_token = claim.device_token;
    next_config.websocket_url = claim.websocket_url;
    save_config(app, next_config)
}

#[tauri::command]
fn start_daemon(
    app: AppHandle,
    state: State<'_, DaemonSupervisor>,
    config: RuntimeConfig,
) -> Result<DaemonProcessStatus, String> {
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
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let pid = child.id();

    if let Some(stdout) = child.stdout.take() {
        collect_daemon_output("stdout", stdout, state.logs.clone());
    }
    if let Some(stderr) = child.stderr.take() {
        collect_daemon_output("stderr", stderr, state.logs.clone());
    }

    push_log_tail(&state.logs, format!("process: daemon started pid={pid}"));
    *state.last_exit_code.lock().map_err(|error| error.to_string())? = None;
    *state.child.lock().map_err(|error| error.to_string())? = Some(child);

    current_daemon_status(&state)
}

#[tauri::command]
fn stop_daemon(state: State<'_, DaemonSupervisor>) -> Result<DaemonProcessStatus, String> {
    let mut child_guard = state.child.lock().map_err(|error| error.to_string())?;
    if let Some(mut child) = child_guard.take() {
        let _ = child.kill();
        let status = child.wait().map_err(|error| error.to_string())?;
        *state.last_exit_code.lock().map_err(|error| error.to_string())? = status.code();
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

fn current_daemon_status(state: &State<'_, DaemonSupervisor>) -> Result<DaemonProcessStatus, String> {
    let mut child_guard = state.child.lock().map_err(|error| error.to_string())?;
    let mut running = false;
    let mut pid = None;

    if let Some(child) = child_guard.as_mut() {
        match child.try_wait().map_err(|error| error.to_string())? {
            Some(status) => {
                *state.last_exit_code.lock().map_err(|error| error.to_string())? = status.code();
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

    let last_exit_code = *state.last_exit_code.lock().map_err(|error| error.to_string())?;
    let log_tail = state.logs.lock().map_err(|error| error.to_string())?.clone();
    Ok(DaemonProcessStatus {
        running,
        pid,
        last_exit_code,
        log_tail,
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

fn collect_daemon_output<R>(source: &'static str, stream: R, logs: Arc<Mutex<Vec<String>>>)
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let reader = BufReader::new(stream);
        for line in reader.lines().map_while(Result::ok) {
            push_log_tail(&logs, format!("{source}: {line}"));
        }
    });
}

fn push_log_tail(logs: &Arc<Mutex<Vec<String>>>, line: String) {
    if let Ok(mut log_tail) = logs.lock() {
        log_tail.push(line);
        while log_tail.len() > 200 {
            log_tail.remove(0);
        }
    }
}

fn validate_enabled_dependencies(config: &RuntimeConfig) -> Result<(), String> {
    let status = dependency_status(config);
    if config.capabilities.browser.enabled && !status.browser.available {
        return Err(status.browser.message);
    }
    if config.capabilities.codex.enabled && config.capabilities.codex.provider == "claude-code" && !status.claude.available {
        return Err(status.claude.message);
    }
    if config.capabilities.codex.enabled && config.capabilities.codex.provider != "claude-code" && !status.codex.available {
        return Err(status.codex.message);
    }
    Ok(())
}

fn dependency_status(config: &RuntimeConfig) -> DependencyStatus {
    DependencyStatus {
        browser: check_browser_dependency(&config.capabilities.browser.browser_channel),
        codex: check_codex_dependency(&config.capabilities.codex.command),
        claude: check_claude_dependency(&config.capabilities.codex.claude_command),
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
    option_env!("CLERO_BACKEND_URL")
        .unwrap_or("https://api.clero.so")
        .to_string()
}

fn default_device_name() -> String {
    hostname::get()
        .ok()
        .and_then(|name| name.into_string().ok())
        .unwrap_or_else(|| "Local machine".to_string())
}

fn default_allowed_directories() -> Vec<String> {
    dirs::home_dir()
        .map(|home| vec![home.join("Projects").to_string_lossy().to_string()])
        .unwrap_or_default()
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
