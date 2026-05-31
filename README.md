# Clero Local Agent

`clero-local-agent` is a local runtime that lets Clero agents use approved tools on a user's machine through MCP-style tool calls over an outbound WebSocket.

The MVP targets macOS first and keeps the code portable for Windows. The CLI daemon remains the execution engine; the desktop app is the setup and control surface.

## License And Trust

This project is licensed under Apache-2.0. See [LICENSE](LICENSE).

Because Clero Local Agent can control local browser, coding, workspace, and git tools, the trust model is documented explicitly:

- [Security policy](SECURITY.md)
- [Contribution guide](CONTRIBUTING.md)
- [Local security model](docs/security.md)
- [Official builds and releases](docs/official-builds.md)

## What Is Included

- TypeScript monorepo scaffold.
- CLI entrypoint: `clero-connector` (`clero-local-agent` remains an alias).
- Nuxt 3 + Tauri desktop scaffold.
- Pairing/token storage interfaces with macOS Keychain support.
- Authenticated outbound WebSocket client.
- Session and lease manager:
  - one attached Clero agent/runtime connection at a time.
  - local leases for shared coding-agent and git-write tools.
  - automatic lease expiry when heartbeats stop.
- MCP-style tool registry with lease enforcement for shared local tools.
- Managed browser adapter that launches agent-scoped browser profiles without a Chrome extension.
- Codex, Claude Code, and Antigravity CLI process adapters.
- Git status/diff/commit/push tools.
- Approval provider abstraction, with terminal approval for risky git writes.
- Focused tests for lease behavior and tool lease enforcement.

## Repo Layout

```text
apps/
  cli/                 # clero-local-agent CLI entrypoint
  desktop/             # Nuxt 3 + Tauri desktop wrapper
packages/
  daemon/              # auth, pairing, websocket, session manager
  protocol/            # shared message schemas/types
  mcp-runtime/         # tool registry and JSON tool execution
  browser/             # managed Playwright browser plus optional MCP provider adapters
  coding-agents/       # Codex, Claude Code, and Antigravity process adapters
  git-tools/           # git status/diff/commit/push wrappers
  workspace/           # allowed directories and file policies
  approvals/           # approval prompts and policies
```

## Local Development

This scaffold uses Node 22's built-in TypeScript stripping for tests, so the core tests can run before dependencies are installed:

```bash
npm test
```

For normal TypeScript tooling:

```bash
pnpm install
pnpm typecheck
```

Desktop UI:

```bash
pnpm dev:desktop
pnpm tauri:dev
```

`pnpm dev:desktop` runs the Nuxt UI only. `pnpm tauri:dev` requires the Rust/Cargo toolchain.

The desktop shell can start and stop the local daemon. In development it launches the existing Node CLI with the saved desktop config. Packaged builds should provide a bundled daemon binary and point `CLERO_LOCAL_AGENT_DAEMON_BIN` at it until the sidecar packaging is finalized.

## Desktop Releases And Updates

The desktop app uses Tauri's signed updater. GitHub Releases remains the release audit trail, but the website and installed app should fetch builds from `https://media.clero.so`, backed by Cloudflare R2.

One-time setup:

```bash
pnpm --filter @clero-local-agent/desktop exec tauri signer generate --ci -w /private/tmp/clero-local-agent-updater.key
```

Commit only the public key in `apps/desktop/src-tauri/updater.public.key`. Store the private key contents in the GitHub secret `TAURI_SIGNING_PRIVATE_KEY`. If you generated the key with a password, store it in `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`; otherwise do not create that secret.

Cloudflare R2 setup:

1. Create an R2 bucket for public release files.
2. Add a Cloudflare route or Worker so these URLs resolve from that bucket:

```text
https://media.clero.so/local-agent/latest/clero-local-agent-macos-aarch64.dmg
https://media.clero.so/local-agent/latest/latest.json
https://media.clero.so/local-agent/latest/install.json
https://media.clero.so/local-agent/releases/<version>/*
```

3. Add these GitHub secrets:

```text
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_API_TOKEN
CLOUDFLARE_R2_BUCKET
```

The workflow uploads with Wrangler, so it uses a Cloudflare API token with R2 edit access. It does not need R2 S3 Access Key ID / Secret Access Key credentials.

Automatic build checks:

