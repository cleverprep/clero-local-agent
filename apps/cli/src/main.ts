#!/usr/bin/env -S node --experimental-strip-types
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  capabilitiesFromConfig,
  capabilityOptionsFromConfig,
  createDaemon,
  createPairingClient,
  createTokenStore,
  defaultRuntimeConfig,
  defaultRuntimeConfigPath,
  loadRuntimeConfig,
  resolveDeviceToken,
  saveRuntimeConfig,
  type LocalRuntimeConfig
} from "@clero-local-agent/daemon";
import type { ClaudeCodePermissionMode, CodingAgentProvider, CodexSandbox } from "@clero-local-agent/coding-agents";

const DEVICE_TOKEN_ACCOUNT = "device_token";

type CliValue = string | string[] | boolean;
type CliArgs = Record<string, CliValue>;

type ParsedArgs = {
  command: string;
  subcommand?: string;
  args: CliArgs;
};

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const args: CliArgs = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    const value: string | boolean = !next || next.startsWith("--") ? true : next;
    appendArg(args, key, value);
    if (typeof value === "string") {
      index += 1;
    }
  }

  return { command: positionals[0] ?? "help", subcommand: positionals[1], args };
}

function appendArg(args: CliArgs, key: string, value: string | boolean): void {
  const existing = args[key];
  if (existing === undefined) {
    args[key] = value;
    return;
  }
  if (Array.isArray(existing)) {
    args[key] = [...existing, String(value)];
    return;
  }
  args[key] = [String(existing), String(value)];
}

function getString(args: CliArgs, key: string): string | undefined {
  const value = args[key];
  if (Array.isArray(value)) {
    return value.at(-1);
  }
  return typeof value === "string" ? value : undefined;
}

function getStrings(args: CliArgs, key: string): string[] {
  const value = args[key];
  if (Array.isArray(value)) {
    return value;
  }
  return typeof value === "string" ? [value] : [];
}

function getBoolean(args: CliArgs, key: string): boolean {
  return args[key] === true;
}

function nonEmptyString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function printHelp(): void {
  console.log(`clero-connector

Usage:
  clero-connector setup --code <connection-code> [--backend-url https://clero.so] [--allowed-dir <path>] [--coding-provider codex|claude-code|antigravity]
  clero-connector daemon [--config <path>]
  clero-connector pair --code <connection-code> [--backend-url <url>] [--save]
  clero-connector capabilities [--config <path>]
  clero-connector status [--config <path>]
  clero-connector config init|show [--config <path>]
  clero-connector workspaces list|add|remove [--path <path>] [--config <path>]
  clero-connector coding status|enable|disable [--provider codex|claude-code|antigravity] [--sandbox read-only|workspace-write|danger-full-access]

Compatibility:
  clero-local-agent is still supported as an alias for clero-connector.
`);
}

async function main(): Promise<void> {
  const { command, subcommand, args } = parseArgs(process.argv.slice(2));

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  const configPath = getString(args, "config") ?? defaultRuntimeConfigPath();

  if (command === "config") {
    await handleConfigCommand(subcommand, configPath);
    return;
  }

  const runtimeConfig = await loadRuntimeConfigIfExists(configPath);

  if (command === "setup") {
    await handleSetup(args, configPath, runtimeConfig);
    return;
  }

  if (command === "workspaces") {
    await handleWorkspacesCommand(subcommand, args, configPath, runtimeConfig);
    return;
  }

  if (command === "coding") {
    await handleCodingCommand(subcommand, args, configPath, runtimeConfig);
    return;
  }

  if (command === "capabilities") {
    console.log(JSON.stringify(capabilitiesFromConfig(runtimeConfig), null, 2));
    return;
  }

  if (command === "status") {
    console.log(JSON.stringify(localStatus(configPath, runtimeConfig), null, 2));
    return;
  }

  if (command === "pair") {
    await handlePair(args, configPath, runtimeConfig);
    return;
  }

  if (command === "daemon") {
    await runDaemon(args, runtimeConfig);
    return;
  }

  printHelp();
  process.exitCode = 1;
}

