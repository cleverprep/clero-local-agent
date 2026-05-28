import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  capabilitiesFromConfig,
  capabilityOptionsFromConfig,
  defaultRuntimeConfig,
  mergeRuntimeConfig,
  resolveDeviceToken,
  saveRuntimeConfig,
  loadRuntimeConfig
} from "../src/runtime-config.ts";
import type { TokenStore } from "../src/token-store.ts";

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
  config.capabilities!.codex!.enabled = false;
  config.capabilities!.git!.write_enabled = false;

  const names = capabilitiesFromConfig(config).map((capability) => capability.name);

  assert.equal(names.some((name) => name.startsWith("browser.")), false);
  assert.equal(names.some((name) => name.startsWith("coding_agent.")), false);
  assert.equal(names.includes("git.status"), true);
  assert.equal(names.includes("git.commit"), false);
  assert.equal(names.includes("workspace.list_projects"), true);
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
    command: "",
    model: "",
    reasoningEffort: undefined,
    antigravityCommand: "",
    claudeCommand: "",
    claudeModel: "",
    claudeReasoningEffort: undefined,
    claudePermissionMode: "default",
    defaultSandbox: "workspace-write",
    allowWorkspaceWrite: true,
    allowDangerFullAccess: false
  });
});

test("enables managed browser session persistence by default", () => {
  const config = defaultRuntimeConfig();

  assert.equal(config.capabilities?.browser?.remember_session, true);
  assert.match(config.capabilities?.browser?.browser_profile_dir ?? "", /\.clero-local-agent/);
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

  await saveRuntimeConfig(configPath, config);
  const raw = await readFile(configPath, "utf8");
  const loaded = await loadRuntimeConfig(configPath);

  assert.match(raw, /Test Device/);
  assert.equal(loaded.device_name, "Test Device");
  assert.deepEqual(loaded.allowed_directories, [directory]);
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
