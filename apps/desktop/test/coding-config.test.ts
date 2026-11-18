import assert from "node:assert/strict";
import test from "node:test";
import {
  derivedCodingGrants,
  mergeFreshCodingConfig,
  normalizeCodingProviders,
  reconcileCodingAccess,
  selectSingleCodingProvider,
  type CodingAccessSettings
} from "../coding-config.ts";
// Shared with packages/coding-agents (derivedCodingAgentGrants) and the Rust side.
import grantCases from "../../../packages/daemon/test/fixtures/coding-grant-cases.json" with { type: "json" };

function coding(overrides: Partial<CodingAccessSettings>): CodingAccessSettings {
  return {
    provider: "codex",
    providers: ["codex"],
    default_sandbox: "read-only",
    claude_permission_mode: "default",
    allow_workspace_write: false,
    allow_danger_full_access: false,
    ...overrides
  };
}

test("desktop harness normalization matches the connector contract", () => {
  assert.deepEqual(normalizeCodingProviders({ provider: "claude-code", providers: undefined }), {
    provider: "claude-code",
    providers: ["claude-code"]
  });
  assert.deepEqual(normalizeCodingProviders({ provider: "cursor", providers: ["codex", "bogus", "codex"] }), {
    provider: "cursor",
    providers: ["codex", "cursor"]
  });
  assert.deepEqual(normalizeCodingProviders({ provider: "bogus", providers: ["claude-code", "codex"] }), {
    provider: "claude-code",
    providers: ["claude-code", "codex"]
  });
});

test("desktop derived grants follow the shared table", () => {
  for (const testCase of grantCases) {
    assert.deepEqual(
      derivedCodingGrants(coding(testCase as Partial<CodingAccessSettings>)),
      { allow_workspace_write: testCase.allow_workspace_write, allow_danger_full_access: testCase.allow_danger_full_access },
      testCase.name
    );
  }
});

test("picking one harness in the dropdown never widens it from another harness's grant", () => {
  // Codex and Claude enabled; the stored write grant exists only because of Claude acceptEdits.
  const loaded = coding({
    providers: ["codex", "claude-code"],
    claude_permission_mode: "acceptEdits",
    allow_workspace_write: true
  });
  for (const provider of ["cursor", "codex", "antigravity"] as const) {
    const codex = structuredClone(loaded);
    selectSingleCodingProvider(codex, provider);
    reconcileCodingAccess(codex, loaded.providers);
    assert.deepEqual(codex.providers, [provider]);
    assert.equal(codex.default_sandbox, "read-only", provider);
    assert.equal(codex.allow_workspace_write, false, provider);
    assert.equal(codex.allow_danger_full_access, false, provider);
  }

  // Codex's workspace-write sandbox must not switch Claude to acceptEdits.
  const codexWrites = coding({ providers: ["codex", "claude-code"], default_sandbox: "workspace-write", allow_workspace_write: true });
  const claude = structuredClone(codexWrites);
  selectSingleCodingProvider(claude, "claude-code");
  reconcileCodingAccess(claude, codexWrites.providers);
  assert.equal(claude.claude_permission_mode, "default");

  // Switching to Claude Code while its own mode is bypassPermissions yields that grant (its own setting).
  const bypass = coding({ claude_permission_mode: "bypassPermissions" });
  selectSingleCodingProvider(bypass, "claude-code");
  reconcileCodingAccess(bypass, ["codex"]);
  assert.equal(bypass.allow_danger_full_access, true);
});

test("the default sandbox never grants Claude Code access", () => {
  // Codex alone with full access, swapped to Claude Code alone in the Agent picker.
  const swap = coding({ default_sandbox: "danger-full-access", allow_workspace_write: true, allow_danger_full_access: true });
  selectSingleCodingProvider(swap, "claude-code");
  reconcileCodingAccess(swap, ["codex"]);
  assert.deepEqual([swap.allow_workspace_write, swap.allow_danger_full_access], [false, false]);
  assert.equal(swap.claude_permission_mode, "default");

  // [codex, claude-code] with a full-access sandbox shrunk to [claude-code] on disk-compare.
  const shrink = coding({
    provider: "claude-code",
    providers: ["claude-code"],
    default_sandbox: "danger-full-access",
    allow_workspace_write: true,
    allow_danger_full_access: true
  });
  reconcileCodingAccess(shrink, ["codex", "claude-code"]);
  assert.deepEqual([shrink.allow_workspace_write, shrink.allow_danger_full_access], [false, false]);
});

test("the reconcile only upgrades a single harness whose list is unchanged", () => {
  const unchanged = coding({ allow_workspace_write: true });
  reconcileCodingAccess(unchanged, ["codex"]);
  assert.equal(unchanged.default_sandbox, "workspace-write", "previous single-harness behaviour");

  const unknown = coding({ allow_workspace_write: true });
  reconcileCodingAccess(unknown, null);
  assert.equal(unknown.default_sandbox, "read-only");
  assert.equal(unknown.allow_workspace_write, false);

  const several = coding({
    providers: ["codex", "claude-code"],
    claude_permission_mode: "acceptEdits",
    allow_workspace_write: true
  });
  reconcileCodingAccess(several, ["codex", "claude-code"]);
  assert.equal(several.default_sandbox, "read-only");
  assert.equal(several.claude_permission_mode, "acceptEdits");

  const claude = coding({ provider: "claude-code", providers: ["claude-code"], allow_workspace_write: true });
  reconcileCodingAccess(claude, ["claude-code"]);
  assert.equal(claude.claude_permission_mode, "acceptEdits", "previous single-harness behaviour");
});

test("saving takes coding changes made on disk unless the user edited the same field", () => {
  const loaded = { provider: "codex", providers: ["codex"], model: "", default_sandbox: "read-only" };
  const fresh = { provider: "codex", providers: ["codex", "claude-code"], model: "", default_sandbox: "read-only" };

  assert.deepEqual(mergeFreshCodingConfig(loaded, structuredClone(loaded), fresh), fresh, "untouched: the file wins");

  const edited = { ...structuredClone(loaded), model: "gpt-test" };
  assert.deepEqual(mergeFreshCodingConfig(loaded, edited, fresh), { ...fresh, model: "gpt-test" });

  const picked = { ...structuredClone(loaded), provider: "cursor", providers: ["cursor"] };
  assert.deepEqual(
    mergeFreshCodingConfig(loaded, picked, fresh),
    { ...fresh, provider: "cursor", providers: ["cursor"] },
    "the user's own harness choice wins"
  );
});