async function handleConfigCommand(subcommand: string | undefined, configPath: string): Promise<void> {
  if (subcommand === "init") {
    await saveRuntimeConfig(configPath, defaultRuntimeConfig());
    console.log(JSON.stringify({ config_path: configPath }, null, 2));
    return;
  }

  if (subcommand === "show") {
    console.log(JSON.stringify(await loadRuntimeConfigIfExists(configPath), null, 2));
    return;
  }

  if (subcommand === undefined || subcommand === "help") {
    console.log("config supports: init, show");
    return;
  }

  throw new Error("config supports: init, show");
}

async function handleSetup(
  args: CliArgs,
  configPath: string,
  runtimeConfig: LocalRuntimeConfig
): Promise<void> {
  const config = applyCommonConfigFlags(runtimeConfig, args);
  const backendUrl = getString(args, "backend-url") ?? config.backend_url ?? defaultRuntimeConfig().backend_url;
  const code = getString(args, "code");

  if (!backendUrl) {
    throw new Error("setup requires --backend-url or a configured backend_url");
  }

  config.backend_url = backendUrl;

  let pairing: { connection_id: number; websocket_url: string } | undefined;
  if (code) {
    const result = await pairWithBackend(backendUrl, code, config);
    await createTokenStore().set(DEVICE_TOKEN_ACCOUNT, result.device_token);
    delete config.device_token;
    config.websocket_url = result.websocket_url;
    pairing = {
      connection_id: result.connection_id,
      websocket_url: result.websocket_url
    };
  }

  await saveRuntimeConfig(configPath, config);
  console.log(
    JSON.stringify(
      {
        status: "configured",
        config_path: configPath,
        paired: Boolean(pairing),
        pairing,
        next: "Run: clero-connector daemon"
      },
      null,
      2
    )
  );
}

async function handlePair(
  args: CliArgs,
  configPath: string,
  runtimeConfig: LocalRuntimeConfig
): Promise<void> {
  const backendUrl = getString(args, "backend-url") ?? runtimeConfig.backend_url;
  const code = getString(args, "code");
  if (!backendUrl || !code) {
    throw new Error("pair requires --backend-url and --code, or a configured backend_url and --code");
  }

  const config = applyCommonConfigFlags(runtimeConfig, args);
  config.backend_url = backendUrl;
  const result = await pairWithBackend(backendUrl, code, config);

  if (getBoolean(args, "save")) {
    await createTokenStore().set(DEVICE_TOKEN_ACCOUNT, result.device_token);
    delete config.device_token;
    config.websocket_url = result.websocket_url;
    await saveRuntimeConfig(configPath, config);
    console.log(
      JSON.stringify(
        {
          connection_id: result.connection_id,
          websocket_url: result.websocket_url,
          config_path: configPath,
          token_saved: true
        },
        null,
        2
      )
    );
    return;
  }

  console.log(JSON.stringify(result, null, 2));
}

async function handleWorkspacesCommand(
  subcommand: string | undefined,
  args: CliArgs,
  configPath: string,
  runtimeConfig: LocalRuntimeConfig
): Promise<void> {
  if (subcommand === "list" || subcommand === undefined) {
    console.log(JSON.stringify({ allowed_directories: runtimeConfig.allowed_directories ?? [] }, null, 2));
    return;
  }

  const workspacePath = getString(args, "path") ?? getString(args, "allowed-dir");
  if (!workspacePath) {
    throw new Error(`workspaces ${subcommand} requires --path <path>`);
  }

  const expandedPath = expandPath(workspacePath);
  const current = runtimeConfig.allowed_directories ?? [];
  if (subcommand === "add") {
    runtimeConfig.allowed_directories = Array.from(new Set([...current, expandedPath]));
  } else if (subcommand === "remove") {
    runtimeConfig.allowed_directories = current.filter((item) => item !== expandedPath);
  } else {
    throw new Error("workspaces supports: list, add, remove");
  }

  await saveRuntimeConfig(configPath, runtimeConfig);
  console.log(JSON.stringify({ config_path: configPath, allowed_directories: runtimeConfig.allowed_directories }, null, 2));
}

