# Contributing

Thanks for improving Clero Local Agent. This project is security-sensitive because it can operate browser, coding, workspace, and git tools on a user's machine.

## Development Setup

```bash
pnpm install
pnpm typecheck
pnpm test
```

Desktop development:

```bash
pnpm dev:desktop
pnpm tauri:dev
```

## Contribution Rules

- Keep changes scoped to the requested behavior.
- Prefer existing package boundaries and protocol types.
- Add or update tests for lease behavior, protocol schema changes, approval changes, workspace access, and tool execution behavior.
- Do not commit generated build output, packaged app artifacts, private keys, tokens, or local config files.
- Do not weaken approval checks, workspace restrictions, or lease enforcement without an explicit security rationale.

## Pull Request Checklist

- Tests pass or the remaining failures are documented.
- Public protocol changes are reflected in `packages/protocol`.
- New tools define input schemas.
- Risky tools document approval behavior.
- User-facing release changes are reflected in `README.md` or `docs/`.

## Security Changes

Changes touching pairing, tokens, WebSocket authentication, approvals, filesystem access, git write access, or coding-agent sandbox behavior should explain the trust boundary and failure mode in the PR description.

For vulnerabilities, do not open a public PR before reporting privately. See [SECURITY.md](SECURITY.md).
