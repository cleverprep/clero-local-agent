// Coding-harness rules for the desktop settings screen. Kept free of Vue so
// they can be unit tested; app.vue applies them to its reactive config. They
// mirror the connector (packages/coding-agents normalizeCodingAgentProviders /
// derivedCodingAgentGrants) and the Rust side (apps/desktop/src-tauri/src/lib.rs).

export type CodingProvider = "codex" | "claude-code" | "antigravity" | "cursor";

export const CODING_PROVIDERS: readonly CodingProvider[] = ["codex", "claude-code", "antigravity", "cursor"];

export type CodingAccessSettings = {
  provider: CodingProvider;
  providers: CodingProvider[];
  default_sandbox: string;
  claude_permission_mode: string;
  allow_workspace_write: boolean;
  allow_danger_full_access: boolean;
};

function isCodingProvider(value: unknown): value is CodingProvider {
  return typeof value === "string" && (CODING_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Known harnesses only, de-duplicated in order; a missing or empty list means
 * only the default; a valid default missing from the list is appended; an
 * invalid default falls back to the first enabled harness.
 */
export function normalizeCodingProviders(codex: { provider: unknown; providers: unknown }): {
  provider: CodingProvider;
  providers: CodingProvider[];
} {
  const enabled: CodingProvider[] = [];
  for (const value of Array.isArray(codex.providers) ? codex.providers : []) {
    if (isCodingProvider(value) && !enabled.includes(value)) {
      enabled.push(value);
    }
  }
  if (enabled.length === 0) {
    const fallback = isCodingProvider(codex.provider) ? codex.provider : "codex";
    return { provider: fallback, providers: [fallback] };
  }
  if (!isCodingProvider(codex.provider)) {
    return { provider: enabled[0]!, providers: enabled };
  }
  if (!enabled.includes(codex.provider)) {
    enabled.push(codex.provider);
  }
  return { provider: codex.provider, providers: enabled };
}

/**
 * The shared grants the coding settings imply (see derivedCodingAgentGrants):
 * the default sandbox counts only while a sandbox harness (Codex, Cursor,
 * Antigravity) is enabled, the Claude Code permission mode only while Claude
 * Code is enabled. A leftover sandbox never grants Claude Code access.
 */
export function derivedCodingGrants(codex: CodingAccessSettings): {
  allow_workspace_write: boolean;
  allow_danger_full_access: boolean;
} {
  const { providers } = normalizeCodingProviders(codex);
  const sandbox = providers.some((provider) => provider !== "claude-code") ? codex.default_sandbox : undefined;
  const mode = providers.includes("claude-code") ? codex.claude_permission_mode : undefined;
  return {
    allow_workspace_write: sandbox === "workspace-write" || sandbox === "danger-full-access" || mode === "acceptEdits",
    allow_danger_full_access: sandbox === "danger-full-access" || mode === "bypassPermissions"
  };
}

/**
 * The Agent dropdown: the chosen harness becomes the only enabled one (like
 * `--provider` on the CLI) and the shared grants are recomputed from its own
 * settings, so a grant another harness implied does not carry over.
 */
export function selectSingleCodingProvider(codex: CodingAccessSettings, provider: CodingProvider): void {
  codex.provider = provider;
  codex.providers = [provider];
  Object.assign(codex, derivedCodingGrants(codex));
}

function sameList(left: readonly string[] | null, right: readonly string[]): boolean {
  return left !== null && left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Reconciles the shared grants with the coding settings before a save.
 * `loadedProviders` is the enabled list the config was loaded with (null when
 * unknown). When the list changed, or is unknown, the grants are recomputed
 * from the settings and never upgrade a sandbox or permission mode. With one
 * harness and an unchanged list the previous single-harness reconcile applies;
 * with several harnesses the shared grants change nobody's mode.
 */
export function reconcileCodingAccess(codex: CodingAccessSettings, loadedProviders: readonly string[] | null): void {
  Object.assign(codex, normalizeCodingProviders(codex));
  const listKnownUnchanged = sameList(loadedProviders, codex.providers);
  if (!listKnownUnchanged) {
    Object.assign(codex, derivedCodingGrants(codex));
  }
  if (codex.providers.length > 1) {
    return;
  }

  if (codex.provider === "claude-code") {
    if (listKnownUnchanged && codex.allow_workspace_write && codex.claude_permission_mode === "default") {
      codex.claude_permission_mode = "acceptEdits";
    }
    if (codex.claude_permission_mode === "acceptEdits") {
      codex.allow_workspace_write = true;
    }
    return;
  }

  if (listKnownUnchanged && codex.allow_workspace_write && codex.default_sandbox === "read-only") {
    codex.default_sandbox = "workspace-write";
  }
  if (codex.default_sandbox === "workspace-write") {
    codex.allow_workspace_write = true;
  }
  if (codex.default_sandbox === "danger-full-access") {
    codex.allow_workspace_write = true;
    codex.allow_danger_full_access = true;
  }
}

/**
 * Merges the coding section with the version now on disk before a save
 * (see mergeFreshCodingConfig). When the enabled list on disk is not the one
 * the user's edits were made against, grants the user's edits carried are not
 * moved to other harnesses: both grants are recomputed from the merged
 * settings, and `listChanged` tells the caller to reconcile that save as a
 * changed list (no sandbox or mode upgrade from a grant).
 */
export function mergeCodingConfigFromDisk<T extends CodingAccessSettings>(
  loaded: T,
  current: T,
  fresh: T
): { config: T; listChanged: boolean } {
  const config = mergeFreshCodingConfig(
    loaded as unknown as Record<string, unknown>,
    current as unknown as Record<string, unknown>,
    fresh as unknown as Record<string, unknown>
  ) as unknown as T;
  const edited = JSON.stringify(current) !== JSON.stringify(loaded);
  const listChanged =
    edited &&
    !sameList(normalizeCodingProviders(loaded).providers, normalizeCodingProviders(fresh).providers);
  if (listChanged) {
    Object.assign(config, derivedCodingGrants(config));
  }
  return { config, listChanged };
}

/**
 * Three-way merge of the coding section before the app writes the config:
 * fields the user changed since `loaded` keep the in-memory value, every
 * other field takes the value now on disk (`fresh`), so a change Clero or
 * the CLI made while the app was open is not overwritten with stale state.
 */
export function mergeFreshCodingConfig<T extends Record<string, unknown>>(loaded: T, current: T, fresh: T): T {
  const merged: Record<string, unknown> = { ...fresh };
  for (const key of new Set([...Object.keys(loaded), ...Object.keys(current)])) {
    if (JSON.stringify(current[key]) !== JSON.stringify(loaded[key])) {
      merged[key] = current[key];
    }
  }
  return merged as T;
}

export type HarnessAccess = { write: boolean; full: boolean };

function isSandboxHarness(provider: CodingProvider): boolean {
  return provider !== "claude-code";
}

/**
 * The access the daemon actually enforces for one harness: codingHarnessAccess
 * applied to capabilityOptionsFromConfig (packages/daemon). One enabled harness:
 * the stored shared grants plus what its settings imply (the sandbox term only
 * for a sandbox harness, the acceptEdits term only for Claude Code). Several:
 * only the harness's own setting (the sandbox for Codex/Cursor/Antigravity, the
 * permission mode for Claude Code); the shared grants widen nobody.
 */
export function effectiveCodingAccess(codex: CodingAccessSettings, harness: CodingProvider): HarnessAccess {
  const { providers } = normalizeCodingProviders(codex);
  const sandbox = codex.default_sandbox;
  const mode = codex.claude_permission_mode;
  if (providers.length > 1) {
    if (harness === "claude-code") {
      return { write: mode === "acceptEdits" || mode === "bypassPermissions", full: mode === "bypassPermissions" };
    }
    return { write: sandbox === "workspace-write" || sandbox === "danger-full-access", full: sandbox === "danger-full-access" };
  }
  const enabledSandbox = providers.some(isSandboxHarness) ? sandbox : undefined;
  return {
    write:
      codex.allow_workspace_write === true ||
      (providers.includes("claude-code") && mode === "acceptEdits") ||
      enabledSandbox === "workspace-write" ||
      enabledSandbox === "danger-full-access",
    full: codex.allow_danger_full_access === true || enabledSandbox === "danger-full-access"
  };
}

/** Which setting families a control on `viewed` may change without widening another enabled harness. */
function governedFamilies(providers: CodingProvider[], viewed: CodingProvider): { sandbox: boolean; claude: boolean } {
  return {
    sandbox: isSandboxHarness(viewed) || !providers.some(isSandboxHarness),
    claude: viewed === "claude-code" || !providers.includes("claude-code")
  };
}

/**
 * Whether the access controls may use the previous single-harness behaviour
 * (store a shared grant as a permission): only with one enabled harness whose
 * list is the one the config was loaded with. Otherwise the save-time
 * reconcile and the desktop host recompute the grants from the harness
 * settings, so the controls must write the harness's own setting instead.
 */
function storesSharedGrants(providers: CodingProvider[], loadedProviders: readonly string[] | null): boolean {
  return providers.length <= 1 && sameList(loadedProviders, providers);
}

/**
 * "Allow full local access" for the harness shown (the default harness).
 * `loadedProviders` is the enabled list the config was loaded with (null when
 * unknown).
 *
 * One enabled harness with an unchanged list, as before: checking stores the
 * shared grants as a permission (the default sandbox / permission mode is not
 * changed, so only tasks that ask for full access get it). Otherwise checking
 * sets the harness's own setting: the sandbox to danger-full-access for
 * Codex, Cursor and Antigravity (all of them share it), bypassPermissions for
 * Claude Code; that becomes the default for every task of that harness.
 *
 * Unchecking always leaves write access: a full-access sandbox goes to
 * workspace-write, bypassPermissions to acceptEdits, and the stored full grant
 * is cleared; the write control removes write access. Settings of other
 * enabled harnesses are never changed; settings of harnesses that are not
 * enabled are only ever narrowed.
 */
export function setFullLocalAccess(
  codex: CodingAccessSettings,
  enabled: boolean,
  loadedProviders: readonly string[] | null
): void {
  const { provider: viewed, providers } = normalizeCodingProviders(codex);
  const legacy = storesSharedGrants(providers, loadedProviders);
  if (enabled) {
    if (legacy) {
      codex.allow_workspace_write = true;
      codex.allow_danger_full_access = true;
      return;
    }
    if (viewed === "claude-code") {
      codex.claude_permission_mode = "bypassPermissions";
    } else {
      codex.default_sandbox = "danger-full-access";
    }
    Object.assign(codex, derivedCodingGrants(codex));
    return;
  }

  const governed = governedFamilies(providers, viewed);
  if (governed.sandbox && codex.default_sandbox === "danger-full-access") {
    codex.default_sandbox = "workspace-write";
  }
  if (governed.claude && codex.claude_permission_mode === "bypassPermissions") {
    codex.claude_permission_mode = "acceptEdits";
  }
  if (legacy) {
    codex.allow_workspace_write = true;
    codex.allow_danger_full_access = false;
    return;
  }
  Object.assign(codex, derivedCodingGrants(codex));
}

/**
 * The coding part of the write-access control for the harness shown. One
 * enabled harness with an unchanged list: exactly the previous behaviour
 * (stored grant plus that harness's setting), and unchecking also steps a
 * bypassPermissions mode down so no access remains. Otherwise only the
 * harness's own setting is raised to workspace-write / acceptEdits (never
 * lowered from full access), or stepped down to read-only / default; the
 * shared grants are then recomputed from the settings.
 */
export function setWriteAccess(
  codex: CodingAccessSettings,
  enabled: boolean,
  loadedProviders: readonly string[] | null
): void {
  const { provider: viewed, providers } = normalizeCodingProviders(codex);
  if (storesSharedGrants(providers, loadedProviders)) {
    codex.allow_workspace_write = enabled;
    if (enabled) {
      if (viewed === "claude-code") {
        codex.claude_permission_mode = "acceptEdits";
      } else {
        codex.default_sandbox = "workspace-write";
      }
      return;
    }
    if (codex.default_sandbox === "workspace-write" || codex.default_sandbox === "danger-full-access") {
      codex.default_sandbox = "read-only";
    }
    codex.allow_danger_full_access = false;
    if (codex.claude_permission_mode === "acceptEdits" || codex.claude_permission_mode === "bypassPermissions") {
      codex.claude_permission_mode = "default";
    }
    return;
  }

  if (enabled) {
    if (viewed === "claude-code") {
      if (codex.claude_permission_mode !== "acceptEdits" && codex.claude_permission_mode !== "bypassPermissions") {
        codex.claude_permission_mode = "acceptEdits";
      }
    } else if (codex.default_sandbox !== "workspace-write" && codex.default_sandbox !== "danger-full-access") {
      codex.default_sandbox = "workspace-write";
    }
  } else {
    const governed = governedFamilies(providers, viewed);
    if (governed.sandbox && codex.default_sandbox !== "read-only") {
      codex.default_sandbox = "read-only";
    }
    if (governed.claude && (codex.claude_permission_mode === "acceptEdits" || codex.claude_permission_mode === "bypassPermissions")) {
      codex.claude_permission_mode = "default";
    }
  }
  Object.assign(codex, derivedCodingGrants(codex));
}

/**
 * After a harness setting (sandbox, permission mode) changes: unless the
 * previous single-harness behaviour applies, the stored grants follow the
 * settings, as the save-time reconcile would make them.
 */
export function syncGrantsWithSettings(codex: CodingAccessSettings, loadedProviders: readonly string[] | null): void {
  if (!storesSharedGrants(normalizeCodingProviders(codex).providers, loadedProviders)) {
    Object.assign(codex, derivedCodingGrants(codex));
  }
}

export const CODING_PROVIDER_LABELS: Readonly<Record<CodingProvider, string>> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  antigravity: "Antigravity",
  cursor: "Cursor"
};

function joinLabels(providers: CodingProvider[]): string {
  const labels = providers.map((provider) => CODING_PROVIDER_LABELS[provider]);
  return labels.length <= 1 ? labels.join("") : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

/**
 * Shown next to the full-access checkbox when checking it sets the harness's
 * default (see setFullLocalAccess) rather than a permission: every task of
 * that harness, and of the harnesses sharing its sandbox, then runs with it.
 */
export function fullAccessDefaultHint(codex: CodingAccessSettings, loadedProviders: readonly string[] | null): string {
  const { provider: viewed, providers } = normalizeCodingProviders(codex);
  if (storesSharedGrants(providers, loadedProviders)) {
    return "";
  }
  if (viewed === "claude-code") {
    return "Checking this makes bypassPermissions the default for every Claude Code task, not only tasks that ask for full access.";
  }
  const shared = providers.filter(isSandboxHarness);
  const sharing = shared.length > 1 ? ` (they share one sandbox setting)` : "";
  return `Checking this makes full access the default for every ${joinLabels(shared)} task${sharing}, not only tasks that ask for it.`;
}

/**
 * Shown under the write control when it is on only because of git writes:
 * the shown harness itself has no write access.
 */
export function gitWriteOnlyNote(codex: CodingAccessSettings, gitWriteEnabled: boolean): string {
  if (!gitWriteEnabled || effectiveCodingAccess(codex, codex.provider).write) {
    return "";
  }
  return `Git writes are on. ${CODING_PROVIDER_LABELS[normalizeCodingProviders(codex).provider]} itself is read-only.`;
}

/** Enabled sandbox harnesses that share the sandbox setting with the shown harness (empty unless more than one). */
export function sharedSandboxHarnesses(codex: CodingAccessSettings): CodingProvider[] {
  const { provider: viewed, providers } = normalizeCodingProviders(codex);
  const sandboxHarnesses = providers.filter(isSandboxHarness);
  return isSandboxHarness(viewed) && sandboxHarnesses.length > 1 ? sandboxHarnesses : [];
}

/**
 * Enabled harnesses whose access the controls for the shown harness do not
 * govern but that do have write or full access, so an unchecked box is not
 * read as "nothing on this computer has that access".
 */
export function otherHarnessAccess(codex: CodingAccessSettings): Array<{ provider: CodingProvider } & HarnessAccess> {
  const { provider: viewed, providers } = normalizeCodingProviders(codex);
  if (providers.length <= 1) {
    return [];
  }
  return providers
    .filter((provider) => isSandboxHarness(provider) !== isSandboxHarness(viewed))
    .map((provider) => ({ provider, ...effectiveCodingAccess(codex, provider) }))
    .filter((access) => access.write || access.full);
}
