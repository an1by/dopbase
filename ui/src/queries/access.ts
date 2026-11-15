import { defineQueryOptions } from "@pinia/colada";
import {
  fetchGroup,
  fetchGroups,
  fetchProjectAccess,
  fetchUserAccess,
} from "~/services/access.api";
import { fetchAgentAccess } from "~/services/agents.api";
import { keys } from "./keys";

/** Who reaches a project, by name or id, and through which grants. */
export const projectAccessQuery = defineQueryOptions((projectRef: string) => ({
  key: keys.access.project(projectRef),
  query: ({ signal }) => fetchProjectAccess(projectRef, signal),
}));

/** One person's role cap, groups and grants; `"me"` is the viewer. */
export const userAccessQuery = defineQueryOptions((userId: string) => ({
  key: keys.access.user(userId),
  query: ({ signal }) => fetchUserAccess(userId, signal),
}));

/** One AI agent's role cap, groups and grants. */
export const agentAccessQuery = defineQueryOptions((agentId: string) => ({
  key: keys.access.agent(agentId),
  query: ({ signal }) => fetchAgentAccess(agentId, signal),
}));

/** Every group with its member count. */
export const groupsQuery = defineQueryOptions({
  key: keys.groups.list,
  query: ({ signal }) => fetchGroups(signal),
});

/** One group with its members and grants. */
export const groupQuery = defineQueryOptions((groupId: string) => ({
  key: keys.groups.one(groupId),
  query: ({ signal }) => fetchGroup(groupId, signal),
}));
