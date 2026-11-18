import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BrowserViewport } from "@clero-local-agent/browser";
import {
  derivedCodingAgentGrants,
  normalizeCodingAgentProviders,
  type ClaudeCodePermissionMode,
  type AntigravityReasoningEffort,
  type ClaudeCodeReasoningEffort,
  type CodingAgentProvider,
  type CodexReasoningEffort,
  type CodexSandbox
} from "@clero-local-agent/coding-agents";
import type { ShellAccess } from "@clero-local-agent/shell-tools";
import {
  defaultCapabilities,
  type AgentsSyncMessage,
  type BrokerId,
  type Capability,
  type JsonObject,
  type SyncedAgent
} from "@clero-local-agent/protocol";
import type { LocalRuntimeCapabilityOptions } from "./daemon.ts";
import { createTokenStore, type TokenStore } from "./token-store.ts";

const DEVICE_TOKEN_ACCOUNT = "device_token";

export type LocalRuntimeConfig = {
  backend_url?: string;
  websocket_url?: string;
  device_token?: string;
  device_name?: string;
  allowed_directories?: string[];
  capabilities?: {
    browser?: {
      enabled?: boolean;
      provider?: "managed" | "mcp-chrome";
      browser_channel?: "chromium" | "chrome" | "chrome-beta" | "msedge";
      browser_profile_dir?: string;
      remember_session?: boolean;
      browser_headless?: boolean;
      browser_viewport?: BrowserViewport;
      mcp_url?: string;
    };
    browser_debug?: {
      enabled?: boolean;
      command?: string;
      args?: string[];
      browser_url?: string;
    };
    workspace?: {
      enabled?: boolean;
    };
    shell?: {
      enabled?: boolean;
      default_access?: ShellAccess;
      allow_workspace_write?: boolean;
      allow_danger_full_access?: boolean;
      timeout_ms?: number;
      max_output_bytes?: number;
      shell?: string;
    };
    codex?: {
      enabled?: boolean;
      /** Default harness. */
      provider?: CodingAgentProvider;
      /** Enabled harnesses; normalized so it always contains provider. */
      providers?: CodingAgentProvider[];
      command?: string;
      model?: string;
      reasoning_effort?: CodexReasoningEffort;
      antigravity_command?: string;
      antigravity_model?: string;
      antigravity_reasoning_effort?: AntigravityReasoningEffort;
      cursor_command?: string;
      cursor_model?: string;
      cursor_model_custom?: string;
      claude_command?: string;
      claude_model?: string;
      claude_model_custom?: string;
      claude_reasoning_effort?: ClaudeCodeReasoningEffort;
      claude_permission_mode?: ClaudeCodePermissionMode;
      default_sandbox?: CodexSandbox;
      allow_workspace_write?: boolean;
      allow_danger_full_access?: boolean;
    };
    git?: {
      read_enabled?: boolean;
      write_enabled?: boolean;
    };
  };
};

export type AgentsSyncSnapshot = {
  synced_at: string;
  connection_id?: BrokerId;
  agents: SyncedAgent[];
};

export function defaultRuntimeConfig(): LocalRuntimeConfig {
  return {
    backend_url: process.env.CLERO_BACKEND_URL ?? "https://clero.so",
    device_name: os.hostname(),
    allowed_directories: defaultAllowedDirectories(),
    capabilities: {
      browser: {
        enabled: true,
        provider: "managed",
        browser_channel: "chrome",
        browser_profile_dir: path.join(os.homedir(), ".clero-local-agent", "browser-profile"),
        remember_session: true,
        browser_headless: false,
        browser_viewport: undefined
      },
      browser_debug: {
        enabled: false,
        command: "",
        args: undefined,
        browser_url: ""
      },
      workspace: {
        enabled: true
      },
      shell: {
        enabled: false,
        default_access: "read-only",
        allow_workspace_write: false,
        allow_danger_full_access: false,
        timeout_ms: 30_000,
        max_output_bytes: 200_000,
        shell: ""
      },
      codex: {
        enabled: false,
        provider: "codex",
        providers: ["codex"],
        command: "",
        model: "",
        reasoning_effort: undefined,
        antigravity_command: "",
        antigravity_model: "",
        antigravity_reasoning_effort: undefined,
        cursor_command: "",
        cursor_model: "",
        cursor_model_custom: "",
        claude_command: "",
        claude_model: "",
        claude_model_custom: "",
        claude_reasoning_effort: undefined,
        claude_permission_mode: "default",
        default_sandbox: "read-only",
        allow_workspace_write: false,
        allow_danger_full_access: false
      },
      git: {
        read_enabled: true,
        write_enabled: false
      }
    }
  };
}

