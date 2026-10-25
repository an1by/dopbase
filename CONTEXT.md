# Domain context

## Project

A project is one application or service. It contains one or more environments.

## Environment

An environment is a named deployment context within a project, such as development, staging, or production. It owns its secrets and runner tokens.

## Role

Every account has one fixed role: root, admin, member, or ai_agent. Role-based access control (RBAC) will replace the fixed roles. Code that hard-codes a role carries a `TODO(rbac):` comment, which CONTRIBUTING.md describes under "Mark code that RBAC will replace". Add the marker whenever new code depends on a fixed role.

## Workspace

Workspace is not a Dopbase domain term. Use it only for development concepts such as an editor or filesystem workspace.
