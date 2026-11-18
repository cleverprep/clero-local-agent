import assert from "node:assert/strict";
import test from "node:test";
import {
  derivedCodingGrants,
  effectiveCodingAccess,
  mergeFreshCodingConfig,
  normalizeCodingProviders,
  otherHarnessAccess,
  reconcileCodingAccess,
  selectSingleCodingProvider,
  fullAccessDefaultHint,
  gitWriteOnlyNote,
  mergeCodingConfigFromDisk,
  setFullLocalAccess,
  setWriteAccess,
  sharedSandboxHarnesses,
  syncGrantsWithSettings,
  type CodingAccessSettings,
  type CodingProvider
} from "../coding-config.ts";
// What the daemon enforces, so the UI's displayed access cannot drift from it.
import { codingHarnessAccess } from "../../../packages/daemon/src/daemon.ts";
import { capabilityOptionsFromConfig, type LocalRuntimeConfig } from "../../../packages/daemon/src/runtime-config.ts";
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

const HARNESSES: CodingProvider[] = ["codex", "claude-code", "antigravity", "cursor"];

function daemonAccess(codex: CodingAccessSettings, harness: CodingProvider) {
  // The desktop settings type uses plain strings for the sandbox and mode.
  const stored = structuredClone(codex) as NonNullable<NonNullable<LocalRuntimeConfig["capabilities"]>["codex"]>;
  const enforced = codingHarnessAccess(harness, capabilityOptionsFromConfig({ capabilities: { codex: stored } }).codex);
  return { write: enforced.allowWorkspaceWrite === true, full: enforced.allowDangerFullAccess === true };
}

function assertMatchesDaemon(codex: CodingAccessSettings, label: string): void {
  for (const harness of HARNESSES) {
    assert.deepEqual(effectiveCodingAccess(codex, harness), daemonAccess(codex, harness), `${label} / ${harness}`);
  }
}

const extraAccessCases: Array<Partial<CodingAccessSettings> & { name: string }> = [
  { name: "codex+claude, claude bypass, read-only sandbox", providers: ["codex", "claude-code"], claude_permission_mode: "bypassPermissions" },
  { name: "codex+claude, full sandbox, claude default", providers: ["codex", "claude-code"], default_sandbox: "danger-full-access" },
  { name: "codex+cursor+claude, write sandbox, claude acceptEdits", providers: ["codex", "cursor", "claude-code"], default_sandbox: "workspace-write", claude_permission_mode: "acceptEdits" },
  { name: "cursor+antigravity, full sandbox", provider: "cursor", providers: ["cursor", "antigravity"], default_sandbox: "danger-full-access" },
  { name: "claude alone, bypass mode, no stored grant", provider: "claude-code", providers: ["claude-code"], claude_permission_mode: "bypassPermissions" },
  { name: "legacy codex alone, read-only sandbox, stored full grant", allow_workspace_write: true, allow_danger_full_access: true },
  { name: "legacy claude alone, stored write grant", provider: "claude-code", providers: ["claude-code"], allow_workspace_write: true }
];

test("the displayed access is exactly what the daemon enforces", () => {
  const storedGrants = [
    { allow_workspace_write: false, allow_danger_full_access: false },
    { allow_workspace_write: true, allow_danger_full_access: false },
    { allow_workspace_write: false, allow_danger_full_access: true },
    { allow_workspace_write: true, allow_danger_full_access: true }
  ];
  for (const testCase of [...grantCases, ...extraAccessCases]) {
    for (const grants of storedGrants) {
      const codex = coding({ ...(testCase as Partial<CodingAccessSettings>), ...grants });
      assertMatchesDaemon(codex, `${testCase.name} ${JSON.stringify(grants)}`);
    }
  }
});

/** What the app does on save: the reconcile against the list the config was loaded with. */
function save(codex: CodingAccessSettings, loadedProviders: readonly string[] | null): CodingAccessSettings {
  const saved = structuredClone(codex);
  reconcileCodingAccess(saved, loadedProviders);
  return saved;
}

