# Security Policy

Clero Local Agent runs on a user's machine and can broker access to sensitive local tools. Please report security issues privately before opening a public issue.

## Supported Versions

Only the latest public release is supported for security fixes while the project is pre-1.0.

## Reporting A Vulnerability

Email security reports to security@clero.so.

Please include:

- affected version or commit
- operating system
- clear reproduction steps
- expected impact
- logs or screenshots with secrets removed

Do not include device tokens, pairing codes, private repository contents, or production credentials in a public issue.

## Response Expectations

We aim to acknowledge valid reports within 3 business days. Fix timelines depend on severity and whether the issue affects official signed builds, the daemon protocol, local approvals, or backend pairing.

## Security Boundaries

The local agent is a broker for approved local actions. The Clero backend should not be treated as the owner of local trust decisions. Local enforcement remains responsible for:

- pairing and device-token handling
- capability enablement
- active local lease enforcement
- allowed workspace directory policy
- approval checks for risky actions
- local audit metadata

See [docs/security.md](docs/security.md) for the detailed local trust model.
