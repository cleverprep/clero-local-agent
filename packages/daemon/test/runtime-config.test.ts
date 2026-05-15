import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  capabilitiesFromConfig,
  capabilityOptionsFromConfig,
  defaultRuntimeConfig,
  saveRuntimeConfig,
  loadRuntimeConfig
} from "../src/runtime-config.ts";

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
    claudeCommand: "",
    claudeModel: "",
    claudeReasoningEffort: undefined,
    claudePermissionMode: "default",
    defaultSandbox: "workspace-write",
    allowWorkspaceWrite: true,
    allowDangerFullAccess: false
  });
});

test("maps custom Claude model selection to daemon options", () => {
  const config = defaultRuntimeConfig();
  config.capabilities!.codex!.provider = "claude-code";
  config.capabilities!.codex!.claude_model = "custom";
  config.capabilities!.codex!.claude_model_custom = "claude-sonnet-4-5";

  assert.equal(capabilityOptionsFromConfig(config).codex?.claudeModel, "claude-sonnet-4-5");
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