- `.github/workflows/desktop-build.yml` runs on pushes and pull requests that touch desktop/runtime files.
- It builds an unsigned macOS app and uploads the DMG/app as a GitHub Actions artifact.
- Use this for validation only; it is not the user-facing release channel.

Local signed release build:

```bash
export TAURI_SIGNING_PRIVATE_KEY="$(cat /private/tmp/clero-local-agent-updater.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
export CLERO_UPDATER_ENDPOINT="https://media.clero.so/local-agent/latest/latest.json"
pnpm tauri:build:release
pnpm build:r2-release-assets
```

GitHub Release flow:

1. Make sure these GitHub secrets exist:

```text
TAURI_SIGNING_PRIVATE_KEY
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_API_TOKEN
CLOUDFLARE_R2_BUCKET
```

`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` is optional. GitHub does not allow empty secret values; leave the secret missing when the updater key has no password.

This workflow does not require Apple Developer ID signing. `TAURI_SIGNING_PRIVATE_KEY` signs Tauri updater bundles only; it does not satisfy macOS Gatekeeper. Without Apple notarization, macOS may show: `Apple could not verify "Clero Local Agent" is free of malware...`.

2. Update the desktop version in `apps/desktop/package.json` and `apps/desktop/src-tauri/tauri.conf.json`.
3. Push a release tag:

```bash
git tag desktop-v0.1.6
git push origin desktop-v0.1.6
```

4. `.github/workflows/desktop-release.yml` builds the app, creates a draft GitHub Release, prepares website assets, and uploads them to R2.
5. Review the draft release, then publish it.

By default the app checks:

```text
https://media.clero.so/local-agent/latest/latest.json
```

The frontend download button should use the stable macOS URL:

```text
https://media.clero.so/local-agent/latest/clero-local-agent-macos-aarch64.dmg
```

Prefer returning that URL from the backend `local-runtime/install-url/` response as `download_url`, so the frontend does not hardcode release infrastructure. `install.json` is also uploaded for website/backend metadata if needed.

Override the updater endpoint with `CLERO_UPDATER_ENDPOINT` before running `pnpm build:tauri-updater-config`.

## Connector CLI Distribution

The desktop app is the default user experience. The CLI is for developers, CI machines, servers, and users who prefer a terminal workflow. Users should not need to clone this repository, install Node, or run `pnpm` to use it.

Target user install flow:

```bash
curl -fsSL https://media.clero.so/local-agent/install.sh | sh
```

Then:

```bash
clero-connector setup \
  --code LRA-FFBD-4222-7DA1 \
  --allowed-dir ~/Projects \
  --coding-provider codex

clero-connector daemon
```

Expected release artifacts:

```text
clero-connector-darwin-arm64.tar.gz
clero-connector-darwin-x64.tar.gz
clero-connector-linux-arm64.tar.gz
clero-connector-linux-x64.tar.gz
clero-connector-win-x64.zip
checksums.txt
install.sh
install.ps1
```

Stable R2 URLs:

```text
https://media.clero.so/local-agent/install.sh
https://media.clero.so/local-agent/install.ps1
https://media.clero.so/local-agent/latest/install.sh
https://media.clero.so/local-agent/latest/install.ps1
https://media.clero.so/local-agent/latest/clero-connector-darwin-arm64.tar.gz
https://media.clero.so/local-agent/latest/clero-connector-darwin-x64.tar.gz
https://media.clero.so/local-agent/latest/clero-connector-linux-arm64.tar.gz
https://media.clero.so/local-agent/latest/clero-connector-linux-x64.tar.gz
https://media.clero.so/local-agent/latest/clero-connector-win-x64.zip
https://media.clero.so/local-agent/latest/checksums.txt
https://media.clero.so/local-agent/releases/<version>/...
```

Installer script behavior:

- Detect OS and CPU architecture.
- Download the matching archive from `https://media.clero.so/local-agent/latest/`.
- Verify the downloaded archive against `checksums.txt`.
- Install the binary as `clero-connector`.
- Prefer a user-writable install path such as `~/.local/bin`; only use `/usr/local/bin` when the user explicitly chooses a system install.
- Print the exact installed path and warn if that directory is not on `PATH`.
- Never write a device token into shell history or a plaintext config file. Pairing tokens should continue to use the existing token store where available.

Manual install fallback:

