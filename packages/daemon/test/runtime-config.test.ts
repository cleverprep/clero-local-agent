import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyCodingAgentConfigUpdate,
  capabilitiesFromConfig,
  capabilityOptionsFromConfig,
  codingAgentConfigFromRuntimeConfig,
  defaultAgentsSyncPath,
  defaultRuntimeConfig,
  loadAgentsSyncSnapshot,
  mergeRuntimeConfig,
  resolveDeviceToken,
  saveAgentsSyncSnapshot,
  saveRuntimeConfig,
  updateCodingAgentRuntimeConfig,
  loadRuntimeConfig,
  type CodingAgentRuntimeConfig,
  type LocalRuntimeConfig
} from "../src/runtime-config.ts";
import type { TokenStore } from "../src/token-store.ts";
import { codingHarnessAccess, LocalRuntimeDaemon } from "../src/daemon.ts";
import { derivedCodingAgentGrants, normalizeCodingAgentProviders } from "@clero-local-agent/coding-agents";
import type { JsonObject } from "@clero-local-agent/protocol";
// Shared with apps/desktop/src-tauri/src/lib.rs (derived_coding_grants_match_the_shared_cases).
import grantCases from "./fixtures/coding-grant-cases.json" with { type: "json" };
import { applyCodingFlags } from "../../../apps/cli/src/coding-flags.ts";

class MemoryTokenStore implements TokenStore {
  readonly values = new Map<string, string>();
  readonly setCalls: Array<{ account: string; token: string }> = [];
  readonly deleteCalls: string[] = [];

  constructor(initialValues: Record<string, string> = {}) {
    for (const [account, token] of Object.entries(initialValues)) {
      this.values.set(account, token);
    }
  }

  async get(account: string): Promise<string | null> {
    return this.values.get(account) ?? null;
  }

  async set(account: string, token: string): Promise<void> {
    this.values.set(account, token);
    this.setCalls.push({ account, token });
  }

  async delete(account: string): Promise<void> {
    this.values.delete(account);
    this.deleteCalls.push(account);
  }
}

test("filters advertised capabilities from runtime config", () => {
  const config = defaultRuntimeConfig();
  config.capabilities!.browser!.enabled = false;
  config.capabilities!.browser_debug!.enabled = false;
  config.capabilities!.shell!.enabled = false;
  config.capabilities!.codex!.enabled = false;
  config.capabilities!.git!.write_enabled = false;

  const names = capabilitiesFromConfig(config).map((capability) => capability.name);

  assert.equal(names.some((name) => name.startsWith("browser.")), false);
  assert.equal(names.some((name) => name.startsWith("browser_debug.")), false);
  assert.equal(names.some((name) => name.startsWith("shell.")), false);
  assert.equal(names.some((name) => name.startsWith("coding_agent.")), false);
  assert.equal(names.includes("git.status"), true);
  assert.equal(names.includes("git.commit"), false);
  assert.equal(names.includes("git.pull"), false);
  assert.equal(names.includes("git.abort_pull"), false);
  assert.equal(names.includes("workspace.list_projects"), true);
});

test("standalone override always advertises approval-gated git writes", () => {
  const config = defaultRuntimeConfig();
  config.capabilities!.git!.write_enabled = false;

  const options = capabilityOptionsFromConfig(config, {
    gitWriteEnabled: true
  });
  const names = capabilitiesFromConfig(config, {
    gitWriteEnabled: true
  }).map((capability) => capability.name);

  assert.equal(options.git?.writeEnabled, true);
  assert.equal(names.includes("git.checkout"), true);
  assert.equal(names.includes("git.commit"), true);
  assert.equal(names.includes("git.push"), true);
  assert.equal(names.includes("git.pull"), true);
  assert.equal(names.includes("git.abort_pull"), true);
});

test("advertises browser upload only for the managed browser provider", () => {
  const config = defaultRuntimeConfig();

  assert.equal(
    capabilitiesFromConfig(config).some((capability) => capability.name === "browser.upload_file"),
    true
  );
  assert.equal(
    capabilitiesFromConfig(config).find((capability) => capability.name === "browser.upload_file")?.access,
    "passive"
  );

  config.capabilities!.browser!.provider = "mcp-chrome";

  assert.equal(
    capabilitiesFromConfig(config).some((capability) => capability.name === "browser.upload_file"),
    false
  );
});

test("advertises browser debug capabilities only when enabled", () => {
  const config = defaultRuntimeConfig();

  assert.equal(capabilitiesFromConfig(config).some((capability) => capability.name.startsWith("browser_debug.")), false);

  config.capabilities!.browser_debug!.enabled = true;
  config.capabilities!.browser_debug!.browser_url = "http://127.0.0.1:9222";
  config.capabilities!.browser_debug!.command = "";

  const capabilities = capabilitiesFromConfig(config);
  const callTool = capabilities.find((capability) => capability.name === "browser_debug.call_tool");

  assert.ok(callTool);
  assert.deepEqual(callTool.groups, ["browser_debug"]);
  assert.equal(capabilityOptionsFromConfig(config).browserDebug?.enabled, true);
  assert.equal(capabilityOptionsFromConfig(config).browserDebug?.browserUrl, "http://127.0.0.1:9222");
  assert.equal(capabilityOptionsFromConfig(config).browserDebug?.command, undefined);
});

