# Local Security Model

Clero Local Agent lets Clero agents use local tools without exposing local ports. The daemon initiates an outbound WebSocket connection to Clero and enforces local access rules before executing tool calls.

## Trust Boundaries

- Clero backend: broker for pairing, sessions, tool-call routing, and audit delivery.
- Local daemon: owner of local capability checks, leases, approvals, workspace policy, and tool execution.
- Local user: owner of enabled capabilities, allowed folders, and risky-action approvals.
- Remote agent: requester of tool calls, never the final authority for local access.

## Pairing And Tokens

Pairing uses a short-lived code issued by Clero. The daemon claims the code against the backend, receives a device token and WebSocket URL, and stores them locally.

Token storage:

- macOS: Keychain when running the daemon token store.
- other platforms: file fallback until platform credential stores are implemented.

Device tokens should be treated as credentials. They must not be logged, committed, or shown in UI except in deliberate developer diagnostics with redaction.

## Capability Model

Capabilities are explicit and user-controlled:

- Browser
- Coding agent
- Workspace files
- Git read
- Git write

The backend can route a tool call only if the connection advertises the capability, but the daemon still validates local state before execution.

## Lease Model

Leases protect shared local tools, mainly coding-agent start tasks and git writes. Browser tools are lease-free because managed browser sessions are isolated per agent profile. The lease is enforced locally, not by the backend.

Rules for a leased tool scope:

- no active lease: grant to requesting agent
- same agent: refresh/reuse lease
- different agent: return `busy`
- inactivity: expire by TTL
- coding-agent and git-write scopes are keyed by workspace path

Passive status/capability requests, workspace discovery, git reads, browser browsing, and coding-agent status/output polling should remain lease-free.

## Workspace Access

Tools should operate only inside user-selected allowed directories. Any feature that reads or writes files must preserve this boundary.

Expected behavior:

- reject paths outside allowed roots
- normalize paths before checks
- do not follow path traversal outside allowed roots
- keep git write operations approval-gated

## Approvals

Risky actions require local approval. For MVP this includes:

- `git.commit`
- `git.push`
- `git.pull`
- `git.abort_pull`
- `shell.run` when requesting `workspace-write` or `danger-full-access`
- coding-agent modes that can modify files or run with elevated sandbox permissions, unless the local settings already grant that access

For coding agents the local setting is the approval: when the computer's settings allow a mode, a task in that mode starts without a one-time prompt, whether the mode is the harness's default or requested by the task. This covers Codex, Cursor, and Antigravity `workspace-write` / `danger-full-access` and Claude Code `acceptEdits`. Claude Code `bypassPermissions` starts without a prompt only when Claude Code's own permission mode on this computer is `bypassPermissions` and the settings allow bypass (its own mode with several harnesses enabled, or the stored full-access grant with Claude Code alone; another harness's sandbox never allows it). A per-task bypass request on a computer whose Claude Code mode is something else still needs a one-time approval even when a full-access grant is stored (for example one left over from Codex), so an agent without one is denied. A mode the settings do not allow is refused outright, and Claude Code `auto` and `dontAsk` still ask for approval.

Read-only operations such as `git.status`, `git.diff`, browser snapshots, and status checks should avoid unnecessary prompts.

## Browser Control

Managed browser sessions use a dedicated profile. This avoids requiring a preinstalled Chrome extension and keeps automation separate from the user's normal browser profile.

Browser tools should avoid exposing more data than requested. Snapshots, screenshots, console logs, network events, and page content are sensitive and should be audited.

The optional `browser_debug` capability bridges to Chrome DevTools MCP. It can expose DevTools data, page content, console output, network details, and performance traces to agents. Keep it disabled by default and grant it only to agents that should debug browser sessions.

## Coding Agents

Codex, Claude Code, Antigravity, and Cursor adapters execute local CLI processes. Sandbox and approval settings must be visible to the user before enabling the capability.

Several harnesses can be enabled at once; a task picks one with `provider` or runs on the default. With one harness enabled, access follows that harness's setting plus the shared `allow_workspace_write` / `allow_danger_full_access` grants, but stored shared grants are only kept while the enabled list stays the same. With more than one enabled, each harness gets access only from its own setting (the default sandbox for Codex, Cursor, and Antigravity; the permission mode for Claude Code), and the shared grants widen no harness.

Whenever the enabled list changes (Clero's `set_coding_agent_config`, the CLI's `--provider` / `--providers`, or the desktop app's Agent picker), both shared grants are recomputed from the enabled harnesses' own settings: stored grants and any grants echoed in a remote payload are discarded, and no sandbox or Claude Code mode is upgraded from a shared grant. Explicit local CLI `--allow-*` / `--deny-*` flags in the same command still apply afterwards. This recompute is deliberate and can grant access: switching to Claude Code while its permission mode is `bypassPermissions` gives it full access, and switching to Codex, Cursor, or Antigravity (only those) with a `workspace-write` or `danger-full-access` default sandbox gives that access, because those are the user's own explicit settings for that harness.

The grants a config implies follow one rule everywhere they are derived (daemon, CLI, desktop app): the default sandbox counts only while at least one sandbox harness (Codex, Cursor, Antigravity) is enabled, and the Claude Code permission mode counts only while Claude Code is enabled. The sandbox is not a Claude Code setting, so it never grants Claude Code write or bypass access. As a result, a Claude Code-only config with a leftover `workspace-write` or `danger-full-access` sandbox and no stored grant no longer gets that access at startup (older versions derived it from the sandbox); an explicitly stored grant is still honoured while the enabled list is unchanged.

Remote configuration never switches coding on as a side effect: `get_coding_agent_config` reports the running on/off state (the same value as the heartbeat), and a `set_coding_agent_config` payload without `enabled` keeps the current state; only an explicit `enabled: true` or `false` changes it.

Default posture:

- read-only sandbox
- explicit allowed project folders
- no danger-full-access by default
- local approval for higher-risk modes

## Shell

The `shell.run` capability is disabled by default. When enabled, commands must start inside an allowed project folder and output must be bounded by timeout and byte limits.

Default posture:

- inspection-only access
- no output redirection or common destructive commands in inspection mode
- no workspace-write or danger-full-access unless explicitly enabled locally
- lease scoped to the target workspace to avoid overlapping shell/coding/git mutations

Shell is a trusted local command runner, not an operating-system sandbox. The app must describe this clearly wherever users enable the feature.

## Audit Metadata

Every tool call should carry enough metadata to support debugging and user review:

- timestamp
- request id
- agent id
- task/event id when available
- requested action key
- tool name
- sanitized arguments or metadata
- structured result or error

Do not log secrets, full tokens, private keys, or hidden credential files.

## Official Builds

Official macOS builds are distributed through the release workflow. Builds without Apple Developer ID notarization may trigger Gatekeeper warnings.

See [official-builds.md](official-builds.md).
