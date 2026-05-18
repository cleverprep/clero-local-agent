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

Leases protect shared local tools, mainly coding-agent tasks and git writes. Browser tools are lease-free because managed browser sessions are isolated per agent profile. The lease is enforced locally, not by the backend.

Rules for a leased tool scope:

- no active lease: grant to requesting agent
- same agent: refresh/reuse lease
- different agent: return `busy`
- inactivity: expire by TTL

Passive status/capability requests, workspace discovery, git reads, and browser browsing should remain lease-free.

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
- coding-agent modes that can modify files or run with elevated sandbox permissions

Read-only operations such as `git.status`, `git.diff`, browser snapshots, and status checks should avoid unnecessary prompts.

## Browser Control

Managed browser sessions use a dedicated profile. This avoids requiring a preinstalled Chrome extension and keeps automation separate from the user's normal browser profile.

Browser tools should avoid exposing more data than requested. Snapshots, screenshots, console logs, network events, and page content are sensitive and should be audited.

## Coding Agents

Codex and Claude Code adapters execute local CLI processes. Sandbox and approval settings must be visible to the user before enabling the capability.

Default posture:

- read-only sandbox
- explicit allowed project folders
- no danger-full-access by default
- local approval for higher-risk modes

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
