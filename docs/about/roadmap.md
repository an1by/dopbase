---
title: "Roadmap"
description: "The Dopbase roadmap: what ships and what is planned next."
---

# Roadmap

The roadmap describes intent, not a release commitment. Work may move as implementation and security review uncover new requirements.

## Current release: v0.1.x

Version 0.1 builds the core of a self-hosted secrets manager. One executable
stores encrypted secrets, injects them into applications, and gives operators
what they need to run, audit, and recover an instance.

- Authentication with root, admin, member, and AI agent roles
- Projects, environments, and encrypted secrets stored in SQLite
- Embedded Admin UI, REST API, OpenAPI specification, and Swagger UI
- Guided project and environment creation from `./.env` through `dopbase init`
- CLI support for dotenv, JSON, YAML, and TOML import and export, plus Docker
  env-file export
- Secret injection with `dopbase run` and an encrypted runtime cache
- Runtime cache inspection and cleanup
- Secret version history and rollback
- Single sign-on for the Admin UI through OpenID Connect, and browser
  approval for CLI login
- Environment-scoped runner tokens, AI service accounts, and audit records in
  a verifiable hash chain
- User and AI account management
- Instance status and server log management
- Encrypted full-instance backups and recovery-aware factory reset
- Self-hosted binaries for macOS and Linux on AMD64 and ARM64

## v0.2.0: Team features

Version 0.2 is for teams. It makes bringing people in easier and lets admins
decide what each person can see and change, down to a single environment.

- User invitations, so new members set their own password or sign in through
  single sign-on
- Teams that group users and receive access together
- Improved role-based access control, with custom roles in place of the four
  fixed ones
- Access granted per project and per environment
- Account identity
- Broader service-account automation
- Restoring deleted secrets, environments, and projects

## v0.3.0: Integrations and key management

Version 0.3 connects Dopbase to the places secrets are used, such as CI
pipelines and containers, and lets the master key live in a cloud key service.

- AWS KMS, Google Cloud KMS, and Azure Key Vault
- Master-key rotation without downtime
- Environment inheritance
- GitHub Actions and GitLab CI integrations
- Docker workflows
- Webhooks and secret references

## v0.4.0: Compliance and operations

Version 0.4 is for organizations with audit and compliance requirements, and
for operators who want less manual upkeep.

- Advanced auditing
- Compliance tooling
- Automatic secret rotation
- Scheduled backups
- Automatic upgrades
- Cloud migration tools

## Later, based on demand

- Dopbase Cloud, a managed Dopbase server
- Native Windows binaries
- High availability
- Enterprise policies and SCIM
- Dedicated or regional deployments

See [product status](/guide/product-status) for current capabilities and operational boundaries.