test("reviewer case (a): with Codex and Claude enabled, checking full access really grants it to the shown harness", () => {
  const loaded = ["codex", "claude-code"];
  const codex = coding({ providers: ["codex", "claude-code"] });
  assert.equal(effectiveCodingAccess(codex, "codex").full, false);
  setFullLocalAccess(codex, true, loaded);
  assert.equal(codex.default_sandbox, "danger-full-access");
  assert.equal(codex.claude_permission_mode, "default", "Claude is not widened");
  assert.deepEqual(daemonAccess(save(codex, loaded), "codex"), { write: true, full: true });
  assert.deepEqual(daemonAccess(save(codex, loaded), "claude-code"), { write: false, full: false });
  assert.deepEqual(derivedCodingGrants(codex), {
    allow_workspace_write: codex.allow_workspace_write,
    allow_danger_full_access: codex.allow_danger_full_access
  });

  const claude = coding({ provider: "claude-code", providers: ["codex", "claude-code"] });
  setFullLocalAccess(claude, true, loaded);
  assert.equal(claude.claude_permission_mode, "bypassPermissions");
  assert.equal(claude.default_sandbox, "read-only", "Codex is not widened");
  assert.deepEqual(daemonAccess(claude, "claude-code"), { write: true, full: true });
  assert.deepEqual(daemonAccess(claude, "codex"), { write: false, full: false });
});

test("reviewer case (b): unchecking full access on Claude really removes it and leaves write access", () => {
  const loaded = ["codex", "claude-code"];
  const multi = coding({
    provider: "claude-code",
    providers: ["codex", "claude-code"],
    claude_permission_mode: "bypassPermissions",
    allow_danger_full_access: true
  });
  assert.equal(effectiveCodingAccess(multi, "claude-code").full, true);
  setFullLocalAccess(multi, false, loaded);
  assert.equal(multi.claude_permission_mode, "acceptEdits");
  assert.equal(multi.allow_danger_full_access, false);
  assert.deepEqual(daemonAccess(save(multi, loaded), "claude-code"), { write: true, full: false });
  assert.equal(effectiveCodingAccess(multi, "claude-code").write, true, "the write box stays on");
  setWriteAccess(multi, false, loaded);
  assert.equal(multi.claude_permission_mode, "default");
  assert.deepEqual(daemonAccess(save(multi, loaded), "claude-code"), { write: false, full: false });

  // Claude alone: the stored grant goes and the mode no longer asks for bypass.
  const alone = coding({
    provider: "claude-code",
    providers: ["claude-code"],
    claude_permission_mode: "bypassPermissions",
    allow_workspace_write: true,
    allow_danger_full_access: true
  });
  setFullLocalAccess(alone, false, ["claude-code"]);
  assert.equal(alone.claude_permission_mode, "acceptEdits");
  assert.equal(alone.allow_danger_full_access, false);
  assert.deepEqual(daemonAccess(save(alone, ["claude-code"]), "claude-code"), { write: true, full: false });
  assert.equal(derivedCodingGrants(alone).allow_danger_full_access, false, "a later list change re-derives nothing wider");
});

test("checking then unchecking full access lands on write access, visibly", () => {
  const loaded = ["codex", "claude-code", "cursor"];
  const config = coding({ providers: ["codex", "claude-code", "cursor"] });
  setFullLocalAccess(config, true, loaded);
  setFullLocalAccess(config, false, loaded);
  assert.equal(config.default_sandbox, "workspace-write");
  assert.deepEqual(effectiveCodingAccess(config, "codex"), { write: true, full: false }, "the write box shows on");
  assert.deepEqual(daemonAccess(save(config, loaded), "cursor"), { write: true, full: false });
  setWriteAccess(config, false, loaded);
  assert.equal(config.default_sandbox, "read-only");
  assert.deepEqual(daemonAccess(save(config, loaded), "codex"), { write: false, full: false });

  // One harness, unchanged list: the same visible result.
  const single = coding({});
  setFullLocalAccess(single, true, ["codex"]);
  setFullLocalAccess(single, false, ["codex"]);
  assert.deepEqual(effectiveCodingAccess(single, "codex"), { write: true, full: false });
  assert.deepEqual(daemonAccess(save(single, ["codex"]), "codex"), { write: true, full: false });
});

