# Clero Local Agent Desktop

Nuxt 3 + Tauri wrapper for the local runtime daemon.

The desktop app is the setup and control plane:

- Pair the machine with Clero through the backend `/claim/` endpoint.
- Start and stop the local daemon process.
- Store local runtime settings.
- Enable or disable browser, workspace, Codex, and git capabilities.
- Choose allowed project folders.
- Set Codex sandbox policy before tasks can run.

The daemon remains the execution engine. The desktop app should only start/stop it, write config, and collect local approvals.

## Development

```bash
pnpm --filter @clero-local-agent/desktop install
pnpm --filter @clero-local-agent/desktop tauri:dev
```

The current scaffold saves config through Tauri commands and falls back to browser local storage when opened as a plain Nuxt app. Pairing and daemon start/stop are handled by the Tauri shell. During pairing, the shell asks the runtime CLI for `capabilities --config <desktop-config-path>` so Clero receives the same enabled tool schemas that the daemon will advertise after startup.

In development the shell starts the daemon through the existing Node CLI:

```bash
node --experimental-strip-types apps/cli/src/main.ts daemon --config <desktop-config-path>
```

For packaged builds, set `CLERO_LOCAL_AGENT_DAEMON_BIN` to a bundled daemon binary path. The production packaging step should replace this with a Tauri sidecar binary.