function defaultAllowedDirectories(): string[] {
  const homeDirectory = os.homedir();
  return [...new Set(
    [
      path.join(homeDirectory, "Projects"),
      path.join(homeDirectory, "projects"),
      path.join(homeDirectory, "workspace"),
      path.join(homeDirectory, "workspaces")
    ].filter((directory) => existsSync(directory))
  )];
}

export async function loadRuntimeConfig(configPath: string): Promise<LocalRuntimeConfig> {
  const raw = await readFile(configPath, "utf8");
  return mergeRuntimeConfig(defaultRuntimeConfig(), JSON.parse(raw) as LocalRuntimeConfig);
}

export async function resolveDeviceToken(
  config: LocalRuntimeConfig | undefined,
  tokenStore: TokenStore = createTokenStore()
): Promise<string | undefined> {
  const rawConfigToken = config?.device_token;
  const configToken = nonEmptyString(rawConfigToken);
  if (configToken) {
    await tokenStore.set(DEVICE_TOKEN_ACCOUNT, configToken);
    return configToken;
  }

  if (rawConfigToken !== undefined) {
    await tokenStore.delete(DEVICE_TOKEN_ACCOUNT);
    return undefined;
  }

  return nonEmptyString(await tokenStore.get(DEVICE_TOKEN_ACCOUNT));
}

export async function saveRuntimeConfig(configPath: string, config: LocalRuntimeConfig): Promise<void> {
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(mergeRuntimeConfig(defaultRuntimeConfig(), config), null, 2)}\n`);
}

export function codingAgentConfigFromRuntimeConfig(config: LocalRuntimeConfig): JsonObject {
  const coding = config.capabilities?.codex ?? {};
  const { provider, providers } = normalizeCodingAgentProviders(coding.provider, coding.providers);
  return {
    enabled: coding.enabled !== false,
    provider,
    providers,
    command: coding.command ?? "",
    model: coding.model ?? "",
    reasoning_effort: coding.reasoning_effort ?? "",
    antigravity_command: coding.antigravity_command ?? "",
    antigravity_model: coding.antigravity_model ?? "",
    antigravity_reasoning_effort: coding.antigravity_reasoning_effort ?? "",
    cursor_command: coding.cursor_command ?? "",
    cursor_model: coding.cursor_model ?? "",
    cursor_model_custom: coding.cursor_model_custom ?? "",
    claude_command: coding.claude_command ?? "",
    claude_model: coding.claude_model ?? "",
    claude_model_custom: coding.claude_model_custom ?? "",
    claude_reasoning_effort: coding.claude_reasoning_effort ?? "",
    claude_permission_mode: coding.claude_permission_mode ?? "default",
    default_sandbox: coding.default_sandbox ?? "read-only",
    allow_workspace_write: coding.allow_workspace_write === true,
    allow_danger_full_access: coding.allow_danger_full_access === true
  };
}

export function updateCodingAgentRuntimeConfig(
  config: LocalRuntimeConfig,
  input: JsonObject
): JsonObject {
  config.capabilities ??= {};
  config.capabilities.codex ??= {};
  const coding = config.capabilities.codex;
  // A payload without a boolean `enabled` keeps the current on/off state.
  coding.enabled = configBoolean(input.enabled, coding.enabled !== false);
  const { provider, providers } = normalizeCodingAgentProviders(input.provider, input.providers);
  coding.provider = provider;
  coding.providers = providers;
  coding.command = configString(input.command);
  coding.model = configString(input.model);
  coding.reasoning_effort = configCodexReasoning(input.reasoning_effort);
  coding.antigravity_command = configString(input.antigravity_command);
  coding.antigravity_model = configString(input.antigravity_model);
  coding.antigravity_reasoning_effort = configAntigravityReasoning(input.antigravity_reasoning_effort);
  coding.cursor_command = configString(input.cursor_command);
  coding.cursor_model = configString(input.cursor_model);
  coding.cursor_model_custom = configString(input.cursor_model_custom);
  coding.claude_command = configString(input.claude_command);
  coding.claude_model = configString(input.claude_model);
  coding.claude_model_custom = configString(input.claude_model_custom);
  coding.claude_reasoning_effort = configClaudeReasoning(input.claude_reasoning_effort);
  coding.claude_permission_mode = configClaudePermission(input.claude_permission_mode);
  coding.default_sandbox = configSandbox(input.default_sandbox);
  // `input` is the full replacement (see applyCodingAgentConfigUpdate for how
  // stored grants are carried over); grants the settings imply are added.
  const derived = derivedCodingAgentGrants(coding);
  coding.allow_workspace_write = configBoolean(input.allow_workspace_write, false) || derived.allow_workspace_write;
  coding.allow_danger_full_access = configBoolean(input.allow_danger_full_access, false) || derived.allow_danger_full_access;
  return codingAgentConfigFromRuntimeConfig(config);
}

/**
 * Applies a set_coding_agent_config payload on top of the current settings,
 * like before multi-harness support: omitted fields keep their stored values
 * and the stored access grants are kept (then widened by what the settings
 * imply). A payload that names provider without providers comes from a
 * backend that predates multi-harness support: its provider is then the only
 * enabled one. When the enabled harness list changes, both grants are
 * recomputed from the enabled harnesses' own settings only: stored grants and
 * any grants in the payload (often just an echo of the old state) are ignored,
 * so a grant given for one harness never carries over to another.
 */
export function applyCodingAgentConfigUpdate(config: LocalRuntimeConfig, input: JsonObject): JsonObject {
  const current = codingAgentConfigFromRuntimeConfig(config);
  const previousProviders = current.providers;
  if (
    Object.prototype.hasOwnProperty.call(input, "provider") &&
    !Object.prototype.hasOwnProperty.call(input, "providers")
  ) {
    delete current.providers;
  }
  const merged = { ...current, ...input };
  const nextProviders = normalizeCodingAgentProviders(merged.provider, merged.providers).providers;
  if (JSON.stringify(nextProviders) !== JSON.stringify(previousProviders)) {
    delete merged.allow_workspace_write;
    delete merged.allow_danger_full_access;
  }
  return updateCodingAgentRuntimeConfig(config, merged);
}

export function defaultRuntimeConfigPath(): string {
  return path.join(os.homedir(), ".clero-local-agent", "config.json");
}

export function defaultAgentsSyncPath(configPath = defaultRuntimeConfigPath()): string {
  return path.join(path.dirname(configPath), "agents-sync.json");
}

export async function saveAgentsSyncSnapshot(filePath: string, message: AgentsSyncMessage): Promise<AgentsSyncSnapshot> {
  const snapshot: AgentsSyncSnapshot = {
    synced_at: new Date().toISOString(),
    connection_id: message.connection_id,
    agents: message.agents
  };
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(snapshot, null, 2)}\n`);
  return snapshot;
}

