# Security policy

Dopbase handles application credentials, so a vulnerability can affect systems beyond the Dopbase server itself. Please report suspected security problems privately.

## Supported versions

Dopbase is before 1.0. Security fixes go into the latest release line only.

| Version           | Security fixes |
| ----------------- | -------------- |
| 0.2.x             | Yes            |
| 0.1.x and earlier | No             |

Fixes are not backported to older lines, and there are no fixed response times yet. Reports against the current `main` branch are welcome too.

A minor release can still change the storage format, the API, or the backup format, so read the [changelog](./CHANGELOG.md) before you upgrade. 0.1.x has no in-place upgrade: follow [Upgrade to 0.2.0](./docs/self-hosting/upgrade-to-0-2.md) to move to a supported version.

If you self-host Dopbase, you are responsible for TLS, network access, backups, master-key storage, monitoring, and upgrades.

## Report a vulnerability

Use GitHub private vulnerability reporting:

1. Open the repository's **Security** tab.
2. Select **Report a vulnerability**.
3. Complete the private advisory form.

Do not open a public issue, discussion, or pull request for an undisclosed vulnerability. Do not include live credentials, customer data, private service URLs, or secrets from a system you do not own.

Include enough information to reproduce and assess the report safely:

- A description of the vulnerability and its impact
- The affected commit, branch, or version
- Required configuration and preconditions
- Reproduction steps or a minimal proof of concept
- Relevant logs with all secrets removed
- Any mitigation or fix you have already tested

## What happens next

Maintainers will review the report privately, confirm the affected behavior, and request more information when needed. If the issue is accepted, remediation and disclosure will be coordinated through the private advisory.

The project will credit reporters who want public credit unless legal, privacy, or safety concerns prevent it. Please allow time for investigation and a fix before publishing details.

## What belongs in a public issue

Feature requests, configuration questions, documentation corrections, and ordinary bugs without a security impact can use the public issue tracker. If you are unsure whether a problem is security-sensitive, use private vulnerability reporting.