async function handleCodingCommand(
  subcommand: string | undefined,
  args: CliArgs,
  configPath: string,
  runtimeConfig: LocalRuntimeConfig
): Promise<void> {
  const coding = runtimeConfig.capabilities?.codex ?? {};

  if (subcommand === "status" || subcommand === undefined) {
    console.log(JSON.stringify(coding, null, 2));
    return;
  }

  runtimeConfig.capabilities ??= {};
  runtimeConfig.capabilities.codex ??= {};

  if (subcommand === "disable") {
    runtimeConfig.capabilities.codex.enabled = false;
    await saveRuntimeConfig(configPath, runtimeConfig);
    console.log(JSON.stringify({ config_path: configPath, coding: runtimeConfig.capabilities.codex }, null, 2));
    return;
  }

  if (subcommand !== "enable") {
    throw new Error("coding supports: status, enable, disable");
  }

  applyCodingFlags(runtimeConfig, args, true);
  await saveRuntimeConfig(configPath, runtimeConfig);
  console.log(JSON.stringify({ config_path: configPath, coding: runtimeConfig.capabilities.codex }, null, 2));
}

async function runDaemon(args: CliArgs, runtimeConfig: LocalRuntimeConfig): Promise<void> {
  const wsUrl = getString(args, "ws-url") ?? process.env.CLERO_LOCAL_RUNTIME_WS_URL ?? runtimeConfig.websocket_url;
  const token =
    nonEmptyString(getString(args, "token")) ??
    nonEmptyString(process.env.CLERO_LOCAL_RUNTIME_TOKEN) ??
    (await resolveDeviceToken(runtimeConfig));
  if (!wsUrl || !token) {
    throw new Error(
      "daemon requires --ws-url and a token from --token, CLERO_LOCAL_RUNTIME_TOKEN, config JSON, token store, or setup/pair --save"
    );
  }

  const daemon = createDaemon({
    wsUrl,
    token,
    allowedDirectories: allowedDirectories(args, runtimeConfig),
    browserProvider: browserProviderArg(
      getString(args, "browser-provider") ?? process.env.CLERO_BROWSER_PROVIDER ?? runtimeConfig.capabilities?.browser?.provider
    ),
    browserMcpUrl: getString(args, "browser-mcp-url") ?? process.env.CLERO_BROWSER_MCP_URL ?? runtimeConfig.capabilities?.browser?.mcp_url,
    browserProfileDir:
      nonEmptyString(getString(args, "browser-profile-dir")) ??
      nonEmptyString(process.env.CLERO_BROWSER_PROFILE_DIR) ??
      nonEmptyString(runtimeConfig.capabilities?.browser?.browser_profile_dir),
    browserRememberSession:
      getBoolean(args, "no-browser-remember-session")
        ? false
        : getBoolean(args, "browser-remember-session") || process.env.CLERO_BROWSER_REMEMBER_SESSION === "true"
          ? true
          : process.env.CLERO_BROWSER_REMEMBER_SESSION === "false"
            ? false
            : runtimeConfig.capabilities?.browser?.remember_session !== false,
    browserHeadless:
      getBoolean(args, "browser-headless") ||
      process.env.CLERO_BROWSER_HEADLESS === "true" ||
      runtimeConfig.capabilities?.browser?.browser_headless,
    browserChannel: browserChannelArg(
      getString(args, "browser-channel") ??
        process.env.CLERO_BROWSER_CHANNEL ??
        runtimeConfig.capabilities?.browser?.browser_channel
    ),
    capabilities: capabilityOptionsFromConfig(runtimeConfig)
  });

  await daemon.start();
  process.once("SIGINT", async () => {
    await daemon.stop();
    process.exit(0);
  });
  process.once("SIGTERM", async () => {
    await daemon.stop();
    process.exit(0);
  });
}