export async function loadAgentsSyncSnapshot(filePath: string): Promise<AgentsSyncSnapshot> {
  const raw = await readFile(filePath, "utf8");
  return parseAgentsSyncSnapshot(JSON.parse(raw) as unknown);
}

export type RuntimeCapabilityOverrides = {
  gitWriteEnabled?: boolean;
};

export function capabilityOptionsFromConfig(
  config: LocalRuntimeConfig,
  overrides: RuntimeCapabilityOverrides = {}
): LocalRuntimeCapabilityOptions {
  const { provider, providers } = normalizeCodingAgentProviders(
    config.capabilities?.codex?.provider,
    config.capabilities?.codex?.providers
  );
  // Single-harness access: the stored grants plus what the settings imply (as
  // before multi-harness support, except that the default sandbox only counts
  // while a sandbox harness is enabled, so a leftover sandbox never grants
  // Claude Code access; see derivedCodingAgentGrants). With several harnesses
  // enabled codingHarnessAccess ignores these and uses each harness's own
  // setting instead.
  const sandboxHarnessEnabled = providers.some((enabled) => enabled !== "claude-code");
  const codexSandbox = sandboxHarnessEnabled ? config.capabilities?.codex?.default_sandbox : undefined;
  const claudePermissionMode = config.capabilities?.codex?.claude_permission_mode;
  const claudeAllowWorkspaceWrite = providers.includes("claude-code") && claudePermissionMode === "acceptEdits";
  const codexAllowWorkspaceWrite =
    config.capabilities?.codex?.allow_workspace_write === true ||
    claudeAllowWorkspaceWrite ||
    codexSandbox === "workspace-write" ||
    codexSandbox === "danger-full-access";
  const codexAllowDangerFullAccess =
    config.capabilities?.codex?.allow_danger_full_access === true || codexSandbox === "danger-full-access";

  return {
    browser: {
      enabled: config.capabilities?.browser?.enabled
    },
    browserDebug: {
      enabled: config.capabilities?.browser_debug?.enabled,
      command: nonEmptyString(config.capabilities?.browser_debug?.command),
      args: config.capabilities?.browser_debug?.args,
      browserUrl: nonEmptyString(config.capabilities?.browser_debug?.browser_url)
    },
    workspace: {
      enabled: config.capabilities?.workspace?.enabled
    },
    shell: {
      enabled: config.capabilities?.shell?.enabled,
      defaultAccess: config.capabilities?.shell?.default_access,
      allowWorkspaceWrite:
        config.capabilities?.shell?.allow_workspace_write === true ||
        config.capabilities?.shell?.default_access === "workspace-write" ||
        config.capabilities?.shell?.default_access === "danger-full-access",
      allowDangerFullAccess:
        config.capabilities?.shell?.allow_danger_full_access === true ||
        config.capabilities?.shell?.default_access === "danger-full-access",
      defaultTimeoutMs: config.capabilities?.shell?.timeout_ms,
      defaultMaxOutputBytes: config.capabilities?.shell?.max_output_bytes,
      shell: nonEmptyString(config.capabilities?.shell?.shell)
    },
    codex: {
      enabled: config.capabilities?.codex?.enabled,
      provider,
      providers,
      command: config.capabilities?.codex?.command,
      model: config.capabilities?.codex?.model,
      reasoningEffort: config.capabilities?.codex?.reasoning_effort,
      antigravityCommand: config.capabilities?.codex?.antigravity_command,
      antigravityModel: config.capabilities?.codex?.antigravity_model,
      antigravityReasoningEffort: config.capabilities?.codex?.antigravity_reasoning_effort,
      cursorCommand: config.capabilities?.codex?.cursor_command,
      cursorModel: cursorModelFromConfig(config),
      claudeCommand: config.capabilities?.codex?.claude_command,
      claudeModel: claudeModelFromConfig(config),
      claudeReasoningEffort: config.capabilities?.codex?.claude_reasoning_effort,
      claudePermissionMode,
      defaultSandbox: config.capabilities?.codex?.default_sandbox,
      allowWorkspaceWrite: codexAllowWorkspaceWrite,
      allowDangerFullAccess: codexAllowDangerFullAccess
    },
    git: {
      readEnabled: config.capabilities?.git?.read_enabled,
      writeEnabled:
        overrides.gitWriteEnabled ??
        config.capabilities?.git?.write_enabled
    }
  };
}