test("after picking another harness in the dropdown, full access survives the save", () => {
  for (const picked of ["cursor", "claude-code", "antigravity"] as const) {
    const loaded = ["codex"];
    const config = coding({});
    selectSingleCodingProvider(config, picked);
    setFullLocalAccess(config, true, loaded);
    // Claude Code alone: bypassPermissions grants full access, not the shared write grant (shared rule).
    const expected = { write: picked !== "claude-code", full: true };
    assert.deepEqual(effectiveCodingAccess(config, picked), expected, `${picked} shown`);
    const saved = save(config, loaded);
    assert.deepEqual(saved, config, `${picked}: the save reconcile keeps it`);
    assert.deepEqual(daemonAccess(saved, picked), expected, `${picked} enforced`);
    assert.equal(
      picked === "claude-code" ? saved.claude_permission_mode : saved.default_sandbox,
      picked === "claude-code" ? "bypassPermissions" : "danger-full-access"
    );
    assert.match(fullAccessDefaultHint(config, loaded), /the default for every/);

    const write = coding({});
    selectSingleCodingProvider(write, picked);
    setWriteAccess(write, true, loaded);
    assert.deepEqual(daemonAccess(save(write, loaded), picked), { write: true, full: false }, `${picked} write`);
  }
});

test("a harness list changed on disk under unsaved edits does not move a grant to another harness", () => {
  // Disk: Codex + Claude. The user checks full access with Codex shown ...
  const loaded = coding({ providers: ["codex", "claude-code"] });
  const current = structuredClone(loaded);
  setFullLocalAccess(current, true, loaded.providers);
  // ... and before the save Clero changes the file to Claude only.
  const fresh = coding({ provider: "claude-code", providers: ["claude-code"] });
  const merged = mergeCodingConfigFromDisk(loaded, current, fresh);
  assert.equal(merged.listChanged, true);
  assert.deepEqual(merged.config.providers, ["claude-code"]);
  const saved = save(merged.config, merged.listChanged ? null : fresh.providers);
  assert.equal(saved.claude_permission_mode, "default", "no upgrade to acceptEdits");
  assert.deepEqual([saved.allow_workspace_write, saved.allow_danger_full_access], [false, false]);
  assert.deepEqual(daemonAccess(saved, "claude-code"), { write: false, full: false });

  // No edits: the file is taken as is, with its list treated as unchanged.
  const untouched = mergeCodingConfigFromDisk(loaded, structuredClone(loaded), fresh);
  assert.equal(untouched.listChanged, false);
  assert.deepEqual(untouched.config, fresh);

  // Same list on disk: the user's edits and grants are kept.
  const sameList = mergeCodingConfigFromDisk(loaded, current, { ...structuredClone(loaded), model: "x" } as CodingAccessSettings);
  assert.equal(sameList.listChanged, false);
  assert.equal(sameList.config.default_sandbox, "danger-full-access");
  assert.equal(sameList.config.allow_danger_full_access, true);
});

test("the write control says when it is on only for git writes", () => {
  const readOnly = coding({ providers: ["codex", "claude-code"] });
  assert.equal(gitWriteOnlyNote(readOnly, true), "Git writes are on. Codex itself is read-only.");
  assert.equal(gitWriteOnlyNote(readOnly, false), "");
  assert.equal(gitWriteOnlyNote(coding({ providers: ["codex", "claude-code"], default_sandbox: "workspace-write" }), true), "");
  assert.equal(
    gitWriteOnlyNote(coding({ provider: "claude-code", providers: ["claude-code", "codex"], default_sandbox: "workspace-write" }), true),
    "Git writes are on. Claude Code itself is read-only."
  );
  assert.equal(gitWriteOnlyNote(coding({ allow_workspace_write: true }), true), "", "a stored single-harness grant counts");
});

test("the full-access hint appears only when checking sets the harness's default", () => {
  assert.equal(fullAccessDefaultHint(coding({}), ["codex"]), "");
  assert.equal(
    fullAccessDefaultHint(coding({ providers: ["codex", "cursor", "claude-code"] }), ["codex", "cursor", "claude-code"]),
    "Checking this makes full access the default for every Codex and Cursor task (they share one sandbox setting), not only tasks that ask for it."
  );
  assert.equal(
    fullAccessDefaultHint(coding({ providers: ["codex", "claude-code"] }), ["codex", "claude-code"]),
    "Checking this makes full access the default for every Codex task, not only tasks that ask for it."
  );
  assert.equal(
    fullAccessDefaultHint(coding({ provider: "claude-code", providers: ["codex", "claude-code"] }), ["codex", "claude-code"]),
    "Checking this makes bypassPermissions the default for every Claude Code task, not only tasks that ask for full access."
  );
});