test("advertises Antigravity through coding-agent tool capabilities", () => {
  const config = defaultRuntimeConfig();
  config.capabilities!.codex!.enabled = true;
  config.capabilities!.codex!.provider = "antigravity";

  const capabilities = capabilitiesFromConfig(config);
  const startTask = capabilities.find((capability) => capability.name === "coding_agent.start_task");

  assert.ok(startTask);
  assert.deepEqual(startTask.groups, ["codex"]);
});

test("maps runtime config to daemon capability options", () => {
  const config = defaultRuntimeConfig();
  config.capabilities!.codex!.enabled = true;
  config.capabilities!.codex!.default_sandbox = "workspace-write";
  config.capabilities!.codex!.allow_workspace_write = true;
  config.capabilities!.codex!.allow_danger_full_access = false;

  assert.deepEqual(capabilityOptionsFromConfig(config).codex, {
    enabled: true,
    provider: "codex",
    providers: ["codex"],
    command: "",
    model: "",
    reasoningEffort: undefined,
    antigravityCommand: "",
    cursorCommand: "",
    cursorModel: "",
    claudeCommand: "",
    claudeModel: "",
    claudeReasoningEffort: undefined,
    claudePermissionMode: "default",
    defaultSandbox: "workspace-write",
    allowWorkspaceWrite: true,
    allowDangerFullAccess: false
  });
  assert.deepEqual(capabilityOptionsFromConfig(config).shell, {
    enabled: false,
    defaultAccess: "read-only",
    allowWorkspaceWrite: false,
    allowDangerFullAccess: false,
    defaultTimeoutMs: 30000,
    defaultMaxOutputBytes: 200000,
    shell: undefined
  });
  assert.deepEqual(capabilityOptionsFromConfig(config).browserDebug, {
    enabled: false,
    command: undefined,
    args: undefined,
    browserUrl: undefined
  });
});

test("updates connector coding-agent configuration without replacing unrelated runtime settings", () => {
  const config = defaultRuntimeConfig();
  config.capabilities!.browser!.enabled = false;

  const saved = applyCodingAgentConfigUpdate(config, {
    enabled: true,
    provider: "cursor",
    cursor_command: "/opt/cursor/agent",
    cursor_model: "composer-1",
    default_sandbox: "workspace-write"
  });

  assert.equal(saved.provider, "cursor");
  assert.deepEqual(saved.providers, ["cursor"]);
  assert.equal(saved.allow_workspace_write, true);
  assert.equal(config.capabilities?.codex?.cursor_command, "/opt/cursor/agent");
  assert.equal(config.capabilities?.codex?.cursor_model, "composer-1");
  assert.equal(config.capabilities?.browser?.enabled, false);
});

test("enables managed browser session persistence by default", () => {
  const config = defaultRuntimeConfig();

  assert.equal(config.capabilities?.browser?.remember_session, true);
  assert.match(config.capabilities?.browser?.browser_profile_dir ?? "", /\.clero-local-agent/);
});

test("advertises shell capability only when enabled", () => {
  const config = defaultRuntimeConfig();

  assert.equal(capabilitiesFromConfig(config).some((capability) => capability.name === "shell.run"), false);

  config.capabilities!.shell!.enabled = true;

  const shell = capabilitiesFromConfig(config).find((capability) => capability.name === "shell.run");

  assert.ok(shell);
  assert.deepEqual(shell.groups, ["shell"]);
  assert.equal(capabilityOptionsFromConfig(config).shell?.enabled, true);
});

test("shell workspace-write access enables local shell write permission", () => {
  const config = defaultRuntimeConfig();
  config.capabilities!.shell!.default_access = "workspace-write";
  config.capabilities!.shell!.allow_workspace_write = false;

  assert.equal(capabilityOptionsFromConfig(config).shell?.allowWorkspaceWrite, true);
});

test("workspace-write default sandbox enables Codex write permission", () => {
  const config = defaultRuntimeConfig();
  config.capabilities!.codex!.default_sandbox = "workspace-write";
  config.capabilities!.codex!.allow_workspace_write = false;

  assert.equal(capabilityOptionsFromConfig(config).codex?.allowWorkspaceWrite, true);
});

