import { defineQueryOptions, useQueryCache } from "@pinia/colada";
import {
  listPersonalTokens,
  type PersonalToken,
} from "~/services/personal-tokens.api";
import { listAgentTokens } from "~/services/agents.api";
import { keys } from "./keys";
import { readQuery } from "./helpers";

/**
 * One person's personal tokens; `"me"` is the viewer, whoever they are.
 * The plaintext of a new token is never part of it.
 */
export const personalTokensQuery = defineQueryOptions((userId: string) => ({
  key: keys.personalTokens.user(userId),
  query: ({ signal }) => listPersonalTokens(userId, signal),
}));

/** One AI agent's tokens, live and past. */
export const agentTokensQuery = defineQueryOptions((agentId: string) => ({
  key: keys.personalTokens.agent(agentId),
  query: ({ signal }) => listAgentTokens(agentId, signal),
}));

/**
 * The tokens of several AI agents, read through each agent's own entry so
 * the agent's page needs no new request. A list that fails is `null`.
 */
export const everyAgentTokensQuery = defineQueryOptions(
  ({
    cache,
    agentIds,
  }: {
    cache: ReturnType<typeof useQueryCache>;
    agentIds: readonly string[];
  }) => ({
    key: keys.personalTokens.agents(agentIds),
    query: async ({
      signal,
    }): Promise<Record<string, PersonalToken[] | null>> => {
      const lists = await Promise.allSettled(
        agentIds.map((id) =>
          readQuery(cache, agentTokensQuery(id), { signal }),
        ),
      );
      return Object.fromEntries(
        agentIds.map((id, index) => {
          const list = lists[index]!;
          return [id, list.status === "fulfilled" ? list.value : null];
        }),
      );
    },
  }),
);