test("each harness family: the full-access control changes that harness's own setting", () => {
  for (const viewed of ["codex", "cursor", "antigravity"] as const) {
    const loaded = [viewed, "claude-code"];
    const config = coding({ provider: viewed, providers: [viewed, "claude-code"], default_sandbox: "workspace-write" });
    setFullLocalAccess(config, true, loaded);
    assert.equal(config.default_sandbox, "danger-full-access", viewed);
    assert.deepEqual(daemonAccess(config, viewed), { write: true, full: true });
    setFullLocalAccess(config, false, loaded);
    assert.equal(config.default_sandbox, "workspace-write", viewed);
    assert.deepEqual(daemonAccess(config, viewed), { write: true, full: false });
    setWriteAccess(config, false, loaded);
    assert.equal(config.default_sandbox, "read-only", viewed);
    assert.deepEqual(daemonAccess(config, viewed), { write: false, full: false });
    setWriteAccess(config, true, loaded);
    assert.equal(config.default_sandbox, "workspace-write", viewed);
    assert.equal(config.claude_permission_mode, "default", "Claude untouched");
  }

  const loaded = ["claude-code", "codex"];
  const claude = coding({ provider: "claude-code", providers: ["claude-code", "codex"], default_sandbox: "danger-full-access" });
  setWriteAccess(claude, true, loaded);
  assert.equal(claude.claude_permission_mode, "acceptEdits");
  setFullLocalAccess(claude, true, loaded);
  assert.equal(claude.claude_permission_mode, "bypassPermissions");
  setWriteAccess(claude, false, loaded);
  assert.equal(claude.claude_permission_mode, "default");
  assert.equal(claude.default_sandbox, "danger-full-access", "the enabled Codex keeps its own sandbox");
  assert.deepEqual(daemonAccess(claude, "claude-code"), { write: false, full: false });
  assert.deepEqual(daemonAccess(claude, "codex"), { write: true, full: true });
  assert.deepEqual(otherHarnessAccess(claude), [{ provider: "codex", write: true, full: true }]);

  // Raising write never lowers full access.
  const full = coding({ providers: ["codex", "claude-code"], default_sandbox: "danger-full-access" });
  setWriteAccess(full, true, ["codex", "claude-code"]);
  assert.equal(full.default_sandbox, "danger-full-access");
});

test("Codex, Cursor and Antigravity share the sandbox setting, and the UI says so", () => {
  const loaded = ["codex", "cursor", "claude-code"];
  const config = coding({ providers: ["codex", "cursor", "claude-code"], claude_permission_mode: "bypassPermissions" });
  assert.deepEqual(sharedSandboxHarnesses(config), ["codex", "cursor"]);
  assert.deepEqual(otherHarnessAccess(config), [{ provider: "claude-code", write: true, full: true }]);
  setFullLocalAccess(config, true, loaded);
  assert.deepEqual(daemonAccess(config, "cursor"), { write: true, full: true }, "the shared sandbox applies to Cursor too");
  setWriteAccess(config, false, loaded);
  assert.deepEqual(daemonAccess(config, "cursor"), { write: false, full: false });
  assert.equal(config.claude_permission_mode, "bypassPermissions", "Claude is governed by its own mode");
  assert.equal(effectiveCodingAccess(config, "claude-code").full, true);

  assert.deepEqual(sharedSandboxHarnesses(coding({ providers: ["codex", "claude-code"] })), []);
  assert.deepEqual(sharedSandboxHarnesses(coding({ provider: "claude-code", providers: ["codex", "cursor", "claude-code"] })), []);
  assert.deepEqual(otherHarnessAccess(coding({})), []);
});

