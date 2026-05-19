# Security Policy

## Status

Speculum is a **pre-1.0 developer preview**. No formal security guarantees,
SLAs, or backports are offered yet. Treat it as experimental tooling.

## Reporting a vulnerability

Please report suspected vulnerabilities privately via either:

- Email: **102334+expelledboy@users.noreply.github.com**
- GitHub: open a [private security advisory](https://github.com/expelledboy/speculum/security/advisories/new)

Please do **not** open public issues for security reports. A best-effort
acknowledgement will follow within a few days.

## Scope

Speculum executes local shell commands as part of its core function —
notably `docker`, `kubectl`, and child processes via `Bun.spawn`. This is
intentional and required for the adapter substrates it drives.

**Out of scope:**

- Running speculum against untrusted Blueprints, test code, or
  `--kubeconfig` / `DOCKER_HOST` endpoints you do not control. Treat
  speculum the same way you would treat a local test runner with shell
  access — never point it at hostile inputs.
- Vulnerabilities in upstream tools (`docker`, `kubectl`, Bun, the
  Kubernetes API). Report those upstream.

In-scope reports include: privilege escalation through speculum's own
code paths, command injection via Blueprint or Binding fields that
should be treated as opaque data, and accidental leakage of secrets
from a user's environment through speculum's logging or event streams.
