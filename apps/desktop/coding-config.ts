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