test("Claude acceptEdits permission enables local workspace-write approval", () => {
  const config = defaultRuntimeConfig();
  config.capabilities!.codex!.provider = "claude-code";
  config.capabilities!.codex!.providers = ["claude-code"];
  config.capabilities!.codex!.claude_permission_mode = "acceptEdits";
  config.capabilities!.codex!.allow_workspace_write = false;

  assert.equal(capabilityOptionsFromConfig(config).codex?.allowWorkspaceWrite, true);
});

test("maps custom Claude model selection to daemon options", () => {
  const config = defaultRuntimeConfig();
  config.capabilities!.codex!.provider = "claude-code";
  config.capabilities!.codex!.claude_model = "custom";
  config.capabilities!.codex!.claude_model_custom = "claude-sonnet-4-5";

  assert.equal(capabilityOptionsFromConfig(config).codex?.claudeModel, "claude-sonnet-4-5");
});

test("maps custom Cursor model selection to daemon options", () => {
  const config = defaultRuntimeConfig();
  config.capabilities!.codex!.provider = "cursor";
  config.capabilities!.codex!.cursor_model = "custom";
  config.capabilities!.codex!.cursor_model_custom = "gpt-5-cursor";

  assert.equal(capabilityOptionsFromConfig(config).codex?.cursorModel, "gpt-5-cursor");
});

test("empty allowed directories keep the default projects root", () => {
  const base = defaultRuntimeConfig();
  const merged = mergeRuntimeConfig(base, { allowed_directories: [] });

  assert.deepEqual(merged.allowed_directories, base.allowed_directories);
});

test("saves and loads runtime config", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "clero-runtime-config-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, "config.json");
  const config = defaultRuntimeConfig();
  config.device_name = "Test Device";
  config.allowed_directories = [directory];
  config.capabilities!.browser!.browser_viewport = { width: 1440, height: 900 };

  await saveRuntimeConfig(configPath, config);
  const raw = await readFile(configPath, "utf8");
  const loaded = await loadRuntimeConfig(configPath);

  assert.match(raw, /Test Device/);
  assert.equal(loaded.device_name, "Test Device");
  assert.deepEqual(loaded.allowed_directories, [directory]);
  assert.deepEqual(loaded.capabilities?.browser?.browser_viewport, { width: 1440, height: 900 });
});

test("saves and loads synced agents snapshot", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "clero-agents-sync-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, "config.json");
  const syncPath = defaultAgentsSyncPath(configPath);

  await saveAgentsSyncSnapshot(syncPath, {
    type: "agents_sync",
    connection_id: 45,
    agents: [
      {
        agent_id: 12,
        name: "Browser Agent",
        browser_enabled: true,
        coding_enabled: false,
        git_read_enabled: true,
        git_write_enabled: false,
        browser_profile_key: "agent-12"
      }
    ]
  });

  const loaded = await loadAgentsSyncSnapshot(syncPath);

  assert.equal(loaded.connection_id, 45);
  assert.match(loaded.synced_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(loaded.agents, [
    {
      agent_id: 12,
      name: "Browser Agent",
      icon: undefined,
      avatar_url: undefined,
      browser_enabled: true,
      coding_enabled: false,
      git_read_enabled: true,
      git_write_enabled: false,
      browser_profile_key: "agent-12"
    }
  ]);
});

test("resolves device token from config JSON before the token store", async () => {
  const config = defaultRuntimeConfig();
  config.device_token = "json-token";
  const tokenStore = new MemoryTokenStore({ device_token: "stored-token" });

  const token = await resolveDeviceToken(config, tokenStore);

  assert.equal(token, "json-token");
  assert.deepEqual(tokenStore.setCalls, [{ account: "device_token", token: "json-token" }]);
  assert.equal(await tokenStore.get("device_token"), "json-token");
});

test("saves config JSON device token to the token store on first use", async () => {
  const config = defaultRuntimeConfig();
  config.device_token = "json-token";
  const tokenStore = new MemoryTokenStore();

  const token = await resolveDeviceToken(config, tokenStore);

  assert.equal(token, "json-token");
  assert.deepEqual(tokenStore.setCalls, [{ account: "device_token", token: "json-token" }]);
  assert.equal(await tokenStore.get("device_token"), "json-token");
});

test("resolves device token from the token store when config JSON has no token", async () => {
  const config = defaultRuntimeConfig();
  const tokenStore = new MemoryTokenStore({ device_token: "stored-token" });

  const token = await resolveDeviceToken(config, tokenStore);

  assert.equal(token, "stored-token");
  assert.deepEqual(tokenStore.deleteCalls, []);
});

test("clears the token store when config JSON explicitly clears the device token", async () => {
  const config = defaultRuntimeConfig();
  config.device_token = "";
  const tokenStore = new MemoryTokenStore({ device_token: "stored-token" });

  const token = await resolveDeviceToken(config, tokenStore);

  assert.equal(token, undefined);
  assert.deepEqual(tokenStore.deleteCalls, ["device_token"]);
  assert.equal(await tokenStore.get("device_token"), null);
});

