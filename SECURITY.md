# Security

## Sensitive data

This project must not receive or publish personal Mihomo configurations,
subscription URLs, proxy credentials, UUIDs, passwords, private keys, provider
caches, logs, cache databases or unreviewed diagnostic reports.

The public template intentionally contains the requested first-install
controller secret `123456`. This is not a private release credential, but it is
not suitable for continued use: the controller listens on all interfaces, so
users should replace it with a long random value after installation.

The manager's uninstall action is intentionally destructive. After one explicit
confirmation it permanently removes the backend configuration, provider cache,
logs and backups. It validates the exact backend path, refuses symlink targets
and aborts if the Mihomo process or owned firewall chains remain active.

When reporting a problem, use the manager's redacted diagnostic action and
review the output manually before sharing it. Ordinary Mihomo and boot logs are
not redacted reports.

## Installation trust boundary

- The UFI-Tools script runs Root commands on the F50 device.
- Automatic installation accepts only the exact RC2 manifest schema and version.
- Release packages are checked for exact byte size and SHA-256 before extraction.
- The manifest URL must use an immutable Git tag.
- TLS verification and checksum verification must never be disabled as a fix.
- A compromised GitHub repository or imported JS remains inside the Root trust
  boundary; users should obtain releases from the expected repository owner.

## Reporting

Use the repository's private security-advisory form:

https://github.com/Kiro-Durandal/MihomoForUFI/security/advisories/new

Ordinary bugs may be reported in public issues, but do not disclose live
subscription tokens, node credentials, controller secrets or unredacted logs.