```bash
curl -L -o clero-connector.tar.gz \
  https://media.clero.so/local-agent/latest/clero-connector-darwin-arm64.tar.gz
tar -xzf clero-connector.tar.gz
mkdir -p ~/.local/bin
mv clero-connector ~/.local/bin/clero-connector
chmod +x ~/.local/bin/clero-connector
```

Windows target flow:

```powershell
irm https://media.clero.so/local-agent/latest/install.ps1 | iex
clero-connector setup --code LRA-FFBD-4222-7DA1 --allowed-dir "$env:USERPROFILE\Projects" --coding-provider codex
clero-connector daemon
```

Release automation guideline:

1. Build standalone CLI binaries for macOS arm64/x64, Linux arm64/x64, and Windows x64.
2. Package each binary with a short README and license file.
3. Generate `checksums.txt` with SHA-256 checksums for every archive.
4. Upload versioned artifacts to `local-agent/releases/<version>/`.
5. Copy the same artifacts to `local-agent/latest/` only after all uploads and checksum verification pass.
6. Keep GitHub Releases as the audit trail and R2 as the user-facing download channel.

Package-manager roadmap:

- Homebrew should be the first package-manager target for macOS and Linux:

```bash
brew install cleverprep/tap/clero-connector
```

- Windows can start with `install.ps1`, then add Winget when the CLI is stable:

```powershell
winget install Clero.Connector
```

CLI updates:

- macOS/Linux users can run `clero-connector update`. It reruns the latest R2 installer, verifies the archive checksum, replaces the installed runtime, and keeps `~/.clero-local-agent/config.json`.
- Windows users should stop any running daemon and rerun the PowerShell installer:

```powershell
irm https://media.clero.so/local-agent/latest/install.ps1 | iex
```

- Re-running the install script is safe on every platform; the installer keeps the previous runtime at `current.prev` where possible.

## Connector CLI Usage

`clero-connector` is the terminal-first control surface for the same daemon used by the desktop app. It keeps the config at `~/.clero-local-agent/config.json` for compatibility with existing installs.

One-command setup and pair:

```bash
clero-connector setup \
  --code LRA-FFBD-4222-7DA1 \
  --allowed-dir ~/Projects \
  --coding-provider codex
```

Then run the outbound daemon:

```bash
clero-connector daemon
```

Command reference:

```bash
# Setup and pairing
clero-connector setup --code <connection-code> [--backend-url https://clero.so] [--allowed-dir <path>]
clero-connector pair --code <connection-code> [--backend-url https://clero.so] [--save]

# Run the connector
clero-connector daemon
clero-connector daemon --config ~/.clero-local-agent/config.json
clero-connector daemon --ws-url <websocket-url> --token <device-token>

# Status and capabilities
clero-connector status
clero-connector capabilities
clero-connector agents list
clero-connector agents browser
clero-connector agents coding
clero-connector agents list --json

# Config file
clero-connector config init
clero-connector config show

# Allowed workspaces
clero-connector workspaces list
clero-connector workspaces add --path ~/Projects/clero_front
clero-connector workspaces remove --path ~/Projects/clero_front

# Browser capability
clero-connector browser status
clero-connector browser enable --browser-channel chromium
clero-connector browser enable --browser-channel chrome
clero-connector browser enable --browser-headless
clero-connector browser enable --no-browser-headless
clero-connector browser enable --browser-headless --browser-width 1440 --browser-height 900
clero-connector browser enable --browser-profile-dir ~/.clero-local-agent/browser-profile
clero-connector browser enable --browser-remember-session
clero-connector browser enable --no-browser-remember-session
clero-connector browser disable

# Coding-agent capability
clero-connector coding status
clero-connector coding enable --provider codex --sandbox read-only
clero-connector coding enable --provider claude-code --sandbox workspace-write --claude-permission-mode acceptEdits
clero-connector coding enable --provider antigravity --sandbox read-only
clero-connector coding enable --model <model-name>
clero-connector coding enable --command <path-or-command>
clero-connector coding enable --allow-workspace-write
clero-connector coding enable --deny-workspace-write
clero-connector coding enable --allow-danger-full-access
clero-connector coding enable --deny-danger-full-access
clero-connector coding disable

# Self-update
clero-connector update
```

Setup and `pair` also accept the same capability flags, so this is valid:

```bash
clero-connector setup \
  --code LRA-FFBD-4222-7DA1 \
  --allowed-dir ~/Projects \
  --browser-channel chromium \
  --coding-provider codex \
  --sandbox read-only
```