test("disabled coding keeps the harness list through config reads, updates, and capabilities", () => {
  const config = defaultRuntimeConfig();
  config.capabilities!.codex = { enabled: false, provider: "cursor", providers: ["cursor", "codex"] };
  const read = codingAgentConfigFromRuntimeConfig(config);
  assert.equal(read.enabled, false);
  assert.deepEqual([read.provider, read.providers], ["cursor", ["cursor", "codex"]]);
  assert.equal(capabilitiesFromConfig(config).some((capability) => capability.name.startsWith("coding_agent.")), false);
  assert.deepEqual(capabilityOptionsFromConfig(config).codex?.providers, ["cursor", "codex"]);

  const saved = applyCodingAgentConfigUpdate(config, { model: "gpt-test" });
  assert.equal(saved.enabled, false);
  assert.deepEqual(saved.providers, ["cursor", "codex"]);
  const enabled = applyCodingAgentConfigUpdate(config, { enabled: true });
  assert.equal(enabled.enabled, true);
  assert.deepEqual(enabled.providers, ["cursor", "codex"]);
  assert.equal(capabilitiesFromConfig(config).some((capability) => capability.name === "coding_agent.start_task"), true);
});

test("a coding config update without enabled keeps the current on/off state", () => {
  const off = defaultRuntimeConfig();
  assert.equal(updateCodingAgentRuntimeConfig(off, { provider: "codex", model: "x" }).enabled, false);
  assert.equal(applyCodingAgentConfigUpdate(off, { model: "y" }).enabled, false);
  assert.equal(applyCodingAgentConfigUpdate(off, { enabled: true }).enabled, true);
  assert.equal(updateCodingAgentRuntimeConfig(off, { provider: "codex", model: "z" }).enabled, true);
  assert.equal(applyCodingAgentConfigUpdate(off, { enabled: false }).enabled, false);
  assert.equal(codingAgentConfigFromRuntimeConfig(off).enabled, false);
});

test("coding harness lists keep valid unique harnesses in order and always contain the default", () => {
  assert.deepEqual(normalizeCodingAgentProviders("codex", undefined), { provider: "codex", providers: ["codex"] });
  assert.deepEqual(normalizeCodingAgentProviders("cursor", []), { provider: "cursor", providers: ["cursor"] });
  assert.deepEqual(
    normalizeCodingAgentProviders("claude-code", ["cursor", "bogus", "claude-code", "cursor", 7, "codex"]),
    { provider: "claude-code", providers: ["cursor", "claude-code", "codex"] }
  );
  // An explicit default missing from a (possibly stale) list wins and is appended.
  assert.deepEqual(
    normalizeCodingAgentProviders("antigravity", ["claude-code", "codex"]),
    { provider: "antigravity", providers: ["claude-code", "codex", "antigravity"] }
  );
  // An invalid default falls back to the first enabled harness.
  assert.deepEqual(
    normalizeCodingAgentProviders("bogus", ["claude-code", "codex"]),
    { provider: "claude-code", providers: ["claude-code", "codex"] }
  );
  assert.deepEqual(normalizeCodingAgentProviders("bogus", ["bogus"]), { provider: "codex", providers: ["codex"] });
  assert.deepEqual(normalizeCodingAgentProviders(undefined, ["cursor", "codex"]), { provider: "cursor", providers: ["cursor", "codex"] });
});

