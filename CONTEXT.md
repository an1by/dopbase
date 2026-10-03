# Domain context

## Project

A project is one application or service. It contains one or more environments.

## Environment

An environment is a named deployment context within a project, such as development, staging, or production. It owns its secrets and environment-scoped runner tokens.

## Workspace

A workspace groups projects that share a filesystem layout on a machine. Each linked project has a relative path inside the workspace. Workspace-scoped runner tokens can read runtime secret values for every environment whose project is linked to that workspace through `project_locations`. Projects without a workspace link are outside that token scope.