function claudeModelFromConfig(config: LocalRuntimeConfig): string | undefined {
  const selected = config.capabilities?.codex?.claude_model;
  if (selected === "custom") {
    return config.capabilities?.codex?.claude_model_custom;
  }
  return selected;
}

function cursorModelFromConfig(config: LocalRuntimeConfig): string | undefined {
  const selected = config.capabilities?.codex?.cursor_model;
  if (selected === "custom") {
    return config.capabilities?.codex?.cursor_model_custom;
  }
  return selected;
}

function nonEmptyString(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function capabilitiesFromConfig(
  config: LocalRuntimeConfig,
  overrides: RuntimeCapabilityOverrides = {}
): Capability[] {
  const options = capabilityOptionsFromConfig(config, overrides);
  return defaultCapabilities().filter((capability) => {
    if (capability.name.startsWith("browser.")) {
      if (["browser.act", "browser.observe", "browser.extract"].includes(capability.name) && config.capabilities?.browser?.provider === "mcp-chrome") return false;
      if (
        capability.name === "browser.upload_file" &&
        config.capabilities?.browser?.provider === "mcp-chrome"
      ) {
        return false;
      }
      return options.browser?.enabled !== false;
    }
    if (capability.name.startsWith("browser_debug.")) {
      return options.browserDebug?.enabled === true;
    }
    if (capability.name.startsWith("workspace.")) {
      return options.workspace?.enabled !== false;
    }
    if (capability.name.startsWith("filesystem.")) {
      return options.workspace?.enabled !== false;
    }
    if (capability.name.startsWith("shell.")) {
      return options.shell?.enabled === true;
    }
    if (capability.name.startsWith("coding_agent.")) {
      return options.codex?.enabled !== false;
    }
    if (
      capability.name === "git.status" ||
      capability.name === "git.diff" ||
      capability.name === "git.list_branches"
    ) {
      return options.git?.readEnabled !== false;
    }
    if (
      capability.name === "git.checkout" ||
      capability.name === "git.commit" ||
      capability.name === "git.push" ||
      capability.name === "git.pull" ||
      capability.name === "git.abort_pull"
    ) {
      return options.git?.writeEnabled !== false;
    }
    return true;
  });
}

export function mergeRuntimeConfig(base: LocalRuntimeConfig, override: LocalRuntimeConfig): LocalRuntimeConfig {
  return {
    ...base,
    ...override,
    allowed_directories:
      override.allowed_directories && override.allowed_directories.length > 0
        ? override.allowed_directories
        : base.allowed_directories,
    capabilities: {
      browser: {
        ...base.capabilities?.browser,
        ...override.capabilities?.browser
      },
      browser_debug: {
        ...base.capabilities?.browser_debug,
        ...override.capabilities?.browser_debug
      },
      workspace: {
        ...base.capabilities?.workspace,
        ...override.capabilities?.workspace
      },
      shell: {
        ...base.capabilities?.shell,
        ...override.capabilities?.shell
      },
      codex: mergeCodingAgentConfig(base.capabilities?.codex, override.capabilities?.codex),
      git: {
        ...base.capabilities?.git,
        ...override.capabilities?.git
      }
    }
  };
}

export type CodingAgentRuntimeConfig = NonNullable<NonNullable<LocalRuntimeConfig["capabilities"]>["codex"]>;

function mergeCodingAgentConfig(
  base: CodingAgentRuntimeConfig | undefined,
  override: CodingAgentRuntimeConfig | undefined
): CodingAgentRuntimeConfig {
  const merged: CodingAgentRuntimeConfig = { ...base, ...override };
  // A config without its own harness list (files written before multi-harness
  // support) enables only its default harness, not the base list.
  const providers = override && Object.prototype.hasOwnProperty.call(override, "providers")
    ? override.providers
    : override?.provider !== undefined ? undefined : base?.providers;
  const normalized = normalizeCodingAgentProviders(merged.provider, providers);
  merged.provider = normalized.provider;
  merged.providers = normalized.providers;
  return merged;
}

function parseAgentsSyncSnapshot(value: unknown): AgentsSyncSnapshot {
  if (!isRecord(value) || typeof value.synced_at !== "string" || !Array.isArray(value.agents)) {
    throw new Error("Invalid agents sync cache");
  }

  return {
    synced_at: value.synced_at,
    connection_id: brokerIdValue(value.connection_id),
    agents: value.agents.map(parseSyncedAgent).filter((agent): agent is SyncedAgent => Boolean(agent))
  };
}

function parseSyncedAgent(value: unknown): SyncedAgent | null {
  if (!isRecord(value)) {
    return null;
  }
  const agentId = brokerIdValue(value.agent_id);
  if (agentId === undefined) {
    return null;
  }

  return {
    agent_id: agentId,
    name: stringValue(value.name),
    icon: stringValue(value.icon),
    avatar_url: stringOrNullValue(value.avatar_url),
    browser_enabled: booleanValue(value.browser_enabled),
    coding_enabled: booleanValue(value.coding_enabled),
    git_read_enabled: booleanValue(value.git_read_enabled),
    git_write_enabled: booleanValue(value.git_write_enabled),
    browser_profile_key: stringValue(value.browser_profile_key)
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function brokerIdValue(value: unknown): BrokerId | undefined {
  if (typeof value === "string" || typeof value === "number" || value === null) {
    return value;
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringOrNullValue(value: unknown): string | null | undefined {
  if (value === null || typeof value === "string") {
    return value;
  }
  return undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function configString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function configBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function configSandbox(value: unknown): CodexSandbox {
  return value === "workspace-write" || value === "danger-full-access"
    ? value
    : "read-only";
}

function configCodexReasoning(value: unknown): CodexReasoningEffort | undefined {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh"
    ? value
    : undefined;
}

function configClaudeReasoning(value: unknown): ClaudeCodeReasoningEffort | undefined {
  return value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
    ? value
    : undefined;
}

function configAntigravityReasoning(value: unknown): AntigravityReasoningEffort | undefined {
  return value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
    ? value
    : undefined;
}

function configClaudePermission(value: unknown): ClaudeCodePermissionMode {
  return value === "acceptEdits" ||
    value === "plan" ||
    value === "auto" ||
    value === "dontAsk" ||
    value === "bypassPermissions"
    ? value
    : "default";
}
