# Domain context

Architecture decisions for the **an1by/dopbase** fork (upstream merges, workspaces,
Docker, Windows) are recorded in [docs/adr/](./docs/adr/index.md).

## Project

A project is one application or service. It contains one or more environments.

## Environment

An environment is a named deployment context within a project, such as development, staging, or production. It owns its secrets and environment-scoped runner tokens.

## Principal

Who makes a request: root, an account (a person or an AI agent), or a runner token. A personal token is not a principal of its own; it acts for its account.

## Account

A person or an AI agent. Every account has a row in `accounts` (its role, status and who made it) and one more row with the same id: in `users` for a person, or in `agents` for an AI agent. Grants, group memberships and personal tokens belong to the account; sessions, single sign-on links and passcodes belong to people only.

## Root

The account created during first-run setup. It is a flag on the account, not a role, holds every capability, and is the way back in when everything else fails.

## Role

What an account may do on the instance (its capabilities) and how deep into project data its grants can reach (its level ceiling), plus how holders sign in and what their personal tokens may do. Roles are rows in the `roles` table. Admin, Member, Auditor, and AI agent are built in; root creates custom roles. Code never decides by a role's name.

## Capability

A power over the instance, such as `users.manage` or `audit.read_all`. The list is fixed in `app/src/services/authx.rs`; which roles hold each one is data. Some capabilities belong to root alone and no role can hold them.

## Level

How far into a project or environment an account reaches: none, metadata (names only), read, write, manage, or project manager. Each includes the ones before it.

## Grant

A level on all projects, one project, or one environment, given to a user or a group. The most specific grant wins, capped by the role's ceiling.

## Group

A named set of accounts that receives grants together. Groups are flat and never hold root.

## Protected environment

An environment that grants on its project, below project manager, don't reach.

## Personal token

A token that acts as one account, within its own scope and level, and always expires. AI agents only ever use personal tokens.

## AI agent

An account whose role signs in with tokens only, stored in `agents` and served at `/api/v1/agents`. It has a name instead of an email, an owner who is always a person, and never reaches more than its owner does.

## Workspace

A workspace groups projects that share a filesystem layout on a machine. Each linked project has a relative path inside the workspace. Workspace-scoped runner tokens can read runtime secret values for every environment whose project is linked to that workspace through `project_locations`. Projects without a workspace link are outside that token scope.