test("config files without a harness list keep working with only their default harness", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "clero-coding-providers-"));
  try {
    const configPath = path.join(directory, "config.json");
    await writeFile(configPath, JSON.stringify({
      capabilities: { codex: { enabled: true, provider: "claude-code", claude_permission_mode: "acceptEdits" } }
    }));
    const config = await loadRuntimeConfig(configPath);
    assert.equal(config.capabilities?.codex?.provider, "claude-code");
    assert.deepEqual(config.capabilities?.codex?.providers, ["claude-code"]);
    assert.equal(config.capabilities?.codex?.claude_permission_mode, "acceptEdits");
    assert.equal(capabilityOptionsFromConfig(config).codex?.provider, "claude-code");
    assert.deepEqual(capabilityOptionsFromConfig(config).codex?.providers, ["claude-code"]);
    const coding = codingAgentConfigFromRuntimeConfig(config);
    assert.equal(coding.provider, "claude-code");
    assert.deepEqual(coding.providers, ["claude-code"]);

    await saveRuntimeConfig(configPath, config);
    const saved = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(saved.capabilities.codex.provider, "claude-code");
    assert.deepEqual(saved.capabilities.codex.providers, ["claude-code"]);

    await writeFile(configPath, JSON.stringify({
      capabilities: { codex: { enabled: true, provider: "codex", providers: ["cursor", "nope", "cursor", "claude-code"] } }
    }));
    const multi = await loadRuntimeConfig(configPath);
    assert.equal(multi.capabilities?.codex?.provider, "codex");
    assert.deepEqual(multi.capabilities?.codex?.providers, ["cursor", "claude-code", "codex"]);
    assert.deepEqual(capabilityOptionsFromConfig(multi).codex?.providers, ["cursor", "claude-code", "codex"]);
    assert.equal(capabilityOptionsFromConfig(multi).codex?.provider, "codex");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("set_coding_agent_config normalizes the harness list and old payloads enable only their provider", () => {
  const config: LocalRuntimeConfig = { capabilities: { codex: { provider: "codex", providers: ["codex"] } } };
  const saved = applyCodingAgentConfigUpdate(config, {
    provider: "cursor",
    providers: ["claude-code", "claude-code", "bogus", "codex"]
  });
  // The explicit default wins over a list that does not contain it.
  assert.equal(saved.provider, "cursor");
  assert.deepEqual(saved.providers, ["claude-code", "codex", "cursor"]);
  assert.deepEqual(config.capabilities?.codex?.providers, ["claude-code", "codex", "cursor"]);

  const modelOnly = applyCodingAgentConfigUpdate(config, { model: "gpt-test" });
  assert.equal(modelOnly.provider, "cursor");
  assert.deepEqual(modelOnly.providers, ["claude-code", "codex", "cursor"]);

  // A stale echoed list with a new default keeps the user's default choice.
  const staleEcho = applyCodingAgentConfigUpdate(config, {
    ...codingAgentConfigFromRuntimeConfig(config),
    provider: "antigravity",
    providers: ["claude-code", "codex"]
  });
  assert.equal(staleEcho.provider, "antigravity");
  assert.deepEqual(staleEcho.providers, ["claude-code", "codex", "antigravity"]);
  assert.equal(modelOnly.model, "gpt-test");

  const legacy = applyCodingAgentConfigUpdate(config, { provider: "codex", default_sandbox: "workspace-write" });
  assert.equal(legacy.provider, "codex");
  assert.deepEqual(legacy.providers, ["codex"]);
  assert.equal(legacy.model, "gpt-test");
  assert.equal(codingAgentConfigFromRuntimeConfig(config).provider, "codex");
  assert.deepEqual(codingAgentConfigFromRuntimeConfig(config).providers, ["codex"]);

  const emptyList = updateCodingAgentRuntimeConfig(config, { provider: "antigravity", providers: [] });
  assert.deepEqual([emptyList.provider, emptyList.providers], ["antigravity", ["antigravity"]]);
});

function accessFor(config: LocalRuntimeConfig) {
  const options = capabilityOptionsFromConfig(config).codex;
  return {
    codex: codingHarnessAccess("codex", options),
    cursor: codingHarnessAccess("cursor", options),
    claude: codingHarnessAccess("claude-code", options)
  };
}

const noAccess = { allowWorkspaceWrite: false, allowDangerFullAccess: false };
const writeAccess = { allowWorkspaceWrite: true, allowDangerFullAccess: false };
const fullAccess = { allowWorkspaceWrite: true, allowDangerFullAccess: true };

test("a changed harness list drops stored grants; an unchanged one keeps them like before", () => {
  const config: LocalRuntimeConfig = {};
  const saved = applyCodingAgentConfigUpdate(config, {
    provider: "codex",
    providers: ["codex", "claude-code"],
    default_sandbox: "read-only",
    claude_permission_mode: "bypassPermissions"
  });
  // Claude being enabled (not default) is enough to derive its grant.
  assert.deepEqual([saved.allow_workspace_write, saved.allow_danger_full_access], [false, true]);

  // The list shrinks to Codex only: the Claude-derived grant must not survive.
  const shrunk = applyCodingAgentConfigUpdate(config, { providers: ["codex"] });
  assert.deepEqual([shrunk.allow_workspace_write, shrunk.allow_danger_full_access], [false, false]);
  assert.deepEqual(accessFor(config).codex, noAccess);

  // Claude acceptEdits, then downgraded while both stay enabled: the stored
  // grant stays (unchanged list) but widens nobody in multi-harness mode, and
  // is dropped once the list shrinks.
  applyCodingAgentConfigUpdate(config, { providers: ["codex", "claude-code"], claude_permission_mode: "acceptEdits" });
  assert.deepEqual(accessFor(config).claude, writeAccess);
  applyCodingAgentConfigUpdate(config, { claude_permission_mode: "default" });
  assert.equal(config.capabilities?.codex?.allow_workspace_write, true);
  assert.deepEqual(accessFor(config).codex, noAccess);
  assert.deepEqual(accessFor(config).claude, noAccess);
  applyCodingAgentConfigUpdate(config, { providers: ["codex"] });
  assert.equal(config.capabilities?.codex?.allow_workspace_write, false);
  assert.deepEqual(accessFor(config).codex, noAccess);

  // On a list change grants in the payload are ignored too: only the enabled
  // harnesses' own settings count.
  applyCodingAgentConfigUpdate(config, { provider: "cursor", allow_workspace_write: true });
  assert.deepEqual(config.capabilities?.codex?.providers, ["cursor"]);
  assert.equal(config.capabilities?.codex?.allow_workspace_write, false);
  assert.deepEqual(accessFor(config).cursor, noAccess);
});

test("a payload echoing a Claude-derived grant while shrinking to Codex does not give Codex write access", () => {
  const config: LocalRuntimeConfig = {};
  applyCodingAgentConfigUpdate(config, {
    provider: "codex",
    providers: ["codex", "claude-code"],
    default_sandbox: "read-only",
    claude_permission_mode: "acceptEdits"
  });
  const before = codingAgentConfigFromRuntimeConfig(config);
  assert.equal(before.allow_workspace_write, true, "derived from Claude acceptEdits");
  assert.deepEqual(accessFor(config).codex, noAccess);

  // A client sends back everything it read, with only the harness list changed.
  const saved = applyCodingAgentConfigUpdate(config, { ...before, providers: ["codex"] });
  assert.deepEqual(saved.providers, ["codex"]);
  assert.deepEqual([saved.allow_workspace_write, saved.allow_danger_full_access], [false, false]);
  assert.deepEqual(accessFor(config).codex, noAccess);

  // Same list: an explicit payload grant keeps working as before.
  applyCodingAgentConfigUpdate(config, { allow_workspace_write: true });
  assert.deepEqual(accessFor(config).codex, writeAccess);
});

test("remote saves keep explicit single-harness grants as before", () => {
  const codexFull: LocalRuntimeConfig = {
    capabilities: { codex: { provider: "codex", default_sandbox: "workspace-write", allow_danger_full_access: true } }
  };
  applyCodingAgentConfigUpdate(codexFull, { model: "gpt-test" });
  assert.equal(codexFull.capabilities?.codex?.allow_danger_full_access, true);
  assert.deepEqual(accessFor(codexFull).codex, fullAccess);

  const claudeWrite: LocalRuntimeConfig = {
    capabilities: { codex: { provider: "claude-code", claude_permission_mode: "default", allow_workspace_write: true } }
  };
  applyCodingAgentConfigUpdate(claudeWrite, { claude_model: "sonnet" });
  assert.equal(claudeWrite.capabilities?.codex?.allow_workspace_write, true);
  assert.deepEqual(accessFor(claudeWrite).claude, writeAccess);

  // An old backend always sends both flags; an explicit false still cannot
  // remove what the settings imply, exactly as before.
  applyCodingAgentConfigUpdate(codexFull, { provider: "codex", allow_workspace_write: false, allow_danger_full_access: false });
  assert.deepEqual(accessFor(codexFull).codex, writeAccess);
});

test("single-harness access is the same on the running daemon after a remote save and after a restart", () => {
  const scenarios: Array<{ stored: CodingAgentRuntimeConfig; payload: JsonObject }> = [
    { stored: { provider: "claude-code", default_sandbox: "danger-full-access" }, payload: { claude_model: "opus" } },
    { stored: { provider: "claude-code", claude_permission_mode: "acceptEdits" }, payload: { model: "x" } },
    { stored: { provider: "claude-code", allow_workspace_write: true }, payload: { claude_permission_mode: "bypassPermissions" } },
    { stored: { provider: "codex", default_sandbox: "workspace-write", allow_danger_full_access: true }, payload: { model: "x" } },
    { stored: { provider: "codex", allow_workspace_write: true }, payload: { default_sandbox: "read-only" } },
    { stored: { provider: "cursor", default_sandbox: "danger-full-access" }, payload: { provider: "cursor" } },
    { stored: { provider: "codex", providers: ["codex", "claude-code"], claude_permission_mode: "bypassPermissions" }, payload: { providers: ["claude-code"] } }
  ];
  for (const { stored, payload } of scenarios) {
    const config: LocalRuntimeConfig = { capabilities: { codex: { ...stored } } };
    const saved = applyCodingAgentConfigUpdate(config, payload);
    const running = new LocalRuntimeDaemon({
      wsUrl: "wss://example.invalid/runtime",
      token: "synthetic",
      allowedDirectories: [os.tmpdir()],
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      capabilities: { browser: { enabled: false }, codex: { enabled: true, provider: "codex" } }
    }) as any;
    running.applyCodingAgentConfiguration(saved);
    const restarted = capabilityOptionsFromConfig(JSON.parse(JSON.stringify(config))).codex;
    const provider = saved.provider as "codex" | "claude-code" | "cursor";
    assert.deepEqual(
      codingHarnessAccess(provider, running.options.capabilities.codex),
      codingHarnessAccess(provider, restarted),
      JSON.stringify({ stored, payload })
    );
  }
});

test("the default sandbox never grants Claude Code access when the harness list changes", () => {
  // [codex, claude-code] with a full-access sandbox shrinks to [claude-code].
  const shrink: LocalRuntimeConfig = {};
  applyCodingAgentConfigUpdate(shrink, {
    provider: "codex",
    providers: ["codex", "claude-code"],
    default_sandbox: "danger-full-access",
    claude_permission_mode: "default"
  });
  assert.deepEqual(accessFor(shrink).codex, fullAccess);
  assert.deepEqual(accessFor(shrink).claude, noAccess);
  const before = codingAgentConfigFromRuntimeConfig(shrink);
  const shrunk = applyCodingAgentConfigUpdate(shrink, { ...before, provider: "claude-code", providers: ["claude-code"] });
  assert.deepEqual([shrunk.allow_workspace_write, shrunk.allow_danger_full_access], [false, false]);
  assert.deepEqual(accessFor(shrink).claude, noAccess);

  // Codex alone with full access, swapped to Claude Code alone (old single-harness payload).
  const swap: LocalRuntimeConfig = {};
  applyCodingAgentConfigUpdate(swap, { provider: "codex", default_sandbox: "danger-full-access" });
  assert.deepEqual(accessFor(swap).codex, fullAccess);
  const swapped = applyCodingAgentConfigUpdate(swap, { provider: "claude-code" });
  assert.deepEqual(swapped.providers, ["claude-code"]);
  assert.deepEqual([swapped.allow_workspace_write, swapped.allow_danger_full_access], [false, false]);
  assert.deepEqual(accessFor(swap).claude, noAccess);

  // The same through the CLI.
  const cli: LocalRuntimeConfig = {};
  applyCodingFlags(cli, { provider: "codex", sandbox: "workspace-write" }, true);
  assert.deepEqual(accessFor(cli).codex, writeAccess);
  applyCodingFlags(cli, { providers: "codex,claude-code" }, true);
  applyCodingFlags(cli, { provider: "claude-code" }, true);
  assert.deepEqual(
    [cli.capabilities?.codex?.allow_workspace_write, cli.capabilities?.codex?.allow_danger_full_access],
    [false, false]
  );
  assert.deepEqual(accessFor(cli).claude, noAccess);
});

test("derived coding grants follow the table shared with the desktop host", () => {
  assert.ok(grantCases.length >= 10);
  for (const testCase of grantCases) {
    assert.deepEqual(
      derivedCodingAgentGrants(testCase),
      { allow_workspace_write: testCase.allow_workspace_write, allow_danger_full_access: testCase.allow_danger_full_access },
      testCase.name
    );
  }
});

test("with several harnesses each one gets access only from its own setting", () => {
  const both: LocalRuntimeConfig = {};
  updateCodingAgentRuntimeConfig(both, {
    provider: "codex",
    providers: ["codex", "claude-code", "cursor"],
    default_sandbox: "danger-full-access",
    claude_permission_mode: "bypassPermissions"
  });
  assert.deepEqual(accessFor(both), { codex: fullAccess, cursor: fullAccess, claude: fullAccess });

  const claudeOnlyWrites: LocalRuntimeConfig = {};
  updateCodingAgentRuntimeConfig(claudeOnlyWrites, {
    provider: "claude-code",
    providers: ["claude-code", "codex"],
    default_sandbox: "read-only",
    claude_permission_mode: "acceptEdits",
    allow_workspace_write: true,
    allow_danger_full_access: true
  });
  assert.deepEqual(accessFor(claudeOnlyWrites).codex, noAccess, "shared grants widen nobody");
  assert.deepEqual(accessFor(claudeOnlyWrites).claude, writeAccess);

  const codexOnlyWrites: LocalRuntimeConfig = {};
  updateCodingAgentRuntimeConfig(codexOnlyWrites, {
    provider: "claude-code",
    providers: ["claude-code", "codex"],
    default_sandbox: "danger-full-access",
    claude_permission_mode: "default"
  });
  assert.deepEqual(accessFor(codexOnlyWrites).codex, fullAccess);
  assert.deepEqual(accessFor(codexOnlyWrites).claude, noAccess);
});

test("single-harness access matches the previous formula except that the sandbox never grants Claude Code", () => {
  const legacy = (codex: NonNullable<NonNullable<LocalRuntimeConfig["capabilities"]>["codex"]>) => {
    // The previous formula, with the sandbox term limited to sandbox harnesses.
    const sandbox = codex.provider === "claude-code" ? undefined : codex.default_sandbox;
    return {
      allowWorkspaceWrite:
        codex.allow_workspace_write === true ||
        (codex.provider === "claude-code" && codex.claude_permission_mode === "acceptEdits") ||
        sandbox === "workspace-write" ||
        sandbox === "danger-full-access",
      allowDangerFullAccess: codex.allow_danger_full_access === true || sandbox === "danger-full-access"
    };
  };
  const cases = [
    { provider: "codex", default_sandbox: "read-only" },
    { provider: "codex", default_sandbox: "read-only", allow_workspace_write: true },
    { provider: "codex", default_sandbox: "workspace-write", claude_permission_mode: "bypassPermissions" },
    { provider: "cursor", default_sandbox: "danger-full-access" },
    { provider: "claude-code", claude_permission_mode: "acceptEdits", default_sandbox: "read-only" },
    { provider: "claude-code", claude_permission_mode: "bypassPermissions", allow_danger_full_access: true },
    { provider: "claude-code", claude_permission_mode: "default", default_sandbox: "danger-full-access" },
    { provider: "claude-code", claude_permission_mode: "default", default_sandbox: "workspace-write" },
    // An explicit stored grant still applies to a single harness, as before.
    { provider: "claude-code", default_sandbox: "danger-full-access", allow_danger_full_access: true }
  ] as const;
  for (const codex of cases) {
    const options = capabilityOptionsFromConfig({ capabilities: { codex: { ...codex } } }).codex;
    assert.deepEqual(codingHarnessAccess(codex.provider, options), legacy(codex), JSON.stringify(codex));
  }
  // A Claude-only config with a leftover sandbox and no stored grant gets nothing at startup.
  for (const sandbox of ["workspace-write", "danger-full-access"] as const) {
    const options = capabilityOptionsFromConfig({
      capabilities: { codex: { provider: "claude-code", providers: ["claude-code"], default_sandbox: sandbox } }
    }).codex;
    assert.deepEqual(codingHarnessAccess("claude-code", options), noAccess, sandbox);
  }
  // Embedders without coding options keep the approval prompt instead of a hard deny.
  assert.deepEqual(codingHarnessAccess("codex", undefined), { allowWorkspaceWrite: undefined, allowDangerFullAccess: undefined });
  assert.deepEqual(codingHarnessAccess("claude-code", { provider: "claude-code" }), {
    allowWorkspaceWrite: undefined,
    allowDangerFullAccess: undefined
  });
});

test("CLI single-harness flag replaces the enabled list; --providers enables several", () => {
  const fresh: LocalRuntimeConfig = {};
  applyCodingFlags(fresh, { "coding-provider": "claude-code", "claude-permission-mode": "acceptEdits" }, true);
  assert.equal(fresh.capabilities?.codex?.provider, "claude-code");
  assert.deepEqual(fresh.capabilities?.codex?.providers, ["claude-code"]);
  assert.equal(fresh.capabilities?.codex?.enabled, true);

  const multi: LocalRuntimeConfig = {};
  applyCodingFlags(multi, { providers: ["codex,claude-code", "cursor"], provider: "cursor" }, true);
  assert.equal(multi.capabilities?.codex?.provider, "cursor");
  assert.deepEqual(multi.capabilities?.codex?.providers, ["codex", "claude-code", "cursor"]);
  applyCodingFlags(multi, { "coding-providers": "claude-code,codex" }, true);
  assert.equal(multi.capabilities?.codex?.provider, "claude-code");
  assert.deepEqual(multi.capabilities?.codex?.providers, ["claude-code", "codex"]);
  applyCodingFlags(multi, { provider: "codex", model: "gpt-test" }, true);
  assert.deepEqual(multi.capabilities?.codex?.providers, ["codex"]);
  assert.equal(multi.capabilities?.codex?.model, "gpt-test");

  assert.throws(() => applyCodingFlags({}, { providers: true }, true), /--providers needs a comma-separated list/);
  assert.throws(() => applyCodingFlags({}, { "coding-providers": "codex,gpt" }, true), /--coding-providers needs/);
  assert.throws(() => applyCodingFlags({}, { providers: "codex", provider: "cursor" }, true), /must be one of the harnesses listed/);
});

test("CLI harness changes recompute grants, explicit grant flags still apply", () => {
  const config: LocalRuntimeConfig = {
    capabilities: {
      codex: {
        provider: "codex",
        providers: ["codex", "claude-code"],
        default_sandbox: "read-only",
        claude_permission_mode: "bypassPermissions",
        allow_workspace_write: true,
        allow_danger_full_access: true
      }
    }
  };
  applyCodingFlags(config, { provider: "codex" }, true);
  assert.deepEqual(config.capabilities?.codex?.providers, ["codex"]);
  assert.equal(config.capabilities?.codex?.allow_workspace_write, false);
  assert.equal(config.capabilities?.codex?.allow_danger_full_access, false);

  applyCodingFlags(config, { "allow-workspace-write": true }, true);
  assert.equal(config.capabilities?.codex?.allow_workspace_write, true);
  // Same harness list: the explicit grant is kept.
  applyCodingFlags(config, { provider: "codex", sandbox: "read-only" }, true);
  assert.equal(config.capabilities?.codex?.allow_workspace_write, true);
});
