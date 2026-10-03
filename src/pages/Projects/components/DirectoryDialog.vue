<script setup lang="ts">
import { ref, watch } from "vue";
import { DbAlert, DbButton, DbInput, DbModal, DbSelect } from "~/components/ui";
import type { Workspace } from "~/services/workspaces.api";
const props = defineProps<{
  open: boolean; title: string; kind: "workspace" | "project";
  initialName?: string; initialPath?: string; initialWorkspaceId?: string;
  workspaces?: Workspace[];
  action: (name: string, path: string, workspaceId: string) => Promise<void>;
}>();
const emit = defineEmits<{ close: [] }>();
const name = ref(""); const path = ref(""); const workspaceId = ref("");
const saving = ref(false); const error = ref<string | null>(null);
watch(() => props.open, (open) => {
  if (!open) return;
  name.value = props.initialName ?? ""; path.value = props.initialPath ?? "";
  workspaceId.value = props.initialWorkspaceId ?? ""; error.value = null;
}, { immediate: true });
async function submit(): Promise<void> {
  saving.value = true; error.value = null;
  try { await props.action(name.value.trim(), path.value.trim(), workspaceId.value); emit("close"); }
  catch (cause) { error.value = cause instanceof Error ? cause.message : "Could not save the directory."; }
  finally { saving.value = false; }
}
</script>
<template>
  <DbModal :open="open" :title="title" :persistent="saving" @close="emit('close')">
    <form class="flex flex-col gap-4" @submit.prevent="submit">
      <DbInput v-if="kind === 'workspace'" v-model="name" label="Workspace name" placeholder="e.g. allior" :disabled="saving" autofocus />
      <DbSelect v-else v-model="workspaceId" label="Workspace" :disabled="saving" :options="[{ value: '', label: 'Unassigned' }, ...(workspaces ?? []).map(item => ({ value: item.id, label: item.name }))]" />
      <DbInput v-if="kind === 'workspace' || workspaceId" v-model="path" :label="kind === 'workspace' ? 'Root directory' : 'Project directory (relative to workspace)'" :placeholder="kind === 'workspace' ? 'D:/Programming/Allior or /home/me/projects' : 'services/api or .'" :disabled="saving" />
      <p class="text-xs text-ink-muted">{{ kind === 'workspace' ? 'The root path is on the machine where you run the CLI.' : 'The CLI selects the most specific project directory containing its current working directory.' }}</p>
      <DbAlert v-if="error" variant="error">{{ error }}</DbAlert>
      <div class="flex justify-end gap-2"><DbButton :disabled="saving" @click="emit('close')">Cancel</DbButton><DbButton type="submit" variant="primary" :loading="saving" :disabled="kind === 'workspace' ? !name || !path : !!workspaceId && !path">Save</DbButton></div>
    </form>
  </DbModal>
</template>
