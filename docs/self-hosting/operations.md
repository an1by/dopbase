---
title: "Production operations: TLS, monitoring, upgrades"
description: "Operate a Dopbase server safely: network and TLS setup, monitoring, upgrades, backups, and recovery for a secrets manager."
---

# Operations

Operating a secrets manager requires protecting both service availability and stored credentials.

## Network and TLS

Localhost is the expected development default. Any server reachable over a network needs authenticated encryption in transit, a deliberate bind address, and firewall rules that expose only the required interface.

Terminate TLS with a reviewed reverse proxy and restrict the Dopbase listener to the network interfaces that need it.

Behind a proxy, every connection Dopbase sees comes from the proxy, so the audit log would record the proxy's address for every action. List the proxy in `trusted_proxies` in `server.toml`, or in `DOPBASE_TRUSTED_PROXIES`, and Dopbase reads the client address from `X-Forwarded-For` for connections from that proxy only:

```toml
trusted_proxies = ["127.0.0.1", "172.16.0.0/12"]
```

Dopbase reads the header from the right and stops at the first address that is not a trusted proxy, so a client cannot choose the address it is recorded under. Configure the proxy to set or append `X-Forwarded-For`, and list only proxies you run: any address on the list can claim to be any client.

## Secret history

Dopbase keeps the value of the newest 20 versions of every secret so they can
be [rolled back](/guide/projects-environments-secrets#versions-and-rollback).
Set `secret_history_versions` in `server.toml`, or
`DOPBASE_SECRET_HISTORY_VERSIONS`, to keep between 2 and 1000:

```toml
secret_history_versions = 50
```

The setting applies to a secret the next time it is saved. Retained versions
are part of the database, so backups and restores carry them, and they grow
the database by roughly the size of each stored value. Expired versions keep
only metadata.

## Monitoring

Monitor service availability, database health, disk space, backup completion, authentication failures, and abnormal audit activity. Monitoring output must not contain request bodies or secret values.

## Logging

Application logs may include timestamps, operation names, request identifiers, status codes, and safe resource identifiers. They must never include plaintext secrets, credentials, decrypted request bodies, or authentication tokens.

## Upgrades

Back up the database and master key before an upgrade. Review the [release notes](https://github.com/dopbase/dopbase/releases) for migration and compatibility information before replacing the executable.

The server runs database migrations when it starts, and there is no automatic downgrade. A database opened by 0.1.10 cannot be used by 0.1.9, so to go back you restore the backup you made before the upgrade.

## Incident response

An incident plan should cover a stolen database, exposed master key, leaked service token, unavailable server, failed migration, and corrupted backup. Each case has different recovery and rotation requirements.

## Production readiness checklist

- A supported Dopbase release is installed.
- TLS and network exposure are reviewed.
- The database and master key use separate protected storage.
- Backups are automated and restoration has been tested.
- Logs and monitoring have been checked for secret leakage.
- Upgrade and incident procedures have named owners.
