import { computed, ref, watch, type Ref } from "vue";
import { addGroupMember } from "~/services/access.api";
import type { GroupDetail } from "~/services/access.api";
import type { User } from "~/services/users.api";
import type { Agent } from "~/services/agents.api";
import { errorMessage } from "~/services/api-errors";
import { useReauthentication } from "~/composable/reauthentication";
import { useAuthStore } from "~/stores/auth.store";

/** The group being added to: just enough to name it and skip its members. */
export interface MembersTarget {
  id: string;
  name: string;
  memberIds: string[];
}

/** A person or AI agent that could join. */
export interface MemberCandidate {
  id: string;
  /** The person's email, or the agent's name. */
  label: string;
  role: string;
}

/**
 * Add members: pick any number of people and AI agents that aren't in the
 * group yet and add them in one go, behind one password confirmation.
 * Root never joins groups and nobody adds themselves, so neither is
 * offered, and only the AI agents the server lets you add are listed.
 */
export function useAddMembersDialog(
  open: Ref<boolean>,
  target: Ref<MembersTarget | null>,
  people: Ref<User[]>,
  agents: Ref<Agent[]> = ref([]),
) {
  const { runWithReauth } = useReauthentication();
  const auth = useAuthStore();

  const filter = ref("");
  const selected = ref<Set<string>>(new Set());
  const saving = ref(false);
  const error = ref<string | null>(null);
  const saved = ref<GroupDetail | null>(null);

  /**
   * Whether the server lets you add this AI agent: anyone's with
   * agents.manage, and your own with agents.view. agents.view_all only
   * shows the others.
   */
  function addableAgent(agent: Agent): boolean {
    return (
      auth.can("agents.manage") ||
      (auth.can("agents.view") && agent.ownerId === auth.session?.adminId)
    );
  }

  const candidates = computed<MemberCandidate[]>(() => {
    const members = new Set(target.value?.memberIds ?? []);
    // Nobody adds themselves, as with giving access directly.
    const myself = auth.session?.adminId;
    return [
      ...people.value
        .filter((person) => person.role !== "root" && person.id !== myself)
        .map((person) => ({
          id: person.id,
          label: person.email,
          role: person.roleName ?? person.role,
        })),
      ...agents.value.filter(addableAgent).map((agent) => ({
        id: agent.id,
        label: agent.name,
        role: agent.roleName,
      })),
    ].filter((candidate) => !members.has(candidate.id));
  });

  const visible = computed(() => {
    const needle = filter.value.trim().toLowerCase();
    return needle
      ? candidates.value.filter((candidate) =>
          candidate.label.toLowerCase().includes(needle),
        )
      : candidates.value;
  });

  watch(
    open,
    (isOpen) => {
      if (!isOpen) return;
      filter.value = "";
      selected.value = new Set();
      error.value = null;
      saved.value = null;
    },
    { immediate: true },
  );

  function toggle(id: string, on: boolean): void {
    const next = new Set(selected.value);
    if (on) next.add(id);
    else next.delete(id);
    selected.value = next;
  }

  const submitLabel = computed(() => {
    const count = selected.value.size;
    if (count === 0) return "Add members";
    return count === 1 ? "Add 1 member" : `Add ${count} members`;
  });

  async function submit(): Promise<boolean> {
    const group = target.value;
    if (!group) return false;
    if (selected.value.size === 0) {
      error.value = "Pick at least one person.";
      return false;
    }
    saving.value = true;
    error.value = null;
    try {
      await runWithReauth(async () => {
        for (const id of selected.value) {
          saved.value = await addGroupMember(group.id, id);
        }
      });
      return true;
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") {
        return false;
      }
      error.value = errorMessage(cause, "Could not add everyone you picked.");
      return false;
    } finally {
      saving.value = false;
    }
  }

  return {
    filter,
    selected,
    candidates,
    visible,
    saving,
    error,
    saved,
    submitLabel,
    toggle,
    submit,
  };
}