test("a single harness keeps the previous checkbox behaviour, and unchecking removes a legacy stored grant", () => {
  const loaded = ["codex"];
  // Legacy: a stored full grant with a read-only sandbox shows as checked ...
  const legacy = coding({ allow_workspace_write: true, allow_danger_full_access: true });
  assert.equal(effectiveCodingAccess(legacy, "codex").full, true);
  // ... and unchecking really removes it, leaving write access.
  setFullLocalAccess(legacy, false, loaded);
  assert.equal(legacy.allow_danger_full_access, false);
  assert.equal(legacy.allow_workspace_write, true);
  assert.deepEqual(daemonAccess(save(legacy, loaded), "codex"), { write: true, full: false });

  // Checking stores the grant as before; the default sandbox is not changed by the control
  // (the save reconcile then upgrades read-only to workspace-write, as before).
  const fromReadOnly = coding({});
  setFullLocalAccess(fromReadOnly, true, loaded);
  assert.deepEqual(fromReadOnly, coding({ allow_workspace_write: true, allow_danger_full_access: true }));
  assert.equal(save(fromReadOnly, loaded).default_sandbox, "workspace-write");
  assert.deepEqual(daemonAccess(save(fromReadOnly, loaded), "codex"), { write: true, full: true });
  assert.equal(fullAccessDefaultHint(fromReadOnly, loaded), "", "a permission, not a default");
  const codex = coding({ default_sandbox: "workspace-write", allow_workspace_write: true });
  setFullLocalAccess(codex, true, loaded);
  assert.deepEqual(codex, coding({ default_sandbox: "workspace-write", allow_workspace_write: true, allow_danger_full_access: true }));
  // Unchecking a full-access sandbox steps it down as before.
  const sandboxFull = coding({ default_sandbox: "danger-full-access", allow_workspace_write: true, allow_danger_full_access: true });
  setFullLocalAccess(sandboxFull, false, loaded);
  assert.equal(sandboxFull.default_sandbox, "workspace-write");
  assert.deepEqual(daemonAccess(sandboxFull, "codex"), { write: true, full: false });

  // The write control gives the same config as before.
  const write = coding({});
  setWriteAccess(write, true, loaded);
  assert.deepEqual(write, coding({ default_sandbox: "workspace-write", allow_workspace_write: true }));
  setWriteAccess(write, false, loaded);
  assert.deepEqual(write, coding({}));
  const claude = coding({ provider: "claude-code", providers: ["claude-code"] });
  setWriteAccess(claude, true, ["claude-code"]);
  assert.deepEqual(claude, coding({ provider: "claude-code", providers: ["claude-code"], claude_permission_mode: "acceptEdits", allow_workspace_write: true }));
  setWriteAccess(claude, false, ["claude-code"]);
  assert.deepEqual(claude, coding({ provider: "claude-code", providers: ["claude-code"] }));

  // With one harness and an unchanged list, setting changes leave stored grants alone ...
  const select = coding({ allow_danger_full_access: true });
  select.default_sandbox = "workspace-write";
  syncGrantsWithSettings(select, loaded);
  assert.equal(select.allow_danger_full_access, true);
  // ... and follow the settings once the list changed.
  syncGrantsWithSettings(select, ["cursor"]);
  assert.deepEqual([select.allow_workspace_write, select.allow_danger_full_access], [true, false]);
});

test("what the controls write survives the save-time reconcile unchanged", () => {
  const cases: Array<{ written: CodingAccessSettings; loaded: string[] }> = [];
  const a = coding({ providers: ["codex", "claude-code"] });
  setFullLocalAccess(a, true, a.providers);
  cases.push({ written: a, loaded: ["codex", "claude-code"] });
  const b = coding({ provider: "claude-code", providers: ["codex", "claude-code"], claude_permission_mode: "bypassPermissions" });
  setFullLocalAccess(b, false, b.providers);
  cases.push({ written: b, loaded: ["codex", "claude-code"] });
  const legacy = coding({ allow_workspace_write: true, allow_danger_full_access: true, default_sandbox: "workspace-write" });
  setFullLocalAccess(legacy, false, ["codex"]);
  cases.push({ written: legacy, loaded: ["codex"] });
  const picked = coding({});
  selectSingleCodingProvider(picked, "cursor");
  setFullLocalAccess(picked, true, ["codex"]);
  cases.push({ written: picked, loaded: ["codex"] });
  for (const { written, loaded } of cases) {
    assert.deepEqual(save(written, loaded), written, JSON.stringify(written));
  }
});
