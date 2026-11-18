import {
  derivedCodingAgentGrants,
  normalizeCodingAgentProviders,
  type ClaudeCodePermissionMode,
  type CodingAgentProvider,
  type CodexSandbox
} from "@clero-local-agent/coding-agents";
import type { LocalRuntimeConfig } from "@clero-local-agent/daemon";
import { getBoolean, getString, getStrings, type CliArgs } from "./args.ts";

/**
 * Coding-harness flags:
 * - --coding-providers / --providers sets every enabled harness (comma-separated or repeated);
 *   --coding-provider / --provider then picks the default among them.
 * - --coding-provider / --provider alone is the single-harness flag: that harness becomes
 *   the only enabled one, exactly as before multi-harness support.
 * When the enabled harnesses change, the shared access grants are recomputed from the new
 * harnesses' own settings so a grant never carries over to a harness nobody chose.
 */
export function applyCodingFlags(config: LocalRuntimeConfig, args: CliArgs, enableIfConfigured: boolean): void {
  config.capabilities ??= {};
  config.capabilities.codex ??= {};
  const coding = config.capabilities.codex;
  const previousProviders = normalizeCodingAgentProviders(coding.provider, coding.providers).providers;

  if (enableIfConfigured) {
    coding.enabled = true;
  }
  if (getBoolean(args, "disable-coding")) {
    coding.enabled = false;
  }
  const provider = getString(args, "coding-provider") ?? getString(args, "provider");
  const providers = codingProvidersArg(args);
  if (providers) {
    const defaultProvider = provider ? codingProviderArg(provider) : undefined;
    if (defaultProvider && !providers.includes(defaultProvider)) {
      throw new Error("--coding-provider must be one of the harnesses listed in --coding-providers");
    }
    coding.provider = defaultProvider ?? (coding.provider && providers.includes(coding.provider) ? coding.provider : providers[0]);
    coding.providers = providers;
  } else if (provider) {
    coding.provider = codingProviderArg(provider);
    coding.providers = [coding.provider];
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
    } else if (coding.provider === "cursor") {
      coding.cursor_command = command;
    } else {
      coding.command = command;
    }
  }
  const model = getString(args, "model");
  if (model) {
    if (coding.provider === "claude-code") {
      coding.claude_model = model;
    } else if (coding.provider === "cursor") {
      coding.cursor_model = model;
    } else {
      coding.model = model;
    }
  }
  const permissionMode = getString(args, "claude-permission-mode");
  if (permissionMode) {
    coding.claude_permission_mode = claudePermissionModeArg(permissionMode);
  }
  const nextProviders = normalizeCodingAgentProviders(coding.provider, coding.providers).providers;
  if (nextProviders.join(",") !== previousProviders.join(",")) {
    const derived = derivedCodingAgentGrants(coding);
    coding.allow_workspace_write = derived.allow_workspace_write;
    coding.allow_danger_full_access = derived.allow_danger_full_access;
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
}

export function codingProvidersArg(args: CliArgs): CodingAgentProvider[] | undefined {
  const flags = ["coding-providers", "providers"].filter(key => args[key] !== undefined);
  if (flags.length === 0) {
    return undefined;
  }
  const invalid = () => new Error(
    `--${flags[0]} needs a comma-separated list of codex, claude-code, antigravity, or cursor`
  );
  if (flags.some(key => args[key] === true)) {
    throw invalid();
  }
  const values = flags
    .flatMap(key => getStrings(args, key))
    .flatMap(value => value.split(","))
    .map(value => value.trim())
    .filter(Boolean);
  if (values.length === 0) {
    throw invalid();
  }
  const providers: CodingAgentProvider[] = [];
  for (const value of values) {
    if (value !== "codex" && value !== "claude-code" && value !== "antigravity" && value !== "cursor") {
      throw invalid();
    }
    if (!providers.includes(value)) {
      providers.push(value);
    }
  }
  return providers;
}

function codingProviderArg(value: string): CodingAgentProvider {
  if (value === "codex" || value === "claude-code" || value === "antigravity" || value === "cursor") {
    return value;
  }

  throw new Error("--coding-provider must be codex, claude-code, antigravity, or cursor");
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