async function pairWithBackend(
  backendUrl: string,
  code: string,
  config: LocalRuntimeConfig
): Promise<{ connection_id: number; device_token: string; websocket_url: string }> {
  const client = createPairingClient({ backendUrl });
  return client.pair({
    code,
    deviceName: config.device_name,
    capabilities: {
      tools: capabilitiesFromConfig(config).map((capability) => {
        const tool = {
          name: capability.name,
          access: capability.access,
          description: capability.description
        };
        const withGroups = capability.groups?.length ? { ...tool, groups: capability.groups } : tool;
        return capability.inputSchema ? { ...withGroups, inputSchema: capability.inputSchema } : withGroups;
      })
    }
  });
}

function applyCommonConfigFlags(config: LocalRuntimeConfig, args: CliArgs): LocalRuntimeConfig {
  const next = structuredClone(config) as LocalRuntimeConfig;
  next.capabilities ??= {};

  const backendUrl = getString(args, "backend-url");
  if (backendUrl) {
    next.backend_url = backendUrl;
  }
  const deviceName = getString(args, "device-name");
  if (deviceName) {
    next.device_name = deviceName;
  }
  const allowedDirs = getStrings(args, "allowed-dir").map(expandPath);
  if (allowedDirs.length > 0) {
    next.allowed_directories = allowedDirs;
  }

  applyBrowserFlags(next, args);
  applyCodingFlags(
    next,
    args,
    Boolean(getString(args, "coding-provider") || getString(args, "provider") || getBoolean(args, "enable-coding"))
  );
  applyGitFlags(next, args);
  return next;
}

function applyBrowserFlags(config: LocalRuntimeConfig, args: CliArgs): void {
  config.capabilities ??= {};
  config.capabilities.browser ??= {};
  if (getBoolean(args, "enable-browser")) {
    config.capabilities.browser.enabled = true;
  }
  if (getBoolean(args, "disable-browser")) {
    config.capabilities.browser.enabled = false;
  }
  const provider = getString(args, "browser-provider");
  if (provider) {
    config.capabilities.browser.provider = browserProviderArg(provider);
  }
  const profileDir = getString(args, "browser-profile-dir");
  if (profileDir) {
    config.capabilities.browser.browser_profile_dir = expandPath(profileDir);
  }
  const channel = getString(args, "browser-channel");
  if (channel) {
    config.capabilities.browser.browser_channel = browserChannelArg(channel);
  }
  if (getBoolean(args, "browser-headless")) {
    config.capabilities.browser.browser_headless = true;
  }
  if (getBoolean(args, "no-browser-headless")) {
    config.capabilities.browser.browser_headless = false;
  }
  if (getBoolean(args, "browser-remember-session")) {
    config.capabilities.browser.remember_session = true;
  }
  if (getBoolean(args, "no-browser-remember-session")) {
    config.capabilities.browser.remember_session = false;
  }
}

function applyCodingFlags(config: LocalRuntimeConfig, args: CliArgs, enableIfConfigured: boolean): void {
  config.capabilities ??= {};
  config.capabilities.codex ??= {};
  const coding = config.capabilities.codex;

  if (enableIfConfigured) {
    coding.enabled = true;
  }
  if (getBoolean(args, "disable-coding")) {
    coding.enabled = false;
  }
  const provider = getString(args, "coding-provider") ?? getString(args, "provider");
  if (provider) {
    coding.provider = codingProviderArg(provider);
  }
  const sandbox = getString(args, "sandbox");
  if (sandbox) {
    coding.default_sandbox = sandboxArg(sandbox);
  }
  const command = getString(args, "coding-command") ?? getString(args, "command");
  if (command) {
    if (coding.provider === "claude-code") {
      coding.claude_command = command;
    } else if (coding.provider === "antigravity") {
      coding.antigravity_command = command;
    } else {
      coding.command = command;
    }
  }
  const model = getString(args, "model");
  if (model) {
    if (coding.provider === "claude-code") {
      coding.claude_model = model;
    } else {
      coding.model = model;
    }
  }
  if (getBoolean(args, "allow-workspace-write")) {
    coding.allow_workspace_write = true;
  }
  if (getBoolean(args, "deny-workspace-write")) {
    coding.allow_workspace_write = false;
  }
  if (getBoolean(args, "allow-danger-full-access")) {
    coding.allow_danger_full_access = true;
  }
  if (getBoolean(args, "deny-danger-full-access")) {
    coding.allow_danger_full_access = false;
  }
  const permissionMode = getString(args, "claude-permission-mode");
  if (permissionMode) {
    coding.claude_permission_mode = claudePermissionModeArg(permissionMode);
  }
}

