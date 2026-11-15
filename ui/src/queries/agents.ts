import { defineQueryOptions } from "@pinia/colada";
import { fetchAgent, fetchAgents } from "~/services/agents.api";
import { keys } from "./keys";

/** The AI agents the viewer may see. */
export const agentsQuery = defineQueryOptions({
  key: keys.agents.list,
  query: ({ signal }) => fetchAgents(signal),
});

/** One AI agent. */
export const agentQuery = defineQueryOptions((agentId: string) => ({
  key: keys.agents.one(agentId),
  query: ({ signal }) => fetchAgent(agentId, signal),
}));