Browser channels are `chromium`, `chrome`, `chrome-beta`, and `msedge`. Headless browser sessions default to a `1440x900` viewport unless `--browser-width` and `--browser-height` are configured. Coding providers are `codex`, `claude-code`, and `antigravity`. Sandboxes are `read-only`, `workspace-write`, and `danger-full-access`.

The coding-agent connection is local: Clero calls `coding_agent.start_task`, the daemon validates the requested `cwd` against configured workspaces, then starts the configured provider (`codex`, `claude-code`, or `antigravity`) as a child process in that workspace. The daemon returns a `task_id` immediately and Clero polls `coding_agent.get_status` / `coding_agent.get_output` for long-running results.

`clero-connector agents list` shows the latest agents Clero synced to this local runtime. `agents browser` filters to agents with browser access, and `agents coding` filters to agents with coding-agent access. The daemon writes this cache when it receives backend `agents_sync`, so start `clero-connector daemon` at least once after pairing before using the command.

The original `clero-local-agent` command still works as an alias:

```bash
clero-local-agent daemon
```

### Development CLI

During local development, use `pnpm dev:cli` in place of `clero-connector`:

Create a local runtime config:

```bash
pnpm dev:cli config init --config ~/.clero-local-agent/config.json
```

Run the daemon with an outbound WebSocket URL and a device token:

```bash
pnpm dev:cli daemon \
  --ws-url wss://app.clero.example/local-runtime/ws \
  --token "$CLERO_LOCAL_RUNTIME_TOKEN" \
  --allowed-dir "$PWD"
```

Or run from a config file:

```bash
pnpm dev:cli daemon --config ~/.clero-local-agent/config.json
```

Pair the device once the backend endpoint is available:

```bash
pnpm dev:cli pair \
  --backend-url https://clero.so \
  --code LRA-FFBD-4222-7DA1
```

The daemon claims pairing codes with:

```text
POST /api/v1/integrations/local-runtime/claim/
```

Expected backend response:

```json
{
  "connection_id": 45,
  "device_token": "clrt_...",
  "websocket_url": "wss://clero.so/ws/local-runtime/"
}
```

Then start the daemon with the returned values:

```bash
CLERO_LOCAL_RUNTIME_WS_URL="wss://clero.so/ws/local-runtime/" \
CLERO_LOCAL_RUNTIME_TOKEN="clrt_..." \
pnpm dev:cli daemon
```

Print local capabilities without connecting:

```bash
pnpm dev:cli capabilities
```

Pairing sends these capabilities with `inputSchema` for every tool, so Clero can register runtime tools with usable arguments such as `browser.open_url.url` and `coding_agent.start_task.prompt`.

On every WebSocket session establishment, the daemon also sends the backend-supported `hello` message with the current capabilities:

```json
{
  "type": "hello",
  "platform": "darwin",
  "daemon_version": "0.1.6",
  "capabilities": {
    "tools": []
  }
}
```

The backend should upsert the stored runtime tool schemas from this message. This lets reconnects refresh capabilities without forcing the user to re-pair.

## Browser Tools

The default browser provider is a managed Playwright browser profile. It does not require a preinstalled Chrome extension or a remote-debugging flag. The local agent launches a visible browser window on demand, stores cookies/session state in a dedicated Clero profile, and agents browse through that controlled profile.

Default profile directory:

```text
~/.clero-local-agent/browser-profile
```

Optional daemon flags:

```bash
--browser-provider managed
--browser-profile-dir ~/.clero-local-agent/browser-profile
--browser-channel chromium
```

Use `--browser-channel chrome` only if you explicitly want to drive an installed Chrome channel instead of Playwright's managed Chromium.

Start the daemon with the default managed browser:

```bash
pnpm dev:cli daemon \
  --ws-url wss://app.clero.example/local-runtime/ws \
  --token "$CLERO_LOCAL_RUNTIME_TOKEN"
```

Verify the managed browser without the Clero backend:

```bash
npm run smoke:browser
```

## Supported Control Messages

- `acquire_lease`
- `heartbeat_lease`
- `release_lease`
- `get_daemon_status`
- `list_capabilities`

Clero acts as the broker, not the lease owner. Normal backend `tool_call` messages do not need a `lease_id`; for lease-required tools, the daemon maps `agent_id` into a local lease. Coding-agent start tasks and git writes are leased per workspace path, so two agents can run Codex or Claude Code in different workspaces at the same time. A different agent gets `busy` only when it tries to use the same leased workspace scope.

