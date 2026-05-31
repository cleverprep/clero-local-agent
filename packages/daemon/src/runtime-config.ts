import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BrowserViewport } from "@clero-local-agent/browser";
import type {
  ClaudeCodePermissionMode,
  ClaudeCodeReasoningEffort,
  CodingAgentProvider,
  CodexReasoningEffort,
  CodexSandbox
} from "@clero-local-agent/coding-agents";
import { defaultCapabilities, type AgentsSyncMessage, type BrokerId, type Capability, type SyncedAgent } from "@clero-local-agent/protocol";
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
    workspace?: {
      enabled?: boolean;
    };
    codex?: {
      enabled?: boolean;
      provider?: CodingAgentProvider;
      command?: string;
      model?: string;
      reasoning_effort?: CodexReasoningEffort;
      antigravity_command?: string;
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
      workspace: {
        enabled: true
      },
      codex: {
        enabled: false,
        provider: "codex",
        command: "",
        model: "",
        reasoning_effort: undefined,
        antigravity_command: "",
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
  const projectsDirectory = path.join(os.homedir(), "Projects");
  return existsSync(projectsDirectory) ? [projectsDirectory] : [];
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

export function capabilityOptionsFromConfig(config: LocalRuntimeConfig): LocalRuntimeCapabilityOptions {
  const codexSandbox = config.capabilities?.codex?.default_sandbox;
  const claudePermissionMode = config.capabilities?.codex?.claude_permission_mode;
  const claudeAllowWorkspaceWrite =
    config.capabilities?.codex?.provider === "claude-code" && claudePermissionMode === "acceptEdits";
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
    workspace: {
      enabled: config.capabilities?.workspace?.enabled
    },
    codex: {
      enabled: config.capabilities?.codex?.enabled,
      provider: config.capabilities?.codex?.provider,
      command: config.capabilities?.codex?.command,
      model: config.capabilities?.codex?.model,
      reasoningEffort: config.capabilities?.codex?.reasoning_effort,
      antigravityCommand: config.capabilities?.codex?.antigravity_command,
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
      writeEnabled: config.capabilities?.git?.write_enabled
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

function nonEmptyString(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function capabilitiesFromConfig(config: LocalRuntimeConfig): Capability[] {
  const options = capabilityOptionsFromConfig(config);
  return defaultCapabilities().filter((capability) => {
    if (capability.name.startsWith("browser.")) {
      return options.browser?.enabled !== false;
    }
    if (capability.name.startsWith("workspace.")) {
      return options.workspace?.enabled !== false;
    }
    if (capability.name.startsWith("coding_agent.")) {
      return options.codex?.enabled !== false;
    }
    if (capability.name === "git.status" || capability.name === "git.diff") {
      return options.git?.readEnabled !== false;
    }
    if (capability.name === "git.commit" || capability.name === "git.push") {
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
      workspace: {
        ...base.capabilities?.workspace,
        ...override.capabilities?.workspace
      },
      codex: {
        ...base.capabilities?.codex,
        ...override.capabilities?.codex
      },
      git: {
        ...base.capabilities?.git,
        ...override.capabilities?.git
      }
    }
  };
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