function applyGitFlags(config: LocalRuntimeConfig, args: CliArgs): void {
  config.capabilities ??= {};
  config.capabilities.git ??= {};
  if (getBoolean(args, "enable-git-read")) {
    config.capabilities.git.read_enabled = true;
  }
  if (getBoolean(args, "disable-git-read")) {
    config.capabilities.git.read_enabled = false;
  }
  if (getBoolean(args, "enable-git-write")) {
    config.capabilities.git.write_enabled = true;
  }
  if (getBoolean(args, "disable-git-write")) {
    config.capabilities.git.write_enabled = false;
  }
}

function localStatus(configPath: string, runtimeConfig: LocalRuntimeConfig): Record<string, unknown> {
  return {
    status: "offline",
    message: "Status is available while the daemon is running.",
    config_path: configPath,
    backend_url: runtimeConfig.backend_url,
    websocket_configured: Boolean(runtimeConfig.websocket_url),
    allowed_directories: runtimeConfig.allowed_directories ?? [],
    capabilities: {
      browser: runtimeConfig.capabilities?.browser?.enabled !== false,
      workspace: runtimeConfig.capabilities?.workspace?.enabled !== false,
      coding: runtimeConfig.capabilities?.codex?.enabled !== false,
      coding_provider: runtimeConfig.capabilities?.codex?.provider,
      git_read: runtimeConfig.capabilities?.git?.read_enabled !== false,
      git_write: runtimeConfig.capabilities?.git?.write_enabled === true
    }
  };
}

async function loadRuntimeConfigIfExists(configPath: string): Promise<LocalRuntimeConfig> {
  try {
    await access(configPath);
    return loadRuntimeConfig(configPath);
  } catch {
    return defaultRuntimeConfig();
  }
}

function allowedDirectories(args: CliArgs, runtimeConfig: LocalRuntimeConfig): string[] {
  const allowedDirs = getStrings(args, "allowed-dir").map(expandPath);
  if (allowedDirs.length > 0) {
    return allowedDirs;
  }
  if (runtimeConfig.allowed_directories && runtimeConfig.allowed_directories.length > 0) {
    return runtimeConfig.allowed_directories;
  }
  return [process.cwd()];
}

function expandPath(value: string): string {
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return path.resolve(value);
}

function browserProviderArg(value: string | undefined): "managed" | "mcp-chrome" | undefined {
  if (!value) {
    return undefined;
  }

  if (value === "managed" || value === "mcp-chrome") {
    return value;
  }

  throw new Error("--browser-provider must be managed or mcp-chrome");
}

function browserChannelArg(value: string | undefined): "chromium" | "chrome" | "chrome-beta" | "msedge" | undefined {
  if (!value) {
    return undefined;
  }

  if (value === "chromium" || value === "chrome" || value === "chrome-beta" || value === "msedge") {
    return value;
  }

  throw new Error("--browser-channel must be chromium, chrome, chrome-beta, or msedge");
}

function codingProviderArg(value: string): CodingAgentProvider {
  if (value === "codex" || value === "claude-code" || value === "antigravity") {
    return value;
  }

  throw new Error("--coding-provider must be codex, claude-code, or antigravity");
}

function sandboxArg(value: string): CodexSandbox {
  if (value === "read-only" || value === "workspace-write" || value === "danger-full-access") {
    return value;
  }

  throw new Error("--sandbox must be read-only, workspace-write, or danger-full-access");
}

function claudePermissionModeArg(value: string): ClaudeCodePermissionMode {
  if (
    value === "default" ||
    value === "acceptEdits" ||
    value === "plan" ||
    value === "auto" ||
    value === "dontAsk" ||
    value === "bypassPermissions"
  ) {
    return value;
  }

  throw new Error("--claude-permission-mode must be default, acceptEdits, plan, auto, dontAsk, or bypassPermissions");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