Leases expire after 60 seconds of inactivity. Any lease-required tool usage or `heartbeat_lease` refreshes the inactivity timeout. Browser tools do not require a lease because each agent uses an isolated browser session/profile.

Current backend tool-call shape:

```json
{
  "type": "tool_call",
  "request_id": "lrt_...",
  "agent_id": 12,
  "event_run_id": 192,
  "requested_action_key": "local_runtime_45.browser",
  "tool": "browser.open_url",
  "arguments": {
    "url": "https://example.com"
  }
}
```

The daemon accepts tool input from `arguments`. It also tolerates broker aliases (`input`, `tool_input`, `parameters`, `params`) and JSON-string encoded arguments, but the backend should prefer `arguments` with a JSON object.

## MVP Tool Set

Browser tools, passive and agent-scoped:

- `browser.list_tabs`
- `browser.open_url`
- `browser.switch_tab`
- `browser.get_page_content`
- `browser.get_interactive_elements`
- `browser.get_snapshot`
- `browser.click`
- `browser.move_mouse`
- `browser.mouse_down`
- `browser.mouse_up`
- `browser.drag`
- `browser.type`
- `browser.press_key`
- `browser.screenshot`
- `browser.get_console_logs`
- `browser.get_network_events`
- `browser.go_back`
- `browser.go_forward`
- `browser.close_tab`
- `browser.close_page`

`browser.close_page` is a compatibility alias for `browser.close_tab`.

Browser tools are lease-free. The managed browser adapter keeps agent sessions separated by `agent_id`, so one agent browsing does not block another agent from using browser or coding-agent tools.

Workspace tools, passive:

- `workspace.list_roots`
- `workspace.list_projects`
- `workspace.describe_project`

These let Clero discover which local projects the daemon is allowed to expose. `workspace.list_roots` returns the directories configured with `--allow-dir`. `workspace.list_projects` scans those roots for common project markers like `.git`, `package.json`, `pyproject.toml`, `manage.py`, `Cargo.toml`, and `go.mod`. `workspace.describe_project` returns stack hints, package metadata, and git status for an allowed project path. Coding-agent tasks should use one of these returned paths as `coding_agent.start_task.cwd`.

Coding-agent tools:

- `coding_agent.start_task` lease required per `cwd`
- `coding_agent.get_status` passive
- `coding_agent.get_output` passive
- `coding_agent.cancel` passive

`coding_agent.start_task` runs Codex, Claude Code, or Antigravity as a background job and returns a local `task_id` immediately. By default it uses the `read-only` sandbox setting. If `sandbox` is `workspace-write` or `danger-full-access`, local approval is required before the coding process starts. Runtime approval prompts from the coding CLI are not used in this mode; if sandbox or permission policy blocks progress, the task is marked `blocked` and the details are returned through `coding_agent.get_status` / `coding_agent.get_output`. While the child coding process is running, the daemon keeps that workspace lease alive.

Supported `coding_agent.start_task` arguments:

- `prompt` required.
- `cwd` allowed workspace directory.
- `sandbox` one of `read-only`, `workspace-write`, or `danger-full-access`.
- `model` optional Codex or Claude Code model override.
- `ephemeral` to avoid persisting Codex session rollout files.
- `skip_git_repo_check` to allow one-off non-git directories.

`coding_agent.get_output` returns captured stdout/stderr, the final agent message, and parsed coding-agent events. Use `since_event_index` and `max_events` for polling long-running tasks.

Git tools:

- `git.status`
- `git.diff`
- `git.commit`
- `git.push`

`git.commit` and `git.push` require local approval. `git.status` and `git.diff` are read-only and do not require the active lease.

## Backend Integration Notes

The backend should add a `LOCAL_RUNTIME` provider with:

- Pairing endpoints.
- Device/session model.
- WebSocket broker.
- Runtime connection status.
- Dynamic tool-access groups:
  - `local_runtime_<id>.browser`
  - `local_runtime_<id>.codex`
  - `local_runtime_<id>.git_read`
  - `local_runtime_<id>.git_write`
- Tool-call proxy that routes through the active daemon session.
- Audit logs for inputs, outputs, screenshots, command output, diffs, commits, and pushes.
- Approval integration for risky tools.
# clero-local-agent
